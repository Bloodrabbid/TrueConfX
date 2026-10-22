import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

export function Settings() {
  const { devices, set, account, server, client, conference, logout } = useStore()
  const [list, setList] = useState<MediaDeviceInfo[]>([])
  const [level, setLevel] = useState(0)
  const [status, setStatus] = useState('')
  const raf = useRef(0)

  useEffect(() => {
    let stream: MediaStream | undefined
    navigator.mediaDevices.getUserMedia({ audio: devices.audioIn ? { deviceId: devices.audioIn } : true }).then(async s => {
      stream = s
      setList(await navigator.mediaDevices.enumerateDevices())
      // Индикатор громкости микрофона.
      const ctx = new AudioContext()
      const an = ctx.createAnalyser()
      ctx.createMediaStreamSource(s).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); setLevel(m / 128); raf.current = requestAnimationFrame(tick) }
      tick()
    }).catch(async () => setList(await navigator.mediaDevices.enumerateDevices()))
    return () => { cancelAnimationFrame(raf.current); stream?.getTracks().forEach(t => t.stop()) }
  }, [devices.audioIn])

  const pick = (kind: 'audioIn' | 'videoIn' | 'audioOut', id: string) => {
    set({ devices: { ...devices, [kind]: id } })
    if (conference && kind !== 'audioOut') conference.switchDevice(kind === 'audioIn' ? 'audio' : 'video', id)
    if (kind === 'audioOut') document.querySelectorAll('video').forEach(v => (v as any).setSinkId?.(id))
  }
  const sel = (kind: MediaDeviceKind, key: 'audioIn' | 'videoIn' | 'audioOut', label: string) => (
    <label>{label}
      <select value={devices[key] ?? ''} onChange={e => pick(key, e.target.value)}>
        <option value="">По умолчанию</option>
        {list.filter(d => d.kind === kind && d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>)}
      </select>
    </label>
  )

  return (
    <div className="page settings">
      <div className="pane-head"><h2>Настройки</h2></div>
      <div className="card">
        <h3>Учётная запись</h3>
        <p><b>{account?.displayName}</b> <span className="muted">{account?.trueconfId}</span></p>
        <div className="server-row">
          <span className="muted small">Сервер <b>{server}</b> · протокол v{client?.protocolVersion}</span>
          <button className="ghost small-btn" onClick={() => { if (confirm('Выйти и войти на другой сервер?')) logout() }}>Сменить сервер</button>
        </div>
        <div className="invite"><input placeholder="Текстовый статус: «на встрече до 15:00»" value={status} onChange={e => setStatus(e.target.value)} />
          <button className="primary small" onClick={() => client?.setStatusText(status)}>Сохранить</button></div>
      </div>
      <div className="card">
        <h3>Звук и видео</h3>
        {sel('audioinput', 'audioIn', 'Микрофон')}
        <div className="meter"><div style={{ width: `${Math.min(100, level * 220)}%` }} /></div>
        {sel('audiooutput', 'audioOut', 'Динамики')}
        {sel('videoinput', 'videoIn', 'Камера')}
      </div>
    </div>
  )
}
