import { useEffect, useState } from 'react'
import { MessageSquare, Users, Video, Settings as Gear, LogOut, Moon, Sun } from 'lucide-react'
import { useStore, type Tab } from './store'
import { Login } from './ui/Login'
import { ChatList, ChatView } from './ui/Chats'
import { Contacts } from './ui/Contacts'
import { Meet } from './ui/Meet'
import { Settings } from './ui/Settings'
import { Avatar } from './ui/common'
import { Dialogs } from './ui/Dialogs'
import { MembersPanel } from './ui/Members'
import './App.css'

function ScreenPicker() {
  const [list, setList] = useState<{ id: string; name: string; thumb: string }[] | null>(null)
  useEffect(() => window.native?.onPickScreen?.(setList), [])
  if (!list) return null
  const pick = (id: string | null) => { window.native?.pickScreen(id); setList(null) }
  return (
    <div className="modal-bg" onClick={() => pick(null)}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Что показать?</h3>
        <div className="screens">
          {list.map(s => <button key={s.id} className="screen" onClick={() => pick(s.id)}><img src={s.thumb} alt="" /><span>{s.name}</span></button>)}
        </div>
        <button className="ghost" onClick={() => pick(null)}>Отмена</button>
      </div>
    </div>
  )
}

const NAV: [Tab, typeof MessageSquare, string][] = [['chats', MessageSquare, 'Чаты'], ['contacts', Users, 'Контакты'], ['meet', Video, 'Конференции'], ['settings', Gear, 'Настройки']]

export default function App() {
  const { account, tab, set, theme, logout, unread, conference, toast } = useStore()
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  // Горячие клавиши звонка, как в Zoom/Meet.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const c = useStore.getState().conference
      if (!c || !(e.metaKey || e.ctrlKey)) return
      if (e.key === 'd') { e.preventDefault(); c.setMicMuted(!c.micMuted) }
      if (e.key === 'e') { e.preventDefault(); c.setCamOff(!c.camOff) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  if (!account) return <><div className="drag" /><Login />{toast && <div className="toast">{toast}</div>}</>
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0)

  return (
    <div className={`shell ${window.native?.platform === 'darwin' ? 'mac' : ''}`}>
      <div className="drag" />
      <nav className="rail">
        <Avatar name={account.displayName || account.trueconfId} id={account.trueconfId} size={36} presence="online" />
        {NAV.map(([key, Icon, label]) => (
          <button key={key} className={`rail-btn ${tab === key ? 'active' : ''}`} title={label} onClick={() => set({ tab: key })}>
            <Icon size={21} />
            {key === 'chats' && totalUnread > 0 && <span className="badge">{totalUnread}</span>}
            {key === 'meet' && conference && <span className="live-dot" />}
          </button>
        ))}
        <div className="grow" />
        <button className="rail-btn" title="Тема" onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button>
        <button className="rail-btn" title="Выйти" onClick={logout}><LogOut size={19} /></button>
      </nav>
      <main className="content">
        {tab === 'chats' && <><ChatList /><ChatView /><MembersPanel /></>}
        {tab === 'contacts' && <Contacts />}
        {tab === 'meet' && <Meet />}
        {tab === 'settings' && <Settings />}
      </main>
      {conference && tab !== 'meet' && (
        <button className="mini-call" onClick={() => set({ tab: 'meet' })}><span className="live-dot static" /> {conference.topic || 'Конференция'} — вернуться</button>
      )}
      <ScreenPicker />
      <Dialogs />
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
