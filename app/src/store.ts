// Состояние приложения: одна сессия TrueConf, чаты, контакты, текущая конференция.
import { create } from 'zustand'
import { TCClient, CHAT_TYPE, messageText, sortByTime, isSystem, type Account, type Contact, type Presence, type ServerChat, type ServerMessage } from './tc/client'
import { Conference } from './tc/conference'
import { plainText } from './ui/RichText'

export type Tab = 'chats' | 'contacts' | 'meet' | 'settings'

interface State {
  client?: TCClient
  account?: Account
  server: string
  lastLogin: string
  connecting: boolean
  error?: string
  tab: Tab
  chats: ServerChat[]
  activeChatId?: string
  messages: Record<string, ServerMessage[]>
  unread: Record<string, number>
  contacts: Contact[]
  presence: Record<string, Presence>
  names: Record<string, string>
  conference?: Conference
  theme: 'dark' | 'light'
  devices: { audioIn?: string; videoIn?: string; audioOut?: string }
  joinAudio: boolean
  joinVideo: boolean
  toast?: string
  replyTo?: ServerMessage
  editing?: ServerMessage
  forwarding?: ServerMessage
  draft: Record<string, string>
  quotes: Record<string, ServerMessage | null>

  set: (p: Partial<State>) => void
  login: (server: string, login: string, password: string, remember: boolean) => Promise<void>
  logout: () => void
  openChat: (chatId: string) => Promise<void>
  openP2P: (callId: string) => Promise<void>
  loadOlder: (chatId: string) => Promise<void>
  send: (text: string) => Promise<void>
  removeMessage: (m: ServerMessage) => Promise<void>
  forwardTo: (chatId: string) => Promise<void>
  quoted: (chatId: string, messageId: string) => ServerMessage | null | undefined
  join: (confId: string, password?: string) => Promise<void>
  leave: () => void
  nameOf: (id: string) => string
  resolveNames: (ids: string[]) => void
  notify: (text: string) => void
}

const pendingNames = new Set<string>()
const saved = JSON.parse(localStorage.getItem('tcx.prefs') ?? '{}')

export const useStore = create<State>((set, get) => ({
  // Сервер вводят при первом входе, дальше он хранится в настройках.
  server: saved.server ?? '',
  lastLogin: saved.lastLogin ?? '',
  connecting: false,
  tab: 'chats',
  chats: [],
  messages: {},
  draft: {},
  quotes: {},
  unread: {},
  contacts: [],
  presence: {},
  names: JSON.parse(localStorage.getItem('tcx.names') ?? '{}'),
  theme: saved.theme ?? 'dark',
  devices: saved.devices ?? {},
  joinAudio: saved.joinAudio ?? true,
  joinVideo: saved.joinVideo ?? false,

  set: p => {
    set(p)
    const s = get()
    localStorage.setItem('tcx.prefs', JSON.stringify({ server: s.server, lastLogin: s.lastLogin, theme: s.theme, devices: s.devices, joinAudio: s.joinAudio, joinVideo: s.joinVideo }))
  },

  nameOf: id => {
    const s = get()
    if (id === s.account?.trueconfId) return s.account.displayName || 'Вы'
    return s.names[id] ?? s.contacts.find(c => c.callId === id)?.displayName ?? id.split('@')[0]
  },

  // Имена отправителей, которых нет в контактах, спрашиваем у сервера и кэшируем.
  resolveNames: ids => {
    const { client, names } = get()
    if (!client) return
    for (const id of new Set(ids)) {
      if (!id || names[id] || pendingNames.has(id) || id === get().account?.trueconfId) continue
      pendingNames.add(id)
      client.userDetails(id).then(d => {
        if (!d?.displayName) return
        const next = { ...get().names, [id]: d.displayName }
        set({ names: next })
        localStorage.setItem('tcx.names', JSON.stringify(next))
      }).finally(() => pendingNames.delete(id))
    }
  },

  notify: text => { set({ toast: text }); setTimeout(() => get().toast === text && set({ toast: undefined }), 4000) },

  login: async (rawServer, login, password, remember) => {
    const server = normalizeServer(rawServer)
    if (!server) { set({ error: 'Укажите адрес сервера' }); return }
    set({ connecting: true, error: undefined })
    const [host, port] = server.split(':')
    const client = new TCClient(host, Number(port) || 443)
    try {
      const account = await client.login(login.includes('@') ? login : `${login}@${host}`, password)
      get().set({ server, lastLogin: login })
      if (remember) await window.native?.saveCredentials?.(server, login, password)
      set({ client, account, connecting: false })
      wireClient(client)
      client.requestContacts()
      const chats = await client.chatList()
      set({ chats: sortChats(chats) })
      get().resolveNames(chats.flatMap(c => [c.lastVisibleMessage?.sender ?? '', c.chatType === CHAT_TYPE.P2P ? peerOf(c, account.trueconfId) ?? '' : '']))
      const link = await window.native?.takeLink?.()
      if (link) handleLink(link)
    } catch (e: any) {
      set({ connecting: false, error: e.message })
      client.logout()
    }
  },

  logout: () => {
    get().conference?.hangup()
    get().client?.logout()
    window.native?.saveCredentials?.('', '', '')
    set({ client: undefined, account: undefined, chats: [], messages: {}, contacts: [], activeChatId: undefined, conference: undefined })
  },

  openChat: async chatId => {
    const { client, messages } = get()
    set({ activeChatId: chatId, tab: 'chats', replyTo: undefined, editing: undefined, unread: { ...get().unread, [chatId]: 0 } })
    if (!client) return
    if (!messages[chatId]) {
      const list = await client.history(chatId, 60)
      set({ messages: { ...get().messages, [chatId]: list } })
      get().resolveNames(list.map(m => m.sender))
    }
    const last = get().messages[chatId]?.at(-1)
    if (last) client.markRead(chatId, last.messageId)
  },

  openP2P: async callId => {
    const { client } = get()
    if (!client) return
    const existing = get().chats.find(c => c.chatType === CHAT_TYPE.P2P && peerOf(c, get().account?.trueconfId) === callId)
    if (existing) return get().openChat(existing.chatId)
    const p = await client.p2pChat(callId)
    const chat: ServerChat = { chatType: CHAT_TYPE.P2P, title: get().nameOf(callId), ...p, peer: callId }
    set({ chats: sortChats([chat, ...get().chats.filter(c => c.chatId !== chat.chatId)]) })
    return get().openChat(chat.chatId)
  },

  loadOlder: async chatId => {
    const { client, messages } = get()
    const first = messages[chatId]?.[0]
    if (!client || !first) return
    const older = await client.history(chatId, 60, first.messageId)
    get().resolveNames(older.map(m => m.sender))
    const known = new Set(messages[chatId].map(m => m.messageId))
    set({ messages: { ...get().messages, [chatId]: sortByTime([...older.filter(m => !known.has(m.messageId)), ...get().messages[chatId]]) } })
  },

  send: async text => {
    const { client, activeChatId, chats, account, replyTo, editing } = get()
    const chat = chats.find(c => c.chatId === activeChatId)
    if (!client || !chat) return
    set({ replyTo: undefined, editing: undefined })
    if (editing) {
      await client.editText(chat.chatId, editing.messageId, text).catch(e => get().notify(`Не удалось изменить: ${e.message}`))
      patchMessage(chat.chatId, editing.messageId, { content: { ...editing.content, content: text }, edited: true } as any)
      return
    }
    const msg = await client.sendText({ chatId: chat.chatId, chatType: chat.chatType, peer: peerOf(chat, account?.trueconfId) }, text, replyTo?.messageId)
    addSent(chat.chatId, text, { replyMessageId: replyTo?.messageId, ...msg })
  },

  removeMessage: async m => {
    const { client } = get()
    if (!client) return
    await client.removeMessage(m.chatId, m.messageId, true).then(
      () => set({ messages: { ...get().messages, [m.chatId]: (get().messages[m.chatId] ?? []).filter(x => x.messageId !== m.messageId) } }),
      e => get().notify(`Не удалось удалить: ${e.message}`))
  },

  forwardTo: async chatId => {
    const { client, forwarding } = get()
    if (!client || !forwarding) return
    set({ forwarding: undefined })
    const msg = await client.forward(chatId, forwarding.messageId).catch(e => { get().notify(`Не удалось переслать: ${e.message}`); return null })
    if (msg?.messageId) pushMessage({ ...forwarding, ...msg, chatId, sender: get().account!.trueconfId, timestamp: Date.now(), forwardMessage: { from: forwarding.sender, messageId: forwarding.messageId } } as ServerMessage)
    get().notify('Сообщение переслано')
    get().openChat(chatId)
  },

  // Оригинал для цитаты: из загруженной истории, иначе спрашиваем сервер и кэшируем.
  quoted: (chatId, messageId) => {
    const local = get().messages[chatId]?.find(m => m.messageId === messageId)
    if (local) return local
    const q = get().quotes
    if (messageId in q) return q[messageId]
    set({ quotes: { ...q, [messageId]: null } })
    get().client?.messageInfo(messageId).then(m => {
      set({ quotes: { ...get().quotes, [messageId]: m } })
      get().resolveNames([m.sender])
    }).catch(() => {})
    return undefined
  },

  join: async (confId, password) => {
    const { client, joinAudio, joinVideo, devices } = get()
    if (!client || get().conference) return
    const conf = new Conference(client, confId.trim(), password)
    set({ conference: conf, tab: 'meet' })
    conf.on('state', (s, reason) => {
      if (s === 'ended') { set({ conference: undefined }); if (reason) get().notify(reason) }
      else set({ conference: conf })
    })
    try {
      await conf.join({ audio: joinAudio, video: joinVideo, audioDeviceId: devices.audioIn, videoDeviceId: devices.videoIn })
    } catch (e: any) {
      set({ conference: undefined })
      get().notify(e.message)
    }
  },

  leave: () => { get().conference?.hangup(); set({ conference: undefined }) },
}))

// «https://tc.example.com/c/123» → «tc.example.com»; порт сохраняем.
export function normalizeServer(input: string) {
  return input.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase()
}

export function peerOf(chat: ServerChat, me?: string): string | undefined {
  if (chat.chatType !== CHAT_TYPE.P2P) return undefined
  if (chat.peer) return chat.peer
  const ids: string[] = (chat.participants ?? chat.members ?? []).map((p: any) => (typeof p === 'string' ? p : p.userId ?? p.id ?? p.callId))
  return ids.find(id => id && id !== me) ?? chat.callId ?? chat.title
}

function chatTime(c: ServerChat) { return c.lastVisibleMessage?.timestamp ?? c.draftUpdateTimestamp ?? 0 }
function sortChats(list: ServerChat[]) { return [...list].sort((a, b) => chatTime(b) - chatTime(a)) }

function patchMessage(chatId: string, messageId: string, patch: Partial<ServerMessage>) {
  const s = useStore.getState()
  const list = s.messages[chatId]
  if (list) useStore.setState({ messages: { ...s.messages, [chatId]: list.map(m => (m.messageId === messageId ? { ...m, ...patch } : m)) } })
}

// Своё сообщение показываем сразу; сервер вернёт его id и время.
export function addSent(chatId: string, text: string, m: Partial<ServerMessage> | null) {
  if (!m?.messageId) return
  const me = useStore.getState().account!.trueconfId
  pushMessage({ chatId, sender: me, timestamp: Date.now() / 1000, type: 200, content: { content: text }, ...m, messageId: m.messageId })
}

function pushMessage(m: ServerMessage) {
  const s = useStore.getState()
  const list = s.messages[m.chatId]
  const next = list ? (list.some(x => x.messageId === m.messageId) ? list : [...list, m]) : undefined
  let chats = s.chats
  const idx = chats.findIndex(c => c.chatId === m.chatId)
  if (idx >= 0) chats = sortChats(chats.map((c, i) => (i === idx ? { ...c, lastVisibleMessage: m } : c)))
  useStore.setState({ chats, ...(next ? { messages: { ...s.messages, [m.chatId]: next } } : {}) })
}

function wireClient(client: TCClient) {
  const st = useStore
  client.on('message', async m => {
    if (!m?.chatId) return
    // Служебная синхронизация (типы 400+, skip_unread_count) — не сообщение для человека.
    if (m.type >= 400 || m.content?.skip_unread_count) return
    const s = st.getState()
    if (!s.chats.some(c => c.chatId === m.chatId)) {
      const info = await client.chatInfo(m.chatId).catch(() => null)
      // Чат, к которому нет доступа (ошибка Permission not found), не показываем и не считаем.
      if (!info?.chatId) return
      st.setState({ chats: sortChats([info, ...st.getState().chats]) })
    }
    pushMessage(m)
    s.resolveNames([m.sender])
    const mine = m.sender === s.account?.trueconfId
    if (mine || isSystem(m)) return
    if (s.activeChatId === m.chatId && s.tab === 'chats' && document.hasFocus()) client.markRead(m.chatId, m.messageId)
    else {
      st.setState({ unread: { ...st.getState().unread, [m.chatId]: (st.getState().unread[m.chatId] ?? 0) + 1 } })
      window.native?.notify(s.nameOf(m.sender), plainText(messageText(m)))
    }
  })
  client.on('messageEdited', m => {
    const s = st.getState()
    const list = s.messages[m.chatId]
    if (!list) return
    const orig = (m as any).originalMessageId ?? m.messageId
    st.setState({ messages: { ...s.messages, [m.chatId]: list.map(x => (x.messageId === orig ? { ...x, ...m, messageId: orig, edited: true } as any : x)) } })
  })
  client.on('chatCreated', c => { if (c?.chatId) st.setState({ chats: sortChats([c, ...st.getState().chats.filter(x => x.chatId !== c.chatId)]) }) })
  client.on('contacts', list => {
    const names = { ...st.getState().names }
    for (const c of list) names[c.callId] = c.displayName
    const byId = new Map(st.getState().contacts.map(c => [c.callId, c]))
    for (const c of list) byId.set(c.callId, c)
    st.setState({ contacts: [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru')), names })
    client.subscribePresence(list.map(c => c.callId))
  })
  client.on('presence', (id, p) => st.setState({ presence: { ...st.getState().presence, [id]: p } }))
  client.on('loggedOut', cause => { st.getState().notify(cause === 1 ? 'Вы вошли с другого устройства' : 'Сессия завершена'); st.getState().logout() })
  client.on('closed', () => { if (st.getState().client === client) { st.getState().notify('Соединение потеряно'); st.setState({ client: undefined, account: undefined }) } })
}

// trueconf:\c\<id>&h=host ; https://host/c/<id> ; голый id
export function parseConfLink(link: string): string | undefined {
  const s = decodeURIComponent(link)
  return s.match(/\\c\\([^&\s/]+)/)?.[1] ?? s.match(/\/c\/([^/?#\s]+)/)?.[1] ?? s.match(/\/webrtc\/([^/?#\s]+)/)?.[1] ?? (/^[\w-]+$/.test(s.trim()) ? s.trim() : undefined)
}

function handleLink(link: string) {
  const id = parseConfLink(link)
  if (id) useStore.getState().join(id)
}
window.native?.onDeepLink?.(handleLink)

// Для отладки из DevTools: __tcx.getState()
;(window as any).__tcx = useStore

// Вернулись в окно с открытым чатом — он прочитан.
window.addEventListener('focus', () => {
  const s = useStore.getState()
  const id = s.activeChatId
  if (!id || s.tab !== 'chats' || !s.unread[id]) return
  const last = s.messages[id]?.at(-1)
  if (last) s.client?.markRead(id, last.messageId)
  useStore.setState({ unread: { ...s.unread, [id]: 0 } })
})
