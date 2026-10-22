// Окна «Новый чат» и «Созвон» и общий для них выбор людей с поиском по адресной книге сервера.
import { useEffect, useState } from 'react'
import { X, Video, Users, Search } from 'lucide-react'
import { useStore } from '../store'
import type { Contact } from '../tc/client'
import { Avatar } from './common'

// «Рыжаков Алексей Павлович» → «Рыжаков А. П.»
function shortName(full: string) {
  const [last, ...rest] = full.split(' ')
  return rest.length ? `${last} ${rest.map(p => `${p[0]}.`).join(' ')}` : full
}

export function PeoplePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { client, contacts, nameOf, account, presence } = useStore()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Contact[]>([])

  useEffect(() => {
    const s = q.trim().toLowerCase()
    if (!s) { setFound([]); return }
    const local = contacts.filter(c => c.displayName.toLowerCase().includes(s) || c.callId.includes(s))
    setFound(local)
    if (s.length < 3 || !client) return
    const t = setTimeout(() => client.search(q.trim()).then(r => {
      const names = { ...useStore.getState().names }
      for (const c of r) names[c.callId] = c.displayName
      useStore.setState({ names })
      setFound([...local, ...r.filter(x => !local.some(l => l.callId === x.callId))])
    }).catch(() => {}), 350)
    return () => clearTimeout(t)
  }, [q, client, contacts])

  const add = (id: string) => { if (!value.includes(id)) onChange([...value, id]); setQ('') }
  const options = found.filter(c => c.callId !== account?.trueconfId && !value.includes(c.callId)).slice(0, 8)

  return (
    <div className="picker">
      <div className="chips">
        {value.map(id => (
          <span className="chip" key={id} title={`${nameOf(id)} · ${id}`}>{shortName(nameOf(id))}<button title="Убрать" onClick={() => onChange(value.filter(x => x !== id))}><X size={12} /></button></span>
        ))}
        <span className="chip-input"><Search size={14} />
          <input placeholder={value.length ? 'Добавить ещё…' : 'Имя или логин'} value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && options[0]) add(options[0].callId); if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1)) }} />
        </span>
      </div>
      {options.length > 0 && (
        <div className="picker-list">
          {options.map(c => (
            <button key={c.callId} className="row" onClick={() => add(c.callId)}>
              <Avatar name={c.displayName} id={c.callId} size={28} presence={presence[c.callId]} />
              <div className="row-main"><div className="title">{c.displayName}</div><div className="muted small">{c.callId}</div></div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NewChatDialog() {
  const { set, createGroupChat } = useStore()
  const [title, setTitle] = useState('')
  const [members, setMembers] = useState<string[]>([])
  return (
    <div className="modal narrow" onClick={e => e.stopPropagation()}>
      <h3><Users size={17} /> Новый групповой чат</h3>
      <label className="field">Название<input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Например, «Релиз 2.31»" /></label>
      <label className="field">Участники</label>
      <PeoplePicker value={members} onChange={setMembers} />
      <div className="modal-actions">
        <button className="ghost" onClick={() => set({ dialog: undefined })}>Отмена</button>
        <button className="primary" disabled={!title.trim() || !members.length} onClick={() => createGroupChat(title.trim(), members)}>Создать</button>
      </div>
    </div>
  )
}

function CallDialog({ topic: t0, invitees: i0, chatId }: { topic: string; invitees: string[]; chatId?: string }) {
  const { set, startCall, rest } = useStore()
  const [topic, setTopic] = useState(t0)
  const [invitees, setInvitees] = useState(i0)
  const [postLink, setPostLink] = useState(!!chatId)
  return (
    <div className="modal narrow" onClick={e => e.stopPropagation()}>
      <h3><Video size={17} /> Созвон</h3>
      <label className="field">Тема<input autoFocus value={topic} onChange={e => setTopic(e.target.value)} /></label>
      <label className="field">Кому позвонить · {invitees.length}</label>
      <PeoplePicker value={invitees} onChange={setInvitees} />
      {chatId && <label className="check"><input type="checkbox" checked={postLink} onChange={e => setPostLink(e.target.checked)} />Отправить ссылку на созвон в чат</label>}
      {!rest?.ready && <div className="error">Сервер не выдал доступ к API — создать конференцию не получится.</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={() => set({ dialog: undefined })}>Отмена</button>
        <button className="primary" disabled={!topic.trim() || !rest?.ready} onClick={() => startCall(topic.trim(), invitees, { chatId, postLink })}>
          <Video size={15} /> Начать{invitees.length ? ` и позвать ${invitees.length}` : ''}
        </button>
      </div>
    </div>
  )
}

export function Dialogs() {
  const { dialog, set } = useStore()
  if (!dialog) return null
  return (
    <div className="modal-bg" onMouseDown={() => set({ dialog: undefined })} onKeyDown={e => e.key === 'Escape' && set({ dialog: undefined })}>
      <div onMouseDown={e => e.stopPropagation()}>
        {dialog.kind === 'newChat' ? <NewChatDialog /> : <CallDialog {...dialog} />}
      </div>
    </div>
  )
}
