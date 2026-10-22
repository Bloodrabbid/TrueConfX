// Панель участников группового чата: статусы, роли, добавить, убрать, выйти.
import { useEffect, useState } from 'react'
import { X, UserPlus, LogOut, MessageSquare, Video } from 'lucide-react'
import { useStore } from '../store'
import { CHAT_TYPE } from '../tc/client'
import { Avatar, PRESENCE_LABEL } from './common'
import { PeoplePicker } from './Dialogs'

const ROLE: Record<string, string> = { owner: 'владелец', admin: 'админ' }
const ORDER: Record<string, number> = { owner: 0, admin: 1 }

export function MembersPanel() {
  const { showMembers, activeChatId, chats, members, presence, nameOf, account, set, addMembers, kickMember, leaveChat, openP2P } = useStore()
  const [adding, setAdding] = useState<string[] | null>(null)
  const chat = chats.find(c => c.chatId === activeChatId)
  useEffect(() => setAdding(null), [activeChatId])
  if (!showMembers || !chat || chat.chatType !== CHAT_TYPE.GROUP) return null

  const list = [...(members[chat.chatId] ?? [])].sort((a, b) =>
    (ORDER[a.role] ?? 2) - (ORDER[b.role] ?? 2) || nameOf(a.id).localeCompare(nameOf(b.id), 'ru'))
  const me = account?.trueconfId
  const myRole = list.find(m => m.id === me)?.role
  const canManage = myRole === 'owner' || myRole === 'admin'
  const online = list.filter(m => presence[m.id] && presence[m.id] !== 'offline').length

  return (
    <aside className="members">
      <div className="members-head">
        <div><h3>Участники</h3><span className="muted small">{list.length} · в сети {online}</span></div>
        <button className="ghost" title="Закрыть" onClick={() => set({ showMembers: false })}><X size={17} /></button>
      </div>

      {adding ? (
        <div className="members-add">
          <PeoplePicker value={adding} onChange={setAdding} />
          <div className="modal-actions">
            <button className="ghost" onClick={() => setAdding(null)}>Отмена</button>
            <button className="primary small" disabled={!adding.length} onClick={async () => { await addMembers(chat.chatId, adding); setAdding(null) }}>Добавить {adding.length || ''}</button>
          </div>
        </div>
      ) : (
        <button className="members-action" onClick={() => setAdding([])}><UserPlus size={16} /> Добавить участников</button>
      )}

      <div className="list">
        {list.map(m => {
          const p = presence[m.id] ?? 'offline'
          return (
            <div className="row member" key={m.id}>
              <Avatar name={nameOf(m.id)} id={m.id} size={34} presence={p} />
              <div className="row-main">
                <div className="title">{nameOf(m.id)}{m.id === me && <span className="muted"> (вы)</span>}</div>
                <div className="muted small">{ROLE[m.role] ? <span className="role">{ROLE[m.role]}</span> : null}{PRESENCE_LABEL[p]}</div>
              </div>
              {m.id !== me && (
                <div className="row-actions member-tools">
                  <button className="ghost" title="Написать" onClick={() => openP2P(m.id)}><MessageSquare size={15} /></button>
                  <button className="ghost" title="Позвонить" onClick={() => set({ dialog: { kind: 'call', topic: `Созвон с ${nameOf(m.id).split(' ').slice(0, 2).join(' ')}`, invitees: [m.id] } })}><Video size={15} /></button>
                  {canManage && m.role !== 'owner' && <button className="ghost" title="Убрать из чата" onClick={() => confirm(`Убрать ${nameOf(m.id)} из чата?`) && kickMember(chat.chatId, m.id)}><X size={15} /></button>}
                </div>
              )}
            </div>
          )
        })}
        {!list.length && <div className="empty">Загружаю…</div>}
      </div>

      <button className="members-action danger" onClick={() => confirm(`Выйти из чата «${chat.title}»?`) && leaveChat(chat.chatId)}><LogOut size={16} /> Выйти из чата</button>
    </aside>
  )
}
