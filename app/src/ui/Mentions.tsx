// Упоминания через «@» в поле ввода и перевод текста в HTML, который шлёт официальный клиент:
// переносы — <br>, спецсимволы — сущности, упоминание — <a href="trueconf:логин&do=profile">Имя</a>.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useStore } from '../store'
import { Avatar } from './common'

export type Mention = { id: string; name: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function toHtml(text: string, mentions: Mention[]) {
  let html = esc(text)
  for (const m of mentions) {
    const token = esc(`@${m.name}`)
    html = html.split(token).join(`<a href="trueconf:${esc(m.id)}&do=profile">${esc(m.name)}</a>`)
  }
  return html.replace(/\r?\n/g, '<br>')
}

// «@запрос» прямо перед курсором: от «@» в начале строки или после пробела до курсора.
function queryAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret))
  return m ? { start: caret - m[2].length - 1, q: m[2] } : undefined
}

export function useMentions(chatId: string | undefined, text: string, setText: (t: string) => void, input: RefObject<HTMLTextAreaElement | null>) {
  const { members, contacts, nameOf, client, account, chats, presence } = useStore()
  const [caret, setCaret] = useState(0)
  const [index, setIndex] = useState(0)
  const [remote, setRemote] = useState<Mention[]>([])
  const [closed, setClosed] = useState(false)
  const picked = useRef<Mention[]>([])
  const at = queryAt(text, caret)
  const q = at?.q.toLowerCase() ?? ''

  // Кого предлагать: участники чата, собеседник в личке, контакты.
  const local = useMemo(() => {
    const ids = new Set<string>()
    for (const m of members[chatId ?? ''] ?? []) ids.add(m.id)
    const chat = chats.find(c => c.chatId === chatId)
    if (chat?.chatType === 1 && chat.title?.includes('@')) ids.add(chat.title)
    for (const c of contacts) ids.add(c.callId)
    ids.delete(account?.trueconfId ?? '')
    return [...ids].map(id => ({ id, name: nameOf(id) }))
  }, [members, chatId, chats, contacts, account, nameOf])

  const matches = (m: Mention) => !q || m.name.toLowerCase().split(/\s+/).some(w => w.startsWith(q)) || m.name.toLowerCase().includes(q) || m.id.toLowerCase().startsWith(q)
  const options = useMemo(() => {
    const list = local.filter(matches)
    for (const r of remote) if (matches(r) && !list.some(l => l.id === r.id)) list.push(r)
    return list.slice(0, 7)
  }, [local, remote, q]) // eslint-disable-line react-hooks/exhaustive-deps

  // Своих мало — ищем по всей адресной книге сервера.
  useEffect(() => {
    setRemote([])
    if (!at || q.length < 3 || !client) return
    const t = setTimeout(() => client.search(at.q).then(r => setRemote(r.map(c => ({ id: c.callId, name: c.displayName })))).catch(() => {}), 300)
    return () => clearTimeout(t)
  }, [q, client]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setIndex(0); setClosed(false) }, [q])

  const open = !!at && !closed && options.length > 0

  const choose = (m: Mention) => {
    if (!at) return
    const before = text.slice(0, at.start), after = text.slice(caret)
    const inserted = `@${m.name} `
    setText(before + inserted + after)
    picked.current = [...picked.current.filter(p => p.id !== m.id), m]
    const pos = before.length + inserted.length
    requestAnimationFrame(() => { input.current?.setSelectionRange(pos, pos); setCaret(pos) })
  }

  // true — клавишу забрал список упоминаний.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % options.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + options.length) % options.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[index]); return true }
    if (e.key === 'Escape') { e.preventDefault(); setClosed(true); return true }
    return false
  }

  const trackCaret = () => setCaret(input.current?.selectionStart ?? text.length)

  const popup = open ? (
    <div className="mention-pop" onMouseDown={e => e.preventDefault()}>
      {options.map((m, i) => (
        <button key={m.id} className={`row ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(m)}>
          <Avatar name={m.name} id={m.id} size={26} presence={presence[m.id]} />
          <span className="title">{m.name}</span>
          <span className="muted small">{m.id.split('@')[0]}</span>
        </button>
      ))}
    </div>
  ) : null

  // Упоминания, которые остались в тексте, — для перевода в HTML при отправке.
  const used = () => picked.current.filter(m => text.includes(`@${m.name}`))
  const reset = () => { picked.current = [] }

  return { popup, onKeyDown, trackCaret, used, reset }
}
