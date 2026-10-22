import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Mic, MicOff, Video, VideoOff, MonitorUp, MonitorX, Hand, PhoneOff, Users, MessageSquare, Maximize, PictureInPicture2, Link2, Copy, Circle, Smile } from 'lucide-react'
import { useStore, parseConfLink, addSent } from '../store'
import { Conference, REACTION, ROLE, micOn, camOn, type Layout, type Participant } from '../tc/conference'
import { messageText } from '../tc/client'
import { Avatar } from './common'
import { RichText } from './RichText'

// Подписка компонента на события конференции без своего состояния.
function useConf<T>(conf: Conference, ev: any, read: () => T): T {
  const cache = useRef<{ v: T; n: number }>({ v: read(), n: 0 })
  return useSyncExternalStore(cb => conf.on(ev, () => { cache.current = { v: read(), n: cache.current.n + 1 }; cb() }), () => cache.current.v)
}

export function Meet() {
  const conference = useStore(s => s.conference)
  return conference ? <CallView conf={conference} /> : <Lobby />
}

function Lobby() {
  const { join, joinAudio, joinVideo, set, server } = useStore()
  const [link, setLink] = useState('')
  const [password, setPassword] = useState('')
  const preview = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!joinVideo) return
    let stream: MediaStream | undefined
    navigator.mediaDevices.getUserMedia({ video: true }).then(s => { stream = s; if (preview.current) preview.current.srcObject = s }).catch(() => {})
    return () => stream?.getTracks().forEach(t => t.stop())
  }, [joinVideo])

  const id = parseConfLink(link)
  return (
    <div className="page lobby">
      <div className="pane-head"><h2>Конференции</h2></div>
      <div className="lobby-grid">
        <div className="card">
          <h3>Войти в конференцию</h3>
          <p className="muted small">ID, ссылка вида https://{server}/c/… или trueconf:\c\…</p>
          <input placeholder="ID или ссылка" value={link} onChange={e => setLink(e.target.value)} onKeyDown={e => e.key === 'Enter' && id && join(id, password)} />
          <input placeholder="Пароль (если есть)" type="password" value={password} onChange={e => setPassword(e.target.value)} />
          <div className="toggles">
            <button className={`toggle ${joinAudio ? 'on' : ''}`} onClick={() => set({ joinAudio: !joinAudio })}>{joinAudio ? <Mic size={18} /> : <MicOff size={18} />} Микрофон</button>
            <button className={`toggle ${joinVideo ? 'on' : ''}`} onClick={() => set({ joinVideo: !joinVideo })}>{joinVideo ? <Video size={18} /> : <VideoOff size={18} />} Камера</button>
          </div>
          <button className="primary" disabled={!id} onClick={() => id && join(id, password)}><Link2 size={16} /> Подключиться</button>
        </div>
        <div className="card preview-card">
          {joinVideo ? <video ref={preview} autoPlay muted playsInline className="mirror" /> : <div className="preview-off"><VideoOff size={40} /><span>Камера выключена</span></div>}
        </div>
      </div>
    </div>
  )
}

const EMOJI: [number, string, string][] = [[REACTION.YES, '👍', 'Да'], [REACTION.NO, '👎', 'Нет'], [REACTION.LAUGH, '😂', 'Смешно'], [REACTION.APPLAUD, '👏', 'Аплодисменты'], [REACTION.AWAY, '☕', 'Отошёл']]
const REACTION_ICON: Record<number, string> = { [REACTION.HAND]: '✋', [REACTION.YES]: '👍', [REACTION.NO]: '👎', [REACTION.LAUGH]: '😂', [REACTION.APPLAUD]: '👏', [REACTION.AWAY]: '☕' }

function CallView({ conf }: { conf: Conference }) {
  const { leave, account, nameOf, notify } = useStore()
  const video = useRef<HTMLVideoElement>(null)
  const self = useRef<HTMLVideoElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const state = useConf(conf, 'state', () => conf.state)
  const parts = useConf(conf, 'participants', () => [...conf.participants.values()])
  const layout = useConf<Layout | undefined>(conf, 'layout', () => conf.layout)
  const reactions = useConf(conf, 'reactions', () => new Map(conf.reactions))
  const recording = useConf(conf, 'recording', () => conf.recording)
  const [, force] = useState(0)
  const [panel, setPanel] = useState<'people' | 'chat' | null>(null)
  const [emoji, setEmoji] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const offs = [
      conf.on('recording', r => { if (r) notify('Идёт запись конференции') }),
      conf.on('remoteStream', s => { if (video.current && video.current.srcObject !== s) video.current.srcObject = s }),
      conf.on('remoteMute', (kind, allowed) => notify(allowed ? `Модератор разрешил включить ${kind === 'mic' ? 'микрофон' : 'камеру'}` : `Модератор выключил ${kind === 'mic' ? 'микрофон' : 'камеру'}`)),
    ]
    if (video.current) video.current.srcObject = conf.remote
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => { offs.forEach(o => o()); clearInterval(t) }
  }, [conf, notify])

  useEffect(() => { if (self.current) self.current.srcObject = conf.localVideo ? new MediaStream([conf.localVideo]) : null })

  // Размер видимой картинки внутри <video object-fit: contain>, чтобы подписи легли на плитки.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const refresh = () => force(n => n + 1)
  const myReaction = reactions.get(account?.trueconfId ?? '') ?? 0
  const hand = myReaction === REACTION.HAND
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0'), ss = String(elapsed % 60).padStart(2, '0')

  let labels: React.ReactNode = null
  if (layout?.width && box.w) {
    const scale = Math.min(box.w / layout.width, box.h / layout.height)
    const ox = (box.w - layout.width * scale) / 2, oy = (box.h - layout.height * scale) / 2
    labels = layout.list.map(cell => {
      const [x1, y1, x2, y2] = cell.rect
      const p = conf.participants.get(cell.id)
      const r = reactions.get(cell.id)
      return (
        <div key={cell.id} className="tile-label" style={{ left: ox + x1 * scale, top: oy + y1 * scale, width: (x2 - x1) * scale, height: (y2 - y1) * scale }}>
          {r ? <span className="tile-reaction">{REACTION_ICON[r]}</span> : null}
          <span className="tile-name">{p && !micOn(p) && <MicOff size={12} />} {p?.displayname ?? nameOf(cell.id)}</span>
        </div>
      )
    })
  }

  return (
    <div className="call">
      <div className="call-main">
        <div className="call-top">
          <div><div className="title">{conf.topic || conf.conferenceId}</div><div className="muted small">{state === 'live' ? `${mm}:${ss} · ${parts.length} уч.` : state === 'connecting' ? 'Соединение…' : 'Вход…'}</div></div>
          <div className="row-actions">
            {recording && <span className="rec"><Circle size={10} fill="currentColor" /> Запись</span>}
            <button className="ghost" title="Скопировать ссылку" onClick={() => { navigator.clipboard.writeText(`https://${useStore.getState().server}/c/${conf.conferenceId}`); notify('Ссылка скопирована') }}><Copy size={17} /></button>
          </div>
        </div>
        <div className="stage" ref={stage}>
          <video ref={video} autoPlay playsInline />
          {labels}
          {state !== 'live' && <div className="stage-wait"><div className="pulse" />Подключаюсь к конференции…</div>}
          {conf.localVideo && <video ref={self} className={`self ${conf.sharing ? '' : 'mirror'}`} autoPlay muted playsInline />}
        </div>
        <div className="controls">
          <button className={`ctl ${conf.micMuted ? 'off' : ''}`} title="Микрофон (⌘D)" onClick={() => { conf.setMicMuted(!conf.micMuted); refresh() }}>{conf.micMuted ? <MicOff /> : <Mic />}</button>
          <button className={`ctl ${conf.camOff ? 'off' : ''}`} title="Камера (⌘E)" onClick={async () => { await conf.setCamOff(!conf.camOff).catch(e => notify(e.message)); refresh() }}>{conf.camOff ? <VideoOff /> : <Video />}</button>
          <button className={`ctl ${conf.sharing ? 'active' : ''}`} title="Показать экран" onClick={async () => { await (conf.sharing ? conf.stopScreenShare() : conf.startScreenShare()).catch(() => {}); refresh() }}>{conf.sharing ? <MonitorX /> : <MonitorUp />}</button>
          <button className={`ctl ${hand ? 'active' : ''}`} title="Поднять руку" onClick={() => conf.setReaction(hand ? REACTION.NONE : REACTION.HAND)}><Hand /></button>
          <div className="emoji-wrap">
            <button className="ctl" title="Реакция" onClick={() => setEmoji(!emoji)}><Smile /></button>
            {emoji && <div className="emoji-pop">{EMOJI.map(([code, e, t]) => <button key={code} title={t} onClick={() => { conf.setReaction(myReaction === code ? 0 : code); setEmoji(false) }}>{e}</button>)}</div>}
          </div>
          <span className="sep" />
          <button className={`ctl ${panel === 'people' ? 'active' : ''}`} title="Участники" onClick={() => setPanel(panel === 'people' ? null : 'people')}><Users /></button>
          <button className={`ctl ${panel === 'chat' ? 'active' : ''}`} title="Чат" onClick={() => setPanel(panel === 'chat' ? null : 'chat')}><MessageSquare /></button>
          <button className="ctl" title="Картинка в картинке" onClick={() => video.current?.requestPictureInPicture().catch(() => {})}><PictureInPicture2 /></button>
          <button className="ctl" title="Во весь экран" onClick={() => stage.current?.requestFullscreen()}><Maximize /></button>
          <button className="ctl hang" title="Выйти" onClick={leave}><PhoneOff /></button>
        </div>
      </div>
      {panel === 'people' && <People conf={conf} parts={parts} reactions={reactions} />}
      {panel === 'chat' && <ConfChat conf={conf} />}
    </div>
  )
}

function People({ conf, parts, reactions }: { conf: Conference; parts: Participant[]; reactions: Map<string, number> }) {
  const me = useStore(s => s.account?.trueconfId)
  const [invite, setInvite] = useState('')
  const iAmLeader = parts.find(p => p.trueconfId === me)?.role === 2 || conf.owner === me
  const sorted = [...parts].sort((a, b) => (reactions.get(b.trueconfId) === REACTION.HAND ? 1 : 0) - (reactions.get(a.trueconfId) === REACTION.HAND ? 1 : 0) || a.displayname.localeCompare(b.displayname, 'ru'))
  return (
    <aside className="side-panel">
      <h3>Участники · {parts.length}</h3>
      <div className="invite"><input placeholder="Пригласить: логин@сервер" value={invite} onChange={e => setInvite(e.target.value)} />
        <button className="primary small" disabled={!invite} onClick={() => { conf.invite(invite.includes('@') ? invite : `${invite}@${useStore.getState().server}`); setInvite('') }}>Позвать</button></div>
      <div className="list">
        {sorted.map(p => (
          <div className="row contact" key={p.trueconfId}>
            <Avatar name={p.displayname} id={p.trueconfId} size={32} />
            <div className="row-main"><div className="title">{p.displayname}{p.trueconfId === me && ' (вы)'}</div><div className="muted small">{ROLE[p.role] ?? ''}</div></div>
            <div className="row-actions">
              {reactions.get(p.trueconfId) ? <span>{REACTION_ICON[reactions.get(p.trueconfId)!]}</span> : null}
              {micOn(p) ? <Mic size={14} /> : <MicOff size={14} className="muted" />}
              {camOn(p) ? <Video size={14} /> : <VideoOff size={14} className="muted" />}
              {iAmLeader && p.trueconfId !== me && <button className="ghost tiny" title="Выключить микрофон" onClick={() => conf.remoteMute(p.trueconfId, 'mic')}><MicOff size={14} /></button>}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function ConfChat({ conf }: { conf: Conference }) {
  const { client, messages, nameOf } = useStore()
  const [text, setText] = useState('')
  const list = messages[conf.chatId] ?? []
  useEffect(() => {
    if (conf.chatId && client && !messages[conf.chatId])
      client.history(conf.chatId, 50).then(l => useStore.setState({ messages: { ...useStore.getState().messages, [conf.chatId]: l } })).catch(() =>
        useStore.setState({ messages: { ...useStore.getState().messages, [conf.chatId]: [] } }))
  }, [conf.chatId, client, messages])
  const send = async () => {
    const t = text.trim(); if (!t || !client) return
    setText('')
    const m = await client.sendText({ chatId: conf.chatId, chatType: 2 }, t).catch(() => null)
    addSent(conf.chatId, t, m)
  }
  return (
    <aside className="side-panel">
      <h3>Чат конференции</h3>
      <div className="list conf-chat">
        {list.map(m => messageText(m) && <div key={m.messageId} className="conf-msg"><b>{nameOf(m.sender)}</b> <RichText html={messageText(m)} /></div>)}
        {!list.length && <div className="empty">Сообщений пока нет</div>}
      </div>
      <div className="composer"><textarea rows={1} value={text} placeholder="Сообщение всем" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} /></div>
    </aside>
  )
}
