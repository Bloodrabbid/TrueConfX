import { useEffect, useMemo, useState } from 'react'
import { Search, MessageSquare, UserPlus, Video } from 'lucide-react'
import { useStore } from '../store'
import { presenceOf, type Contact } from '../tc/client'
import { Avatar, PRESENCE_LABEL } from './common'

const ORDER = { online: 0, away: 1, dnd: 2, busy: 3, offline: 4 }

export function Contacts() {
  const { contacts, presence, openP2P, client, set } = useStore()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Contact[]>([])

  // Поиск по всей адресной книге сервера, если локально ничего не нашлось.
  useEffect(() => {
    if (q.length < 3 || !client) { setFound([]); return }
    const t = setTimeout(() => client.search(q).then(list => {
      setFound(list)
      // Статус из выдачи поиска сразу показываем, без отдельной подписки.
      const pres = { ...useStore.getState().presence }
      for (const c of list) if (c.status !== undefined && !pres[c.callId]) pres[c.callId] = presenceOf(c)
      useStore.setState({ presence: pres })
    }).catch(() => setFound([])), 400)
    return () => clearTimeout(t)
  }, [q, client])

  const list = useMemo(() => {
    const s = q.toLowerCase()
    return contacts
      .filter(c => !s || c.displayName.toLowerCase().includes(s) || c.callId.toLowerCase().includes(s))
      .sort((a, b) => ORDER[presence[a.callId] ?? 'offline'] - ORDER[presence[b.callId] ?? 'offline'] || a.displayName.localeCompare(b.displayName, 'ru'))
  }, [contacts, presence, q])
  const extra = found.filter(f => !contacts.some(c => c.callId === f.callId))

  const row = (c: Contact, add?: boolean) => (
    <div className="row contact clickable" key={c.callId} onClick={() => { openP2P(c.callId); set({ tab: 'chats' }) }}>
      <Avatar name={c.displayName} id={c.callId} presence={presence[c.callId] ?? 'offline'} />
      <div className="row-main">
        <div className="title">{c.displayName}</div>
        <div className="muted small">{c.callId} · {PRESENCE_LABEL[presence[c.callId] ?? 'offline']}</div>
      </div>
      <div className="row-actions">
        {add && <button className="ghost" title="Добавить в контакты" onClick={e => { e.stopPropagation(); client?.addContact(c.callId, c.displayName) }}><UserPlus size={17} /></button>}
        <button className="ghost" title="Позвонить" onClick={e => { e.stopPropagation(); set({ dialog: { kind: 'call', topic: `Созвон с ${c.displayName.split(' ').slice(0, 2).join(' ')}`, invitees: [c.callId] } }) }}><Video size={17} /></button>
        <button className="ghost" title="Написать" onClick={e => { e.stopPropagation(); openP2P(c.callId); set({ tab: 'chats' }) }}><MessageSquare size={17} /></button>
      </div>
    </div>
  )

  return (
    <div className="page">
      <div className="pane-head"><h2>Контакты</h2><span className="muted">{contacts.length}</span></div>
      <div className="search wide"><Search size={15} /><input placeholder="Имя, логин или почта" value={q} onChange={e => setQ(e.target.value)} /></div>
      <div className="list">
        {list.map(c => row(c))}
        {extra.length > 0 && <div className="section">В адресной книге сервера</div>}
        {extra.map(c => row(c, true))}
        {!list.length && !extra.length && <div className="empty">Никого не нашлось</div>}
      </div>
    </div>
  )
}
