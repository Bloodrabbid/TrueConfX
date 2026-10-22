// Клиент TrueConf Server поверх сигнального WebSocket: вход, чаты, контакты, присутствие.
// Протокол восстановлен по веб-клиенту сервера 5.5 (/webrtc), см. docs/PROTOCOL.md.
import { TCSocket, type Frame } from './socket'
import { md5 } from './md5'

export const AUTH = { JWT: 0, RAW: 2, TOKEN: 3, MD5: 4 } as const

export const LOGIN_ERRORS: Record<number, string> = {
  [-1]: 'Неизвестная ошибка', 1: 'Пользователь уже вошёл', 3: 'Неверный логин или пароль',
  5: 'Превышен лимит лицензий', 6: 'Учётная запись отключена', 10: 'Учётная запись заблокирована',
  12: 'Логин неоднозначен', 65213: 'Срок действия пароля истёк',
}

// Коды ChatV2.messageType
export const CHAT = {
  LIST: 0, INFO: 1, PARTICIPANTS: 2, HISTORY: 6, CREATE_GROUP: 7, CREATE_P2P: 8, EDIT_CHAT: 9, LEAVE: 10,
  ADD_PART: 11, KICK_PART: 12, SEND_GROUP: 13, SEND_P2P: 14, REMOVE_MSG: 15, EDIT_MSG: 16, FORWARD: 17,
  CLEAR_HISTORY: 18, REMOVE_CHAT: 19, AVATAR: 23, MESSAGE_INFO: 24, ACTIVITY: 25, DRAFT: 26, READ: 27,
} as const
export const CHAT_EVENT = { RECEIVE: 0, EDIT: 1, CREATE_CHAT: 2, ACTIVITY: 4, READ: 6 } as const
export const CHAT_TYPE = { P2P: 1, GROUP: 2, SYSTEM: 3, MISSED_CALLS: 4, FAVORITES: 5 } as const
export const MSG = { TEXT: 200, FILE: 201, LOCATION: 203, WEB_APP: 204 } as const

export type Presence = 'online' | 'away' | 'busy' | 'dnd' | 'offline'

export interface ServerMessage {
  messageId: string
  chatId: string
  sender: string
  timestamp: number
  type: number
  isRead?: boolean
  parentMessageId?: string
  replyMessageId?: string
  forwardMessage?: { from: string; chatTitle?: string; chatId?: string; chatType?: number; messageId: string }
  content?: any
}
export interface ServerChat {
  chatId: string
  chatType: number
  title: string
  avatarUrl?: string
  isChannel?: boolean
  notification?: any
  lastVisibleMessage?: ServerMessage
  unreadMessages?: number
  [k: string]: any
}
export interface FileEntry { name: string; fileId: string; size: number; mimeType: string; readyState: number; downloadUrl: string; previews?: { downloadUrl: string; mimeType: string }[] }
export interface ChatMember { id: string; role: 'owner' | 'admin' | 'user' | string }
export interface Contact { callId: string; displayName: string; [k: string]: any }
export interface Account { trueconfId: string; instance: string; displayName: string; cid: string; rights: number; session: string; key?: string }

type Events = {
  closed: () => void
  message: (m: ServerMessage) => void
  messageEdited: (m: ServerMessage) => void
  messageRead: (e: any) => void
  chatCreated: (c: any) => void
  typing: (e: any) => void
  contacts: (list: Contact[]) => void
  presence: (callId: string, p: Presence, raw: any) => void
  loggedOut: (cause: number) => void
  frame: (f: Frame) => void
}

export class TCClient {
  sock: TCSocket
  account?: Account
  protocolVersion = 0
  private sn = 1
  private listeners: { [K in keyof Events]?: Set<Events[K]> } = {}

  constructor(public host: string, public port = 443) {
    this.sock = new TCSocket(`wss://${host}:${port}/websocket/`)
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]) {
    ;(this.listeners[ev] ??= new Set() as any).add(fn)
    return () => this.listeners[ev]!.delete(fn as any)
  }
  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>) {
    this.listeners[ev]?.forEach(fn => (fn as any)(...args))
  }

  get cid() { return this.account?.cid ?? '' }

  // ── Вход ──────────────────────────────────────────────────────────────
  async login(login: string, secret: string, type: number = AUTH.RAW, appId = TCClient.appId()): Promise<Account> {
    await this.sock.open()
    this.wire()
    const pong = await this.sock.request({ method: 'ping' }, 'pong')
    this.protocolVersion = Number(pong.version)
    const r = await this.sock.request({
      method: 'loginUser', AppID: appId, login,
      credentials: type === AUTH.MD5 ? md5(secret) : secret, credentialsType: type,
      chatV2Enabled: true, browser: navigator.userAgent,
      appLang: 'ru', appVersion: '5.1.0', appName: 'TrueConf WebClient',
    }, 'loginResponse')
    if (r.result !== 0) {
      this.sock.close()
      throw Object.assign(new Error(LOGIN_ERRORS[r.result] ?? `Вход отклонён (код ${r.result})`), { code: r.result })
    }
    // trueconfId приходит с суффиксом экземпляра: user@host/5b3fe416. В чатах sender без суффикса.
    this.account = { trueconfId: String(r.trueconfId).split('/')[0], instance: r.trueconfId, displayName: r.displayName, cid: r.CID, rights: r.Rights, session: r.Session, key: r.Key }
    this.sock.send({ method: 'clientInfo', appVersion: '5.1.0', device: 'desktop', hardware: navigator.platform, platform: navigator.platform, runtime: 'TrueConfX' })
    return this.account
  }

  static appId() {
    const k = 'tcx.appId'
    let id = globalThis.localStorage?.getItem(k)
    if (!id) {
      id = md5(navigator.userAgent + Date.now() + Math.random()).toUpperCase()
      globalThis.localStorage?.setItem(k, id)
    }
    return id
  }

  logout() {
    if (this.sock.isOpen) this.sock.send({ method: 'logoutUser', CID: this.cid })
    this.sock.close()
  }

  private wire() {
    const s = this.sock
    s.onAny(f => this.emit('frame', f))
    s.on('_closed', () => this.emit('closed'))
    s.on('logoutResponse', f => this.emit('loggedOut', f.cause))
    s.on('chatV2', f => {
      if (f.containerType !== 3) return
      const ev = f.eventType ?? f.payload?.eventType
      const body = f.event ?? f.payload?.event ?? f.payload
      if (ev === CHAT_EVENT.RECEIVE) this.emit('message', body)
      else if (ev === CHAT_EVENT.EDIT) this.emit('messageEdited', body)
      else if (ev === CHAT_EVENT.READ) this.emit('messageRead', body)
      else if (ev === CHAT_EVENT.CREATE_CHAT) this.emit('chatCreated', body)
      else if (ev === CHAT_EVENT.ACTIVITY) this.emit('typing', body)
    })
    for (const m of ['contactListUpdated', 'contactsAdded', 'contactsRemoved'])
      s.on(m, f => this.emit('contacts', (f.contacts ?? []).map(toContact).filter((c: Contact) => c.callId)))
    s.on('contactsStatusUpdate', f => {
      for (const c of f.contacts ?? []) this.emit('presence', c.callId, presenceOf(c), c)
    })
  }

  // ── ChatV2 ────────────────────────────────────────────────────────────
  chat(messageType: number, payload: any, timeoutMs = 20000): Promise<any> {
    const sn = this.sn++
    return this.sock.request(
      { method: 'ChatV2', sn, containerType: 0, messageType, payload },
      'chatV2', f => f.sn === sn && f.containerType !== 3, timeoutMs,
    ).then(f => {
      const p = f.payload ?? {}
      if (f.containerType === 2 || 'error' in p || 'errorCode' in p) throw new Error(`Ошибка чата: ${JSON.stringify(p).slice(0, 200)}`)
      return p
    })
  }

  async chatList(pageSize = 1024, pageNum = 1): Promise<ServerChat[]> {
    const p = await this.chat(CHAT.LIST, { pageSize, pageNum })
    return (p.list ?? []).filter((c: ServerChat) => c.chatType !== 0)
  }
  // История в хронологическом порядке (сортируем сами, не полагаясь на порядок сервера).
  async history(chatId: string, count = 50, beforeMessageId?: string): Promise<ServerMessage[]> {
    const p = await this.chat(CHAT.HISTORY, { chatId, count, type: 0, messageId: beforeMessageId })
    return sortByTime(p.list ?? [])
  }
  p2pChat(callId: string) { return this.chat(CHAT.CREATE_P2P, { callId }) }
  createGroup(title: string) { return this.chat(CHAT.CREATE_GROUP, { title, isChannel: false }) }
  addParticipant(chatId: string, callId: string) { return this.chat(CHAT.ADD_PART, { chatId, callId }) }
  removeChat(chatId: string) { return this.chat(CHAT.REMOVE_CHAT, { chatId }) }
  // Переименовать группу. Аватар меняется тем же запросом через avatarTemporalFileId.
  renameChat(chatId: string, title: string) { return this.chat(9, { chatId, title }) }
  clearHistory(chatId: string, forAll: boolean) { return this.chat(18, { chatId, forAll }) }
  chatInfo(chatId: string) { return this.chat(CHAT.INFO, { chatId }) }
  // Участники чата: [{ name: 'user@host', type, role: 'owner' | 'admin' | 'user' }]
  async members(chatId: string): Promise<ChatMember[]> {
    const p = await this.chat(CHAT.PARTICIPANTS, { chatId, pageNum: 1, count: 1000 })
    return (p.list ?? []).map((x: any) => ({ id: x.name ?? x.callId, role: x.role ?? 'user' })).filter((m: ChatMember) => m.id)
  }
  async participants(chatId: string): Promise<string[]> { return (await this.members(chatId)).map(m => m.id) }
  kick(chatId: string, callId: string) { return this.chat(CHAT.KICK_PART, { chatId, callId, clearChat: false }) }
  leaveChat(chatId: string) { return this.chat(CHAT.LEAVE, { chatId }) }

  sendText(chat: { chatId: string; chatType: number; peer?: string }, text: string, replyMessageId?: string): Promise<Partial<ServerMessage>> {
    const base = { chatId: chat.chatId, type: MSG.TEXT, replyMessageId, content: { text } }
    return chat.chatType === CHAT_TYPE.P2P && chat.peer
      ? this.chat(CHAT.SEND_P2P, { ...base, to: chat.peer })
      : this.chat(CHAT.SEND_GROUP, base)
  }
  // Вложение: WS выдаёт uploadTaskId, файл уходит POST'ом на /bridge/api/client/v1/files,
  // сервер возвращает temporalFileId, и его шлём сообщением типа FILE.
  async uploadFile(file: File, preview?: Blob, onProgress?: (part: number) => void): Promise<string> {
    const requestId = crypto.randomUUID()
    const task = await this.sock.request({ method: 'createUploadTask', requestId, fileSize: file.size, fileName: file.name }, 'createUploadTask', f => f.requestId === requestId, 20000)
    if (!task.uploadTaskId) throw new Error(task.errorText ?? 'Сервер не принял файл')
    const form = new FormData()
    form.append('file', file, file.name)
    if (preview) form.append('preview', preview, crypto.randomUUID())
    const body = await new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `https://${this.host}:${this.port}/bridge/api/client/v1/files`)
      xhr.setRequestHeader('Upload-Task-Id', task.uploadTaskId)
      xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => (xhr.status < 300 ? resolve(xhr.responseText) : reject(new Error(`Загрузка не удалась: HTTP ${xhr.status}`)))
      xhr.onerror = () => reject(new Error('Загрузка не удалась: нет связи с сервером'))
      xhr.send(form)
    })
    const id = JSON.parse(body).temporalFileId
    if (!id) throw new Error('Сервер не вернул id файла')
    return id
  }
  sendFile(chat: { chatId: string; chatType: number; peer?: string }, fileId: string, replyMessageId?: string): Promise<Partial<ServerMessage>> {
    const base = { chatId: chat.chatId, type: MSG.FILE, replyMessageId, content: { fileId } }
    return chat.chatType === CHAT_TYPE.P2P && chat.peer
      ? this.chat(CHAT.SEND_P2P, { ...base, to: chat.peer })
      : this.chat(CHAT.SEND_GROUP, base)
  }
  // Лимиты сервера: максимальный размер и запрещённые расширения.
  uploadLimits(): Promise<{ upload?: number; extensions?: { block: boolean; list: string[] } }> {
    return this.sock.request({ method: 'FileUploadLimits' }, 'fileUploadLimits', () => true, 10000) as any
  }
  editText(chatId: string, messageId: string, text: string) { return this.chat(CHAT.EDIT_MSG, { chatId, messageId, type: MSG.TEXT, content: { text } }) }
  removeMessage(chatId: string, messageId: string, forAll = true) { return this.chat(CHAT.REMOVE_MSG, { chatId, messageId, forAll }) }
  forward(toChatId: string, messageId: string): Promise<Partial<ServerMessage>> { return this.chat(CHAT.FORWARD, { chatId: toChatId, forwardMessageId: messageId }) }
  // Одно сообщение по id — для цитаты, если оригинала нет в загруженной истории.
  messageInfo(messageId: string): Promise<ServerMessage> { return this.chat(CHAT.MESSAGE_INFO, { messageId }) }
  markRead(chatId: string, messageId: string) {
    this.sock.send({ method: 'ChatV2', sn: this.sn++, containerType: 0, messageType: CHAT.READ, payload: { chatId, messageId } })
  }

  // ── Адресная книга и присутствие ──────────────────────────────────────
  requestContacts() {
    this.sock.send({ method: 'addressBookInit', contactListHash: '', groupsHash: '', phoneListHash: '', banListHash: '' })
  }
  subscribePresence(callIds: string[]) {
    if (callIds.length) this.sock.send({ method: 'bulkSubscribeUserStatus', callIds })
  }
  search(text: string): Promise<Contact[]> {
    const searchTerm = { callId: text, email: text, displayName: text }
    return this.sock.request({ method: 'searchAddressBook', searchTerm }, 'searchAddressBook',
      f => f.searchTerm?.callId === text).then(f => (Array.isArray(f.result) ? f.result.map(toContact).filter(c => c.callId) : []))
  }
  userDetails(callId: string) {
    return this.sock.request({ method: 'getUserDetails', callId, hash: '' }, 'getUserDetails', f => f.callId === callId)
      .then(f => (typeof f.result === 'object' ? f.result : undefined))
  }
  // Прямая ссылка на файл из чата (с одноразовым токеном) и на его превью.
  private files = new Map<string, Promise<FileEntry | undefined>>()
  fileInfo(fileId: string): Promise<FileEntry | undefined> {
    if (!this.files.has(fileId)) {
      const p = this.sock.request({ method: 'fileInfo', fileId }, 'fileInfo', f => f.fileId === fileId, 15000)
        .then(f => (f.result ? f.entries?.[0] : undefined))
        .catch(() => { this.files.delete(fileId); return undefined })
      this.files.set(fileId, p)
    }
    return this.files.get(fileId)!
  }
  forgetFile(fileId: string) { this.files.delete(fileId) }

  // Файл ещё у отправителя (readyState 1): просим сервер подкачать и следим за прогрессом.
  // Сервер отвечает result:false, если забрать файл не у кого.
  watchUpload(fileId: string, onProgress: (bytes: number) => void): Promise<boolean> {
    const off = this.sock.on('uploadingProgress', f => { if (f.infoHash === fileId) onProgress(f.progress) })
    return this.sock.request({ method: 'SubscribeAttachmentFileProgress', InfoHashParam: fileId }, 'subscribeAttachmentFileProgress', () => true, 10000)
      .then(f => { if (!f.result) off(); return !!f.result }, () => { off(); return false })
  }
  unwatchUpload(fileId: string) { this.sock.send({ method: 'UnsubscribeAttachmentFileProgress', InfoHashParam: fileId }) }

  addContact(callId: string, displayName: string) { this.sock.send({ method: 'addExternalContact', callId, displayName }) }
  removeContact(callId: string) { this.sock.send({ method: 'removeExternalContact', callId }) }
  setStatusText(description: string) { this.sock.send({ method: 'setAdditionalStatus', description }) }
}

// Сервер отдаёт контакты то в camelCase (адресная книга), то в PascalCase (поиск).
export function toContact(r: any): Contact {
  const callId = r.callId ?? r.CallId ?? r.UserName ?? r.userName ?? ''
  const status = r.UserPresStatus ?? r.status ?? r.pressStatus
  return { ...r, callId, displayName: r.displayName ?? r.DisplayName ?? callId.split('@')[0], ...(status !== undefined ? { status } : {}) }
}

export function presenceOf(c: any): Presence {
  const s = c.pressStatus ?? c.status
  if (s === 0) return 'offline'
  if ([2, 3, 5].includes(s)) return 'busy'
  if (c.statusAway) return 'away'
  if (c.statusDoNotDisturb) return 'dnd'
  return 'online'
}

// Текст сообщения из серверного контейнера.
export function messageText(m: ServerMessage): string {
  const c = m.content
  if (m.type === MSG.TEXT) return typeof c === 'string' ? c : c?.content ?? c?.text ?? c?.alt ?? ''
  if (m.type === MSG.FILE) return `📎 ${c?.file_name ?? 'файл'}`
  if (m.type === MSG.LOCATION) return '📍 Геопозиция'
  return ''
}

// Служебные события чата (вход/выход участников, звонки, удаление) — одной строкой.
export function systemText(m: ServerMessage, nameOf: (id: string) => string): string | undefined {
  const who = m.content?.name ? nameOf(m.content.name) : nameOf(m.sender)
  switch (m.type) {
    case 100: return `${nameOf(m.sender)} создал чат`
    case 103: return `Название чата изменено${m.content?.title ? `: «${m.content.title}»` : ''}`
    case 104: return 'Аватар чата изменён'
    case 110: return `${who} добавлен в чат`
    case 111: return `${who} удалён из чата`
    case 112: return `${who} покинул чат`
    case 222: return 'Сообщение удалено'
    case 224: return 'История очищена'
    case 300: return 'Звонок'
    case 301: return 'Пропущенный звонок'
    case 310: return 'Конференция началась'
    case 311: return 'Конференция завершилась'
    case 312: return `${who} подключился к конференции`
    case 313: return `${who} вышел из конференции`
  }
  return undefined
}
export const isSystem = (m: ServerMessage) => m.type !== MSG.TEXT && m.type !== MSG.FILE && m.type !== MSG.LOCATION && m.type !== MSG.WEB_APP

export function sortByTime(list: ServerMessage[]) { return [...list].sort((a, b) => a.timestamp - b.timestamp) }
