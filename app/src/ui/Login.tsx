import { useEffect, useState } from 'react'
import { Video, Loader2 } from 'lucide-react'
import { useStore } from '../store'

export function Login() {
  const { server, connecting, error, login } = useStore()
  const [srv, setSrv] = useState(server)
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [remember, setRemember] = useState(true)

  // Автовход по сохранённым данным.
  useEffect(() => {
    window.native?.loadCredentials?.().then(c => {
      if (c?.login) { setSrv(c.server); setUser(c.login); login(c.server, c.login, c.password, true) }
    })
  }, [login])

  return (
    <div className="login">
      <form className="login-card" onSubmit={e => { e.preventDefault(); login(srv.trim(), user.trim(), pass, remember) }}>
        <div className="brand"><div className="brand-mark"><Video size={18} /></div><span>TrueConfX</span></div>
        <p className="muted">Вход в корпоративный сервер видеосвязи</p>
        <label>Сервер<input value={srv} onChange={e => setSrv(e.target.value)} placeholder="tc.example.com" /></label>
        <label>Логин<input value={user} onChange={e => setUser(e.target.value)} placeholder="ivan.ivanov" autoFocus /></label>
        <label>Пароль<input type="password" value={pass} onChange={e => setPass(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Запомнить на этом устройстве</label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={connecting || !srv.trim() || !user || !pass}>
          {connecting ? <><Loader2 className="spin" size={16} /> Подключаюсь…</> : 'Войти'}
        </button>
      </form>
    </div>
  )
}
