// Состояние приложения: одна сессия TrueConf, чаты, контакты, текущая конференция.
import { create } from 'zustand'
import { TCClient, type ChatMember, CHAT_TYPE, messageText, sortByTime, isSystem, type Account, type Contact, type Presence, type ServerChat, type ServerMessage } from './tc/client'
import { Conference } from './tc/conference'
import { TCRest } from './tc/rest'
import { plainText } from './ui/RichText'

export type Tab = 'chats' | 'contacts' | 'meet' | 'settings'
export type Dialog =
  | { kind: 'newChat' }
  | { kind: 'call'; topic: string; invitees: string[]; chatId?: string }
  | { kind: 'rename'; chatId: string }
  | { kind: 'deleteChat'; chatId: string; clear?: boolean }

interface State {
  client?: TCClient
  rest?: TCRest
  dialog?: Dialog
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
  // Сколько сообщений прошло фильтр уведомлений — это число на значке приложения.
  alerts: Record<string, number>
  notifyPrefs: NotifyPrefs
  setNotifyPrefs: (p: Partial<NotifyPrefs>) => void
  setChatNotify: (chatId: string, level?: NotifyLevel) => void
  levelOf: (chat: ServerChat) => NotifyLevel
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
  members: Record<string, ChatMember[]>
  showMembers: boolean

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
  startCall: (topic: string, invitees: string[], opts?: { chatId?: string; postLink?: boolean }) => Promise<void>
  createGroupChat: (title: string, members: string[]) => Promise<void>
  loadMembers: (chatId: string) => Promise<void>
  addMembers: (chatId: string, ids: string[]) => Promise<void>
  kickMember: (chatId: string, id: string) => Promise<void>
  leaveChat: (chatId: string) => Promise<void>
  pins: string[]
  togglePin: (chatId: string) => void
  renameChat: (chatId: string, title: string) => Promise<void>
  deleteChat: (chatId: string, forAll: boolean) => Promise<void>
  clearHistory: (chatId: string, forAll: boolean) => Promise<void>
  leave: () => void
  nameOf: (id: string) => string
  resolveNames: (ids: string[]) => void
  notify: (text: string) => void
}

export type NotifyLevel = 'all' | 'mentions' | 'off'
export interface NotifyPrefs { private: NotifyLevel; group: NotifyLevel; attention: boolean; preview: boolean; chats: Record<string, NotifyLevel> }

const pendingNames = new Set<string>()
// Конференции, которые мы создали для созвона и должны прибрать за собой.
const adHoc = new Set<string>()
const saved = JSON.parse(localStorage.getItem('tcx.prefs') ?? '{}')
// Созвон из чата: сервер заводит конференции отдельный чат. Запоминаем, из какого чата
// начали созвон, прячем чат конференции и переписку в звонке ведём в исходном чате.
// Удалённые личные чаты: сервер их не удаляет, прячем до нового сообщения.
const hidden = new Set<string>(JSON.parse(localStorage.getItem('tcx.hidden') ?? '[]'))
export const isHidden = (chatId: string) => hidden.has(chatId)
const confLinks: Record<string, string> = JSON.parse(localStorage.getItem('tcx.confLinks') ?? '{}')
export const linkedChatOf = (c: ServerChat) => (c.conferenceId ? confLinks[String(c.conferenceId).split('@')[0]] : undefined)
export const callChatOf = (conferenceId: string, chatId: string) => confLinks[conferenceId.split('@')[0]] ?? chatId

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
  members: {},
  showMembers: false,
  unread: {},
  alerts: {},
  notifyPrefs: { private: 'all', group: 'all', attention: true, preview: true, chats: {}, ...JSON.parse(localStorage.getItem('tcx.notify') ?? '{}') },
  setNotifyPrefs: p => {
    const notifyPrefs = { ...get().notifyPrefs, ...p }
    localStorage.setItem('tcx.notify', JSON.stringify(notifyPrefs))
    set({ notifyPrefs })
  },
  setChatNotify: (chatId, level) => {
    const chats = { ...get().notifyPrefs.chats }
    if (level) chats[chatId] = level; else delete chats[chatId]
    get().setNotifyPrefs({ chats })
  },
  levelOf: chat => get().notifyPrefs.chats[chat.chatId] ?? (chat.chatType === CHAT_TYPE.P2P ? get().notifyPrefs.private : get().notifyPrefs.group),
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
      // REST нужен для созвонов; без него чаты работают, поэтому ошибку не показываем.
      const rest = new TCRest(host)
      rest.login(login, password).then(() => set({ rest }), e => console.warn('OAuth', e))
      wireClient(client)
      client.requestContacts()
      const chats = await client.chatList()
      set({ chats: sortChats(chats.filter(c => !hidden.has(c.chatId))) })
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
    set({ client: undefined, rest: undefined, dialog: undefined, account: undefined, chats: [], messages: {}, contacts: [], activeChatId: undefined, conference: undefined })
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

  leave: () => {
    const conf = get().conference
    conf?.hangup()
    set({ conference: undefined })
    // Свою разовую конференцию убираем, если в ней никого не осталось.
    if (conf && adHoc.has(conf.conferenceId) && [...conf.participants.keys()].every(id => id.split('/')[0] === get().account?.trueconfId)) {
      adHoc.delete(conf.conferenceId)
      // Сразу после выхода сервер ещё считает конференцию идущей и не даёт её удалить.
      const rest = get().rest, id = conf.conferenceId
      if (rest) setTimeout(async () => {
        await rest.req('POST', `/api/v4/conferences/${id}/stop`).catch(() => {})
        await rest.remove(id).catch(() => new Promise(r => setTimeout(r, 3000)).then(() => rest.remove(id)).catch(() => {}))
      }, 1500)
      // Сервер заводит конференции групповой чат — пустой тоже убираем.
      if (conf.chatId) {
        get().client?.removeChat(conf.chatId).catch(() => {})
        set({ chats: get().chats.filter(c => c.chatId !== conf.chatId) })
      }
    }
  },

  loadMembers: async chatId => {
    const { client } = get()
    if (!client) return
    const list = await client.members(chatId).catch(() => null)
    if (!list) return
    set({ members: { ...get().members, [chatId]: list } })
    get().resolveNames(list.map(m => m.id))
    client.subscribePresence(list.map(m => m.id))
  },

  addMembers: async (chatId, ids) => {
    const { client } = get()
    for (const id of ids) await client?.addParticipant(chatId, id).catch(e => get().notify(`${get().nameOf(id)}: ${e.message}`))
    await get().loadMembers(chatId)
  },

  kickMember: async (chatId, id) => {
    await get().client?.kick(chatId, id).catch(e => get().notify(`Не удалось убрать: ${e.message}`))
    await get().loadMembers(chatId)
  },

  // Закрепление только локальное: в протоколе TrueConf его нет.
  pins: JSON.parse(localStorage.getItem('tcx.pins') ?? '[]'),
  togglePin: chatId => {
    const pins = get().pins.includes(chatId) ? get().pins.filter(id => id !== chatId) : [chatId, ...get().pins]
    localStorage.setItem('tcx.pins', JSON.stringify(pins))
    set({ pins })
  },
  renameChat: async (chatId, title) => {
    await get().client?.renameChat(chatId, title).then(
      () => set({ chats: get().chats.map(c => (c.chatId === chatId ? { ...c, title } : c)) }),
      e => get().notify(`Не удалось переименовать: ${e.message}`))
  },
  // Сервер 5.5 игнорирует флаг removeChat у CLEAR_CHAT_HISTORY, поэтому как в Telegram:
  // группу у всех — REMOVE_CHAT, у себя — очистить и выйти; личный — очистить и скрыть до нового сообщения.
  deleteChat: async (chatId, forAll) => {
    const client = get().client, chat = get().chats.find(c => c.chatId === chatId)
    if (!client || !chat) return
    const run = chat.chatType === CHAT_TYPE.GROUP
      ? (forAll ? client.removeChat(chatId) : client.clearHistory(chatId, false).then(() => client.leaveChat(chatId)))
      : client.clearHistory(chatId, forAll).then(() => { hidden.add(chatId); localStorage.setItem('tcx.hidden', JSON.stringify([...hidden])) })
    await run.then(() => {
      const { messages, unread } = get()
      set({ chats: get().chats.filter(c => c.chatId !== chatId), messages: { ...messages, [chatId]: [] }, unread: { ...unread, [chatId]: 0 },
        activeChatId: get().activeChatId === chatId ? undefined : get().activeChatId, showMembers: false })
      if (get().pins.includes(chatId)) get().togglePin(chatId)
    }, e => get().notify(`Не удалось удалить: ${e.message}`))
  },
  clearHistory: async (chatId, forAll) => {
    await get().client?.clearHistory(chatId, forAll).then(
      () => set({ messages: { ...get().messages, [chatId]: [] } }),
      e => get().notify(`Не удалось очистить: ${e.message}`))
  },

  leaveChat: async chatId => {
    await get().client?.leaveChat(chatId).then(() => {
      set({ chats: get().chats.filter(c => c.chatId !== chatId), activeChatId: undefined, showMembers: false })
    }, e => get().notify(`Не удалось выйти: ${e.message}`))
  },

  startCall: async (topic, invitees, opts = {}) => {
    const { rest, account, client } = get()
    if (!rest?.ready || !account || !client) { get().notify('Созвон недоступен: сервер не выдал доступ к API'); return }
    if (get().conference) { get().notify('Сначала выйдите из текущей конференции'); return }
    set({ dialog: undefined })
    try {
      const conf = await rest.createMeeting(topic, invitees, account.trueconfId)
      adHoc.add(conf.id)
      if (opts.chatId) { confLinks[conf.id] = opts.chatId; localStorage.setItem('tcx.confLinks', JSON.stringify(confLinks)) }
      if (opts.postLink && opts.chatId) {
        const chat = get().chats.find(c => c.chatId === opts.chatId)
        if (chat) client.sendText({ chatId: chat.chatId, chatType: chat.chatType, peer: peerOf(chat, account.trueconfId) }, `Созвон «${topic}»: ${conf.url}`).catch(() => {})
      }
      await get().join(conf.id)
      // Звоним приглашённым, когда сами уже в конференции.
      const c = get().conference
      if (c) for (const id of invitees) if (id !== account.trueconfId) c.invite(id)
    } catch (e: any) {
      get().notify(`Не удалось начать созвон: ${e.message}`)
    }
  },

  createGroupChat: async (title, members) => {
    const { client } = get()
    if (!client) return
    set({ dialog: undefined })
    try {
      const created = await client.createGroup(title)
      for (const id of members) await client.addParticipant(created.chatId, id).catch(e => get().notify(`${get().nameOf(id)}: ${e.message}`))
      const chat: ServerChat = { chatType: CHAT_TYPE.GROUP, title, ...created }
      set({ chats: sortChats([chat, ...get().chats.filter(c => c.chatId !== chat.chatId)]) })
      // История нужна сразу: в ней служебные «… добавлен в чат».
      await get().openChat(chat.chatId)
    } catch (e: any) {
      get().notify(`Не удалось создать чат: ${e.message}`)
    }
  },
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
    // Чат переименовали — подтягиваем новое название.
    // chatInfo отдаёт старое название, новое есть только в самом системном сообщении.
    if (m.type === 103 && m.content?.title) st.setState({ chats: st.getState().chats.map(c => (c.chatId === m.chatId ? { ...c, title: m.content.title } : c)) })
    if (hidden.delete(m.chatId)) {
      localStorage.setItem('tcx.hidden', JSON.stringify([...hidden]))
      if (!st.getState().chats.some(c => c.chatId === m.chatId)) { const info = await client.chatInfo(m.chatId).catch(() => null); if (info?.chatId) st.setState({ chats: sortChats([info, ...st.getState().chats]) }) }
    }
    pushMessage(m)
    s.resolveNames([m.sender])
    const mine = m.sender === s.account?.trueconfId
    const chat = st.getState().chats.find(c => c.chatId === m.chatId)
    if (mine || isSystem(m) || (chat && linkedChatOf(chat))) return
    if (s.activeChatId === m.chatId && s.tab === 'chats' && document.hasFocus()) client.markRead(m.chatId, m.messageId)
    else {
      st.setState({ unread: { ...st.getState().unread, [m.chatId]: (st.getState().unread[m.chatId] ?? 0) + 1 } })
      // Как в Telegram: у чата уровень «все», «только упоминания» или «без уведомлений».
      const level = chat ? s.levelOf(chat) : 'all'
      const mentioned = messageText(m).includes(`trueconf:${s.account?.trueconfId}`)
      if (level === 'off' || (level === 'mentions' && !mentioned)) return
      st.setState({ alerts: { ...st.getState().alerts, [m.chatId]: (st.getState().alerts[m.chatId] ?? 0) + 1 } })
      const who = s.nameOf(m.sender)
      const title = chat && chat.chatType !== CHAT_TYPE.P2P ? `${chat.title}` : who
      const text = !s.notifyPrefs.preview ? 'Новое сообщение' : `${chat && chat.chatType !== CHAT_TYPE.P2P ? `${who.split(' ').slice(0, 2).join(' ')}: ` : ''}${plainText(messageText(m)) || 'Файл'}`
      window.native?.notify(title, text, { chatId: m.chatId })
      if (s.notifyPrefs.attention) window.native?.attention?.()
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
;(window as any).__tcx = Object.assign(useStore, { TCClient, Conference })

// Прочитанный чат больше не считается на значке; число на значке — сумма по чатам.
let lastBadge = -1
useStore.subscribe(s => {
  let changed = false
  const alerts = { ...s.alerts }
  for (const id of Object.keys(alerts)) if (!s.unread[id]) { delete alerts[id]; changed = true }
  if (changed) { useStore.setState({ alerts }); return }
  const total = Object.values(s.alerts).reduce((a, b) => a + b, 0)
  if (total !== lastBadge) { lastBadge = total; window.native?.setBadge?.(total) }
})
window.native?.onOpenChat?.(id => useStore.getState().openChat(id))

// Вернулись в окно с открытым чатом — он прочитан.
window.addEventListener('focus', () => {
  const s = useStore.getState()
  const id = s.activeChatId
  if (!id || s.tab !== 'chats' || !s.unread[id]) return
  const last = s.messages[id]?.at(-1)
  if (last) s.client?.markRead(id, last.messageId)
  useStore.setState({ unread: { ...s.unread, [id]: 0 } })
})
