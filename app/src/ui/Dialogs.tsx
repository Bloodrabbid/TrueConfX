// Окна «Новый чат» и «Созвон» и общий для них выбор людей с поиском по адресной книге сервера.
import { useEffect, useState } from 'react'
import { X, Video, Users, Search, Pencil, Trash2, Eraser } from 'lucide-react'
import { useStore, peerOf } from '../store'
import { CHAT_TYPE, type Contact } from '../tc/client'
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

function RenameDialog({ chatId }: { chatId: string }) {
  const { set, chats, renameChat } = useStore()
  const chat = chats.find(c => c.chatId === chatId)
  const [title, setTitle] = useState(chat?.title ?? '')
  const save = async () => { set({ dialog: undefined }); await renameChat(chatId, title.trim()) }
  return (
    <div className="modal narrow" onClick={e => e.stopPropagation()}>
      <h3><Pencil size={17} /> Название чата</h3>
      <label className="field">Название<input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && title.trim() && save()} /></label>
      <div className="modal-actions">
        <button className="ghost" onClick={() => set({ dialog: undefined })}>Отмена</button>
        <button className="primary" disabled={!title.trim() || title.trim() === chat?.title} onClick={save}>Сохранить</button>
      </div>
    </div>
  )
}

function DeleteChatDialog({ chatId, clear }: { chatId: string; clear?: boolean }) {
  const { set, chats, nameOf, account, deleteChat, clearHistory } = useStore()
  const chat = chats.find(c => c.chatId === chatId)
  const [forAll, setForAll] = useState(false)
  if (!chat) return null
  const p2p = chat.chatType === CHAT_TYPE.P2P
  const group = chat.chatType === CHAT_TYPE.GROUP
  const peer = peerOf(chat, account?.trueconfId)
  const title = p2p && peer ? nameOf(peer) : chat.title
  const go = async () => { set({ dialog: undefined }); await (clear ? clearHistory : deleteChat)(chatId, forAll) }
  return (
    <div className="modal narrow" onClick={e => e.stopPropagation()}>
      <h3>{clear ? <Eraser size={17} /> : <Trash2 size={17} />} {clear ? 'Очистить историю' : 'Удалить чат'} «{title}»?</h3>
      <p className="muted">{clear ? 'Сообщения пропадут из чата. Отменить это нельзя.'
        : group ? (forAll ? 'Чат и история пропадут у всех участников. Отменить это нельзя.' : 'Вы выйдете из группы, история у вас очистится.')
        : 'История очистится, чат пропадёт из списка до нового сообщения.'}</p>
      {chat.chatType !== CHAT_TYPE.FAVORITES && (
        <label className="check"><input type="checkbox" checked={forAll} onChange={e => setForAll(e.target.checked)} />
          {p2p ? `Также для ${peer ? nameOf(peer).split(' ').slice(0, 2).join(' ') : 'собеседника'}` : 'Для всех участников (нужны права владельца)'}</label>
      )}
      <div className="modal-actions">
        <button className="ghost" onClick={() => set({ dialog: undefined })}>Отмена</button>
        <button className="primary danger" onClick={go}>{clear ? 'Очистить' : group && !forAll ? 'Выйти и удалить' : 'Удалить'}</button>
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
        {dialog.kind === 'newChat' ? <NewChatDialog />
          : dialog.kind === 'rename' ? <RenameDialog chatId={dialog.chatId} />
          : dialog.kind === 'deleteChat' ? <DeleteChatDialog chatId={dialog.chatId} clear={dialog.clear} />
          : <CallDialog {...dialog} />}
      </div>
    </div>
  )
}
