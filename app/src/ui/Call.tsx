// Экран нативного P2P-звонка (:4307): входящий вызов и активный разговор.
// Сигналинг — через NativeCall (store.nativeCall), медиа — WebRTC здесь.
import { useEffect, useRef, useState } from 'react'
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { useStore } from '../store'
import { Avatar } from './common'

export function CallScreen() {
  const callState = useStore(s => s.callState)
  const incomingCall = useStore(s => s.incomingCall)
  const nativeCall = useStore(s => s.nativeCall)
  if (incomingCall && callState === 'incoming') return <IncomingCall />
  if (nativeCall && callState !== 'idle' && callState !== 'ended') return <ActiveCall />
  return null
}

function IncomingCall() {
  const incomingCall = useStore(s => s.incomingCall)
  const answerCall = useStore(s => s.answerCall)
  const rejectCall = useStore(s => s.rejectCall)
  const nameOf = useStore(s => s.nameOf)
  if (!incomingCall) return null
  const who = incomingCall.displayName || nameOf(incomingCall.caller.split('/')[0]) || incomingCall.caller
  return (
    <div className="call-overlay incoming">
      <div className="call-card">
        <Avatar name={who} id={incomingCall.caller} size={72} />
        <h2>{who}</h2>
        <p className="muted">{incomingCall.audioOnly ? 'Аудиозвонок' : 'Видеозвонок'}</p>
        <div className="call-actions">
          <button className="call-btn reject" onClick={() => rejectCall()} title="Отклонить"><PhoneOff size={24} /></button>
          <button className="call-btn accept" onClick={() => answerCall({ video: !incomingCall.audioOnly })} title="Принять"><Phone size={24} /></button>
        </div>
      </div>
    </div>
  )
}

function ActiveCall() {
  const nativeCall = useStore(s => s.nativeCall)
  const callState = useStore(s => s.callState)
  const endCall = useStore(s => s.endCall)
  const peerName = useStore(s => s.nameOf(s.nativeCall?.peer ?? ''))
  const remoteRef = useRef<HTMLVideoElement>(null)
  const localRef = useRef<HTMLVideoElement>(null)
  const [, force] = useState(0)

  useEffect(() => {
    if (!nativeCall) return
    const offs = [
      nativeCall.on('remoteStream', s => { if (remoteRef.current) remoteRef.current.srcObject = s }),
      nativeCall.on('localStream', s => { if (localRef.current) localRef.current.srcObject = s }),
      nativeCall.on('state', () => force(n => n + 1))
    ]
    return () => offs.forEach(f => f())
  }, [nativeCall])

  if (!nativeCall) return null
  const status = { calling: 'Вызов…', ringing: 'Звонок…', incoming: '', connecting: 'Соединение…', live: '', idle: '', ended: 'Завершён' }[callState]
  const mic = !nativeCall.micMuted, cam = !nativeCall.camOff
  return (
    <div className="call-overlay active">
      <video ref={remoteRef} className="call-remote" autoPlay playsInline />
      {status && <div className="call-status">{peerName || nativeCall.peer} — {status}</div>}
      <video ref={localRef} className="call-local mirror" autoPlay muted playsInline />
      <div className="call-controls">
        <button className={`call-btn ${mic ? '' : 'off'}`} onClick={() => { nativeCall.setMicMuted(mic); force(n => n + 1) }} title="Микрофон">{mic ? <Mic size={20} /> : <MicOff size={20} />}</button>
        <button className={`call-btn ${cam ? '' : 'off'}`} onClick={() => { nativeCall.setCamOff(cam); force(n => n + 1) }} title="Камера">{cam ? <Video size={20} /> : <VideoOff size={20} />}</button>
        <button className="call-btn reject" onClick={() => endCall()} title="Завершить"><PhoneOff size={20} /></button>
      </div>
    </div>
  )
}
