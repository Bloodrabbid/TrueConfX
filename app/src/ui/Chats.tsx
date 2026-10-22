import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Search, Send, Video, Users, Star, PhoneMissed, MessageSquare, Reply, Quote, Forward, Copy, Pencil, Trash2, X, CornerUpRight, Link, Download, ChevronDown, Plus, Pin, PinOff, Bell, BellOff, AtSign, Eraser, MoreVertical, Paperclip, Info, FolderOpen, ChevronUp } from 'lucide-react'
import { useStore, peerOf, linkedChatOf, type NotifyLevel } from '../store'
import { CHAT_TYPE, messageText, systemText, isSystem, MSG, type ServerChat, type ServerMessage } from '../tc/client'
import { Avatar, formatTime, dayLabel, PRESENCE_LABEL } from './common'
import { RichText, plainText, toPlain } from './RichText'
import { Attachment } from './Attachment'
import { useMentions, toHtml } from './Mentions'
import { SendFilesDialog } from './SendFiles'

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`
}

const clock = (ts: number) => new Date(ts < 1e12 ? ts * 1000 : ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })

function chatTitle(c: ServerChat, nameOf: (id: string) => string, me?: string) {
  if (c.chatType === CHAT_TYPE.FAVORITES) return 'Избранное'
  if (c.chatType === CHAT_TYPE.MISSED_CALLS) return 'Пропущенные звонки'
  if (c.chatType === CHAT_TYPE.P2P) { const p = peerOf(c, me); return p ? nameOf(p) : c.title }
  return c.title || 'Группа'
}

function previewOf(c: ServerChat, last: ServerMessage | undefined, nameOf: (id: string) => string, me?: string) {
  if (!last) return ''
  if (isSystem(last)) return systemText(last, nameOf) ?? ''
  const who = last.sender === me ? 'Вы: ' : c.chatType === CHAT_TYPE.GROUP ? `${nameOf(last.sender).split(' ')[0]}: ` : ''
  return who + plainText(messageText(last))
}

const LEVEL_LABEL: Record<NotifyLevel, string> = { all: 'Все сообщения', mentions: 'Только упоминания', off: 'Без уведомлений' }

// Действия над чатом: одно меню и в списке (правый клик), и в шапке чата (кнопка «⋮»).
function chatActions(chat: ServerChat): Action[] {
  const s = useStore.getState()
  const pinned = s.pins.includes(chat.chatId)
  const level = s.levelOf(chat)
  const own = s.notifyPrefs.chats[chat.chatId]
  const levels: [NotifyLevel, typeof Bell][] = [['all', Bell], ['mentions', AtSign], ['off', BellOff]]
  const list: Action[] = [
    ...(chat.chatType === CHAT_TYPE.GROUP ? [{ key: 'info', label: 'Информация', icon: Info, run: () => { s.openChat(chat.chatId); s.set({ showMembers: true, showFiles: false }) } }] : []),
    { key: 'files', label: 'Файлы', icon: FolderOpen, run: () => { s.openChat(chat.chatId); s.set({ showFiles: true, showMembers: false }) } },
    { key: 'pin', label: pinned ? 'Открепить' : 'Закрепить', icon: pinned ? PinOff : Pin, sep: true, run: () => s.togglePin(chat.chatId) },
    ...levels.map(([l, icon], i): Action => ({
      key: `n-${l}`, label: LEVEL_LABEL[l], icon, sep: i === 0, hint: level === l ? (own ? '✓' : '✓ по умолч.') : undefined,
      // Повторный выбор уровня по умолчанию снимает личную настройку чата.
      run: () => s.setChatNotify(chat.chatId, own === l ? undefined : l),
    })),
  ]
  if (chat.chatType === CHAT_TYPE.GROUP) list.push({ key: 'rename', label: 'Переименовать', icon: Pencil, sep: true, run: () => s.set({ dialog: { kind: 'rename', chatId: chat.chatId } }) })
  list.push(
    { key: 'clear', label: 'Очистить историю', icon: Eraser, sep: chat.chatType !== CHAT_TYPE.GROUP, run: () => s.set({ dialog: { kind: 'deleteChat', chatId: chat.chatId, clear: true } }) },
    { key: 'delete', label: 'Удалить чат', icon: Trash2, danger: true, run: () => s.set({ dialog: { kind: 'deleteChat', chatId: chat.chatId } }) },
  )
  return list
}

export function ChatList() {
  const { chats, activeChatId, openChat, nameOf, account, unread, presence, pins, levelOf } = useStore()
  useStore(s => s.notifyPrefs)
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const list = useMemo(() => {
    const s = q.toLowerCase()
    const found = chats.filter(c => !linkedChatOf(c)).filter(c => !s || chatTitle(c, nameOf, account?.trueconfId).toLowerCase().includes(s))
    // Закреплённые — сверху, в порядке закрепления.
    const rank = (c: ServerChat) => { const i = pins.indexOf(c.chatId); return i < 0 ? Infinity : i }
    return found.map((c, i) => [c, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c)
  }, [chats, q, nameOf, account, pins])

  return (
    <div className="list-pane">
      <div className="pane-head"><h2>Чаты</h2><div className="grow" /><button className="ghost" title="Новый групповой чат" onClick={() => useStore.getState().set({ dialog: { kind: 'newChat' } })}><Plus size={18} /></button></div>
      <div className="search"><Search size={15} /><input placeholder="Поиск" value={q} onChange={e => setQ(e.target.value)} /></div>
      <div className="list">
        {list.map(c => {
          const title = chatTitle(c, nameOf, account?.trueconfId)
          const peer = peerOf(c, account?.trueconfId)
          const last = c.lastVisibleMessage
          const n = unread[c.chatId] ?? c.unreadMessages ?? 0
          const level = levelOf(c)
          return (
            <button key={c.chatId} className={`row ${c.chatId === activeChatId ? 'active' : ''}`} onClick={() => openChat(c.chatId)}
              onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: chatActions(c) }) }}>
              {c.chatType === CHAT_TYPE.FAVORITES ? <div className="avatar icon"><Star size={18} /></div>
                : c.chatType === CHAT_TYPE.MISSED_CALLS ? <div className="avatar icon"><PhoneMissed size={18} /></div>
                : c.chatType === CHAT_TYPE.GROUP ? <div className="avatar icon group"><Users size={18} /></div>
                : <Avatar name={title} id={peer ?? c.chatId} presence={peer ? presence[peer] : undefined} />}
              <div className="row-main">
                <div className="row-top"><span className="title">{title}</span>{level !== 'all' && (level === 'off' ? <BellOff size={13} className="row-flag" /> : <AtSign size={13} className="row-flag" />)}<span className="time">{formatTime(last?.timestamp)}</span></div>
                <div className="row-bottom">
                  <span className="preview">{previewOf(c, last, nameOf, account?.trueconfId)}</span>
                  {n > 0 ? <span className={`badge ${level !== 'all' ? 'quiet' : ''}`}>{n}</span> : pins.includes(c.chatId) && <Pin size={13} className="row-flag pin" />}
                </div>
              </div>
            </button>
          )
        })}
        {!list.length && <div className="empty">Чатов нет</div>}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

// Короткое описание сообщения для цитаты и панели ответа.
function snippet(m: ServerMessage) {
  if (m.type === MSG.FILE) return `📎 ${m.content?.file_name ?? 'файл'}`
  return plainText(messageText(m)).slice(0, 160)
}

function ReplyQuote({ chatId, messageId, onJump }: { chatId: string; messageId: string; onJump: (id: string) => void }) {
  const { quoted, nameOf } = useStore()
  useStore(s => s.quotes[messageId])
  const orig = quoted(chatId, messageId)
  return (
    <button className="quote" onClick={() => onJump(messageId)}>
      <span className="quote-author">{orig ? nameOf(orig.sender) : 'Сообщение'}</span>
      <span className="quote-text">{orig ? snippet(orig) : orig === null ? 'загружаю…' : ''}</span>
    </button>
  )
}

// Выделенный внутри сообщения фрагмент — его и цитируем, иначе весь текст.
function selectionIn(el: HTMLElement | null) {
  const sel = window.getSelection()
  if (!el || !sel || sel.isCollapsed || !el.contains(sel.anchorNode)) return ''
  return sel.toString().trim()
}

type Action = { key: string; label: string; icon: typeof Reply; run: () => void; danger?: boolean; hint?: string; menuOnly?: boolean; sep?: boolean }

// Действия над сообщением: из одного списка строятся и панель при наведении, и контекстное меню.
function useActions(m: ServerMessage, mine: boolean, ref: React.RefObject<HTMLDivElement | null>, onQuote: (m: ServerMessage, f: string) => void) {
  const { set, removeMessage, notify, client, nameOf } = useStore()
  const text = messageText(m)
  const isText = m.type === MSG.TEXT
  const copy = (v: string, what = 'Скопировано') => { navigator.clipboard.writeText(v); notify(what) }
  return (ctx: { selection: string; link?: string }): Action[] => {
    const list: Action[] = [
      { key: 'reply', label: 'Ответить', icon: Reply, hint: 'двойной клик', run: () => set({ replyTo: m, editing: undefined }) },
    ]
    if (isText) list.push({ key: 'quote', label: ctx.selection ? 'Цитировать выделенное' : 'Цитировать', icon: Quote, run: () => onQuote(m, ctx.selection || selectionIn(ref.current)) })
    list.push({ key: 'forward', label: 'Переслать', icon: Forward, run: () => set({ forwarding: m }) })
    if (isText) list.push({ key: 'copy', label: ctx.selection ? 'Копировать выделенное' : 'Копировать текст', icon: Copy, sep: true, run: () => copy(ctx.selection || selectionIn(ref.current) || plainText(text)) })
    if (ctx.link) list.push({ key: 'link', label: 'Копировать ссылку', icon: Link, menuOnly: true, run: () => copy(ctx.link!, 'Ссылка скопирована') })
    if (m.type === MSG.FILE && m.content?.hash) list.push({
      key: 'save', label: 'Сохранить файл', icon: Download, menuOnly: true, sep: !isText,
      run: async () => {
        const e = await client?.fileInfo(m.content.hash)
        if (e?.readyState === 2) window.native?.download(e.downloadUrl, m.content.file_name)
        else notify('Файл остался у отправителя и сейчас недоступен')
      },
    })
    if (!mine) list.push({ key: 'author', label: `Написать ${nameOf(m.sender).split(' ').slice(0, 2).join(' ')}`, icon: MessageSquare, menuOnly: true, run: () => useStore.getState().openP2P(m.sender) })
    if (mine && isText) list.push({ key: 'edit', label: 'Изменить', icon: Pencil, hint: '↑', sep: true, run: () => set({ editing: m, replyTo: undefined }) })
    if (mine) list.push({ key: 'delete', label: 'Удалить у всех', icon: Trash2, danger: true, sep: !isText, run: () => { if (confirm('Удалить сообщение у всех?')) removeMessage(m) } })
    return list
  }
}

type MenuState = { x: number; y: number; items: Action[] }

function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  // Не даём меню вылезти за край окна.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ x: Math.min(menu.x, innerWidth - r.width - 8), y: menu.y + r.height > innerHeight - 8 ? Math.max(8, menu.y - r.height) : menu.y })
  }, [menu])
  useEffect(() => {
    const close = () => onClose()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('mousedown', close); addEventListener('blur', close); addEventListener('keydown', key); addEventListener('wheel', close, { passive: true })
    return () => { removeEventListener('mousedown', close); removeEventListener('blur', close); removeEventListener('keydown', key); removeEventListener('wheel', close) }
  }, [onClose])
  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
      {menu.items.map(a => (
        <Fragment key={a.key}>
          {a.sep && <div className="ctx-sep" />}
          <button className={a.danger ? 'danger' : ''} onClick={() => { onClose(); a.run() }}>
            <a.icon size={15} /><span>{a.label}</span>{a.hint && <kbd>{a.hint}</kbd>}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

function Bubble({ m, mine, showAuthor, onQuote, onJump, onMenu }: { m: ServerMessage; mine: boolean; showAuthor: boolean; onQuote: (m: ServerMessage, fragment: string) => void; onJump: (id: string) => void; onMenu: (s: MenuState) => void }) {
  const { nameOf, set } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const c = m.content ?? {}
  const isImage = m.type === MSG.FILE && String(c.file_type ?? '').startsWith('image/')
  const text = messageText(m)
  const actions = useActions(m, mine, ref, onQuote)
  const tools = actions({ selection: '' }).filter(a => !a.menuOnly)
  return (
    <div className={`msg ${mine ? 'mine' : ''}`} id={`m-${m.messageId}`} onDoubleClick={() => set({ replyTo: m, editing: undefined })}
      onContextMenu={e => {
        e.preventDefault()
        const link = (e.target as HTMLElement).closest('a')?.getAttribute('href') ?? undefined
        onMenu({ x: e.clientX, y: e.clientY, items: actions({ selection: selectionIn(ref.current), link }) })
      }}>
      {showAuthor && !mine && <div className="author">{nameOf(m.sender)}</div>}
      <div className="bubble-row">
        <div className={`bubble ${isImage && !m.replyMessageId && !m.forwardMessage ? 'media' : ''}`} ref={ref}>
          {m.forwardMessage && <div className="fwd"><CornerUpRight size={12} /> Переслано от {nameOf(m.forwardMessage.from)}</div>}
          {m.replyMessageId && <ReplyQuote chatId={m.chatId} messageId={m.replyMessageId} onJump={onJump} />}
          {m.type === MSG.FILE ? <Attachment m={m} /> : <span className="text"><RichText html={text} /></span>}
          {m.type === MSG.FILE && c.description ? <span className="text"><RichText html={c.description} /></span> : null}
          <span className="meta">{(m as any).edited && 'изм. '}{clock(m.timestamp)}</span>
        </div>
        <div className="msg-tools" onMouseDown={e => e.preventDefault()}>
          {tools.map(a => <button key={a.key} title={a.label} className={a.danger ? 'danger' : ''} onClick={a.run}><a.icon size={15} /></button>)}
        </div>
      </div>
    </div>
  )
}

function ForwardDialog() {
  const { forwarding, chats, set, forwardTo, nameOf, account } = useStore()
  const [q, setQ] = useState('')
  if (!forwarding) return null
  const list = chats.filter(c => !linkedChatOf(c) && chatTitle(c, nameOf, account?.trueconfId).toLowerCase().includes(q.toLowerCase())).slice(0, 50)
  return (
    <div className="modal-bg" onClick={() => set({ forwarding: undefined })}>
      <div className="modal narrow" onClick={e => e.stopPropagation()}>
        <h3>Переслать в…</h3>
        <div className="quote static"><span className="quote-author">{nameOf(forwarding.sender)}</span><span className="quote-text">{snippet(forwarding)}</span></div>
        <div className="search wide"><Search size={15} /><input autoFocus placeholder="Чат или человек" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="list">
          {list.map(c => {
            const title = chatTitle(c, nameOf, account?.trueconfId)
            return (
              <button key={c.chatId} className="row" onClick={() => forwardTo(c.chatId)}>
                <Avatar name={title} id={peerOf(c, account?.trueconfId) ?? c.chatId} size={32} />
                <div className="row-main"><div className="title">{title}</div></div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function ChatView() {
  const { chats, activeChatId, messages, account, nameOf, send, loadOlder, presence, replyTo, editing, set, draft, members, showMembers, loadMembers } = useStore()
  const memberCount = activeChatId ? members[activeChatId]?.length ?? 0 : 0
  const chat = chats.find(c => c.chatId === activeChatId)
  const list = activeChatId ? messages[activeChatId] ?? [] : []
  const text = activeChatId ? draft[activeChatId] ?? '' : ''
  const setText = (t: string) => activeChatId && set({ draft: { ...useStore.getState().draft, [activeChatId]: t } })
  const [chatMenu, setChatMenu] = useState<MenuState | null>(null)
  const [pending, setPending] = useState<File[]>([])
  const [search, setSearch] = useState<string | null>(null)
  const [hit, setHit] = useState(0)
  // Поиск по загруженной истории: текст сообщений и имена файлов. На сервере поиска по чату нет.
  const found = useMemo(() => {
    const q = search?.trim().toLowerCase()
    if (!q) return []
    return list.filter(m => !isSystem(m) && `${plainText(messageText(m))} ${m.content?.file_name ?? ''}`.toLowerCase().includes(q))
  }, [search, list])
  useEffect(() => { setSearch(null) }, [activeChatId])
  // Набрали запрос — сразу показываем самое новое совпадение.
  useEffect(() => {
    const m = found.at(-1)
    if (!m) return
    const el = document.getElementById(`m-${m.messageId}`)
    el?.scrollIntoView({ block: 'center' })
    el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1200)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); setSearch(q => q ?? '') } }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [])
  const [dragging, setDragging] = useState(false)
  const filePicker = useRef<HTMLInputElement>(null)
  const addFiles = (list: FileList | File[] | null | undefined) => { const a = Array.from(list ?? []); if (a.length) setPending(p => [...p, ...a]) }
  const notifyPrefs = useStore(s => s.notifyPrefs)
  const level: NotifyLevel = chat ? notifyPrefs.chats[chat.chatId] ?? useStore.getState().levelOf(chat) : 'all'
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const atBottom = useRef(true)
  const [showDown, setShowDown] = useState(false)
  const [newBelow, setNewBelow] = useState(0)
  const seen = useRef(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  // Внизу — держим ленту прижатой; прокрутили вверх — копим «новых ниже» для кнопки.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const lastId = list.at(-1)?.messageId
    if (atBottom.current) el.scrollTop = el.scrollHeight
    else if (lastId && seen.current && list.length > seen.current) setNewBelow(n => n + (list.length - seen.current))
    seen.current = list.length
  }, [list.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    atBottom.current = true; seen.current = 0; setShowDown(false); setNewBelow(0)
    requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight })
  }, [activeChatId])
  const scrollDown = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: el.scrollHeight - el.scrollTop > 4000 ? 'auto' : 'smooth' })
    setNewBelow(0)
  }
  useEffect(() => { input.current?.focus() }, [activeChatId, replyTo])
  // Участников группы подгружаем при открытии и после служебных «добавлен / удалён / вышел».
  const lastSys = list.findLast(m => m.type >= 110 && m.type <= 112)?.messageId
  useEffect(() => {
    const c = chats.find(x => x.chatId === activeChatId)
    if (c?.chatType === CHAT_TYPE.GROUP) loadMembers(c.chatId)
  }, [activeChatId, lastSys]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!editing) return
    setText(toPlain(messageText(editing)))
    input.current?.focus()
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const mention = useMentions(activeChatId, text, setText, input)
  if (!chat) return <div className="chat-view empty-state"><MessageSquare size={48} /><p>Выберите чат слева</p></div>
  const me = account?.trueconfId
  const peer = peerOf(chat, me)
  const title = chatTitle(chat, nameOf, me)

  const openCall = async (c: ServerChat) => {
    const st = useStore.getState()
    if (c.chatType === CHAT_TYPE.GROUP) {
      const members = await st.client!.participants(c.chatId).catch(() => [])
      st.resolveNames(members)
      st.set({ dialog: { kind: 'call', topic: title, invitees: members.filter(id => id !== me), chatId: c.chatId } })
    } else if (peer) {
      st.set({ dialog: { kind: 'call', topic: `${nameOf(me ?? '').split(' ')[0]} и ${nameOf(peer).split(' ')[0]}`, invitees: [peer], chatId: c.chatId } })
    }
  }
  const submit = () => {
    const t = text.trim()
    if (!t) return
    send(toHtml(t, mention.used()))
    setText(''); mention.reset()
  }
  const cancel = () => { if (editing) setText(''); set({ replyTo: undefined, editing: undefined }) }

  // Цитата: ответ на сообщение + сам фрагмент в тексте, чтобы его видели и в официальном клиенте.
  const onQuote = (m: ServerMessage, fragment: string) => {
    const q = (fragment || plainText(messageText(m))).split('\n').map(l => `> ${l}`).join('\n')
    set({ replyTo: m, editing: undefined })
    setText(`${q}\n${text}`)
  }
  const onJump = (id: string) => {
    const el = document.getElementById(`m-${id}`)
    if (!el) return useStore.getState().notify('Сообщение выше загруженной истории')
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200)
  }

  return (
    <div className={`chat-view ${dragging ? 'dragging' : ''}`}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={e => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}>
      <div className="chat-head">
        <Avatar name={title} id={peer ?? chat.chatId} size={36} />
        <div className="chat-head-main">
          <div className="title">{title}{level !== 'all' && <span className="muted" title={LEVEL_LABEL[level]}>{level === 'off' ? <BellOff size={13} /> : <AtSign size={13} />}</span>}</div>
          {peer ? <div className="muted small">{PRESENCE_LABEL[presence[peer] ?? 'offline']}</div>
            : <button className="muted small link-like" onClick={() => set({ showMembers: !showMembers, showFiles: false })}>{memberCount ? plural(memberCount, 'участник', 'участника', 'участников') : 'Групповой чат'}</button>}
        </div>
        {chat.chatType === CHAT_TYPE.GROUP && <button className={`ghost ${showMembers ? 'on' : ''}`} title="Участники" onClick={() => set({ showMembers: !showMembers, showFiles: false })}><Users size={18} /></button>}
        <button className={`ghost ${search !== null ? 'on' : ''}`} title="Поиск по чату (⌘F)" onClick={() => setSearch(search === null ? '' : null)}><Search size={18} /></button>
        <button className="ghost" title={chat.chatType === CHAT_TYPE.GROUP ? 'Созвон с участниками чата' : 'Позвонить'} onClick={() => openCall(chat)}><Video size={18} /></button>
        <button className="ghost" title="Действия с чатом" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setChatMenu({ x: r.right - 220, y: r.bottom + 4, items: chatActions(chat) }) }}><MoreVertical size={18} /></button>
        {chatMenu && <ContextMenu menu={chatMenu} onClose={() => setChatMenu(null)} />}
      </div>
      {search !== null && (
        <div className="chat-search">
          <Search size={15} />
          <input autoFocus placeholder="Поиск в чате" value={search} onChange={e => { setSearch(e.target.value); setHit(0) }}
            onKeyDown={e => {
              if (e.key === 'Escape') setSearch(null)
              if (e.key === 'Enter' && found.length) { const n = (hit + (e.shiftKey ? found.length - 1 : 1)) % found.length; setHit(n); onJump(found[found.length - 1 - n].messageId) }
            }} />
          <span className="muted small">{search.trim() ? (found.length ? `${Math.min(hit + 1, found.length)} из ${found.length}` : 'Не найдено') : ''}</span>
          <button className="ghost" title="Раньше (Enter)" disabled={!found.length} onClick={() => { const n = (hit + 1) % found.length; setHit(n); onJump(found[found.length - 1 - n].messageId) }}><ChevronUp size={16} /></button>
          <button className="ghost" title="Позже (Shift+Enter)" disabled={!found.length} onClick={() => { const n = (hit + found.length - 1) % found.length; setHit(n); onJump(found[found.length - 1 - n].messageId) }}><ChevronDown size={16} /></button>
          <button className="ghost small-btn" title="Загрузить более ранние сообщения и искать в них" onClick={() => loadOlder(chat.chatId)}>Искать раньше</button>
          <button className="ghost" title="Закрыть (Esc)" onClick={() => setSearch(null)}><X size={16} /></button>
        </div>
      )}
      <div className="messages" ref={scroller} onScroll={e => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        const far = el.scrollHeight - el.scrollTop - el.clientHeight > 400
        if (far !== showDown) setShowDown(far)
        if (atBottom.current && newBelow) setNewBelow(0)
        if (el.scrollTop < 40 && list.length >= 50) loadOlder(chat.chatId)
      }}>
        {list.map((m, i) => {
          const prev = list[i - 1]
          const newDay = !prev || dayLabel(prev.timestamp) !== dayLabel(m.timestamp)
          const sys = isSystem(m) ? systemText(m, nameOf) : undefined
          if (isSystem(m) && !sys) return null
          if (!isSystem(m) && !messageText(m) && m.type !== MSG.FILE) return null
          return (
            <Fragment key={m.messageId}>
              {newDay && <div className="day">{dayLabel(m.timestamp)}</div>}
              {sys ? <div className="sys">{sys}</div>
                : <Bubble m={m} mine={m.sender === me} onQuote={onQuote} onJump={onJump} onMenu={setMenu}
                    showAuthor={chat.chatType === CHAT_TYPE.GROUP && (newDay || prev?.sender !== m.sender || isSystem(prev))} />}
            </Fragment>
          )
        })}
      </div>
      {showDown && (
        <button className="scroll-down" title="Вниз" onClick={scrollDown}>
          <ChevronDown size={20} />
          {newBelow > 0 && <span className="badge">{newBelow}</span>}
        </button>
      )}
      {(replyTo || editing) && (
        <div className="reply-bar">
          {editing ? <Pencil size={16} /> : <Reply size={16} />}
          <div className="reply-main">
            <span className="quote-author">{editing ? 'Редактирование' : `Ответ ${nameOf(replyTo!.sender)}`}</span>
            <span className="quote-text">{snippet((editing ?? replyTo)!)}</span>
          </div>
          <button className="ghost" title="Отмена (Esc)" onClick={cancel}><X size={16} /></button>
        </div>
      )}
      <div className="composer">
        {mention.popup}
        <button className="ghost attach" title="Прикрепить файл" onClick={() => filePicker.current?.click()}><Paperclip size={18} /></button>
        <input ref={filePicker} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
        <textarea ref={input} rows={1}
          // Картинка или файл из буфера обмена — в окно отправки, текст — как обычно.
          onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files) } }} placeholder="Сообщение · @ — упомянуть" value={text}
          onChange={e => { setText(e.target.value); mention.trackCaret() }} onSelect={mention.trackCaret} onClick={mention.trackCaret}
          onKeyDown={e => {
            if (mention.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            if (e.key === 'Escape') cancel()
            // Стрелка вверх в пустом поле — изменить своё последнее сообщение.
            if (e.key === 'ArrowUp' && !text) {
              const last = [...list].reverse().find(m => m.sender === me && m.type === MSG.TEXT)
              if (last) { e.preventDefault(); set({ editing: last, replyTo: undefined }) }
            }
          }} />
        <button className="send" disabled={!text.trim()} onClick={submit}><Send size={18} /></button>
      </div>
      <ForwardDialog />
      {pending.length > 0 && <SendFilesDialog files={pending} setFiles={setPending} draft={text} clearDraft={() => setText('')} />}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  )
}
