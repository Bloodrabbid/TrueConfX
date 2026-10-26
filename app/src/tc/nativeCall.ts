// P2P-звонок «человек → человек» поверх нативной сессии TrueConf :4307.
// Сигналинг (Invite/Accept/Hangup, обмен SDP/ICE) идёт через IPC-мост в main-процесс
// (window.native.call / onCallEvent), медиа — обычный WebRTC здесь, в renderer.
//
// В веб-протоколе сервера таких звонков нет (там только конференции, см. conference.ts) —
// поэтому отдельный путь. Конференции остаются на web-пути.
//
// LIVE-PENDING (помечено, уточняется одним тестовым звонком с хуком, см. SPEC-native-calls.md):
//   - кто первым шлёт offer (здесь: инициатор после Accept) и Type 0=offer/1=answer.
// ПОДТВЕРЖДЕНО живым кадром 26.10.2026: в SendWebrtcMsg id = экземпляр ОТПРАВИТЕЛЯ,
// to конверта = экземпляр получателя. Экземпляр пира узнаём из id его входящих сообщений.
import type { NativeCallEvent, NativeCallKind } from '../native.d'

export type NativeCallState = 'idle' | 'calling' | 'ringing' | 'incoming' | 'connecting' | 'live' | 'ended'
export interface SelfInfo { callId: string; instance: string; displayName: string; appId?: string }
export interface CallMedia { audio: boolean; video: boolean; audioDeviceId?: string; videoDeviceId?: string }

type Events = {
  state: (s: NativeCallState, reason?: string) => void
  incoming: (info: { conference: string; caller: string; audioOnly: boolean }) => void
  remoteStream: (s: MediaStream) => void
  localStream: (s: MediaStream) => void
}

const STUN_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.trueconf.ru:3478' }]

export class NativeCall {
  state: NativeCallState = 'idle'
  conference = ''
  peer = ''
  // Полный экземпляр пира (user@srv/inst) — из поля id его SDP/ICE; до этого шлём на callId.
  private peerInstance = ''
  private pc?: RTCPeerConnection
  private local?: MediaStream
  private ice: RTCIceServer[] = []
  private initiator = false
  private offerSent = false
  private pendingRemote: NativeCallEvent[] = []
  private offItems: Array<() => void> = []
  private handlers: { [K in keyof Events]?: Set<Events[K]> } = {}

  constructor(private self: SelfInfo) {
    const n = window.native
    if (n?.onCallEvent) this.offItems.push(n.onCallEvent(ev => this.onSignal(ev)))
    if (n?.onCallIceServers) this.offItems.push(n.onCallIceServers(list => { if (list?.length) this.ice = list }))
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]) {
    ;(this.handlers[ev] ??= new Set() as any).add(fn)
    return () => this.handlers[ev]?.delete(fn as any)
  }
  private emit<K extends keyof Events>(ev: K, ...a: Parameters<Events[K]>) {
    this.handlers[ev]?.forEach(fn => (fn as any)(...a))
  }
  private setState(s: NativeCallState, reason?: string) { this.state = s; this.emit('state', s, reason) }

  private send(kind: NativeCallKind, args: Record<string, any>) {
    return window.native?.call?.(kind, args) ?? Promise.resolve({ ok: false, error: 'нет моста' })
  }

  // Исходящий звонок: создаём P2P-конференцию, затем приглашаем пира.
  async start(peer: string, media: CallMedia) {
    this.initiator = true
    this.peer = peer
    await this.openMedia(media)
    this.setState('calling')
    // conference id придёт в событии 'created'; далее шлём Invite
    await this.send('createConference', { name: '', chatId: '' })
  }

  // Принять входящий звонок (после события 'incoming').
  // Accept уходит в любом случае: без камеры — только звук, без звука — без своего медиа.
  // Name = экземпляр звонящего (из Invite), AppId не шлём — так делает оф. клиент (FUN_1002bec60).
  async answer(media: CallMedia) {
    this.initiator = false
    this.setState('connecting')
    const r = await this.send('accept', { conference: this.conference, caller: this.peer, me: this.self.callId })
    if (!r?.ok) { this.cleanup(`Accept не ушёл: ${r?.error ?? 'нет ответа'}`); return }
    try { await this.openMedia(media) } catch (e: any) {
      try { await this.openMedia({ ...media, video: false }) } catch { this.mediaError = String(e?.message ?? e) }
    }
    this.setupPc()
  }

  mediaError = ''

  async reject() {
    await this.send('reject', { conference: this.conference, caller: this.peer, me: this.self.callId, cause: 0 })
    this.cleanup('rejected')
  }

  async hangup() {
    if (this.conference) await this.send('hangup', { conference: this.conference, me: this.self.callId })
    this.cleanup('hangup')
  }

  micMuted = false
  camOff = false
  setMicMuted(muted: boolean) { this.micMuted = muted; this.local?.getAudioTracks().forEach(t => { t.enabled = !muted }) }
  setCamOff(off: boolean) { this.camOff = off; this.local?.getVideoTracks().forEach(t => { t.enabled = !off }) }

  dispose() { this.offItems.forEach(f => f()); this.offItems = []; this.cleanup('dispose') }

  // Адресация SendWebrtcMsg: id — свой экземпляр, to — экземпляр пира.
  private route() { return { id: this.self.instance, to: this.peerInstance || this.peer } }

  // --- приём сигналинга ---
  private async onSignal(ev: NativeCallEvent) {
    if ((ev.kind === 'sdp' || ev.kind === 'candidate') && ev.id) this.peerInstance = ev.id
    switch (ev.kind) {
      case 'created':
        if (this.initiator) {
          this.conference = ev.conference
          await this.send('invite', { conference: this.conference, peer: this.peer, myName: this.self.displayName })
        }
        break
      case 'invite':
        this.conference = ev.conference; this.peer = ev.caller
        this.setState('incoming')
        this.emit('incoming', { conference: ev.conference, caller: ev.caller, audioOnly: ev.audioOnly })
        // Как оф. клиент: сразу сообщаем серверу «звонит» (CallId = мы, CallID2 = звонящий).
        this.send('ringing', { conference: ev.conference, me: this.self.callId, caller: ev.caller })
        break
      case 'accept':
        // Пир принял — инициатор создаёт offer. LIVE-PENDING: подтвердить направление.
        if (this.initiator) { this.setupPc(); await this.makeOffer() }
        break
      case 'reject': this.cleanup('отклонён'); break
      case 'hangup': this.cleanup('завершён'); break
      case 'sdp': await this.onRemoteSdp(ev); break
      case 'candidate': await this.onRemoteCandidate(ev); break
    }
  }

  private async openMedia(media: CallMedia) {
    const constraints: MediaStreamConstraints = {
      audio: media.audio ? (media.audioDeviceId ? { deviceId: media.audioDeviceId } : true) : false,
      video: media.video ? (media.videoDeviceId ? { deviceId: media.videoDeviceId } : true) : false
    }
    this.local = await navigator.mediaDevices.getUserMedia(constraints)
    this.emit('localStream', this.local)
  }

  private setupPc() {
    if (this.pc) return
    const pc = new RTCPeerConnection({ iceServers: this.ice.length ? this.ice : STUN_FALLBACK, bundlePolicy: 'max-bundle' })
    this.pc = pc
    for (const track of this.local?.getTracks() ?? []) pc.addTrack(track, this.local!)
    const remote = new MediaStream()
    pc.ontrack = e => { remote.addTrack(e.track); this.emit('remoteStream', remote) }
    pc.onicecandidate = e => {
      if (!e.candidate) return
      this.send('candidate', {
        candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid ?? '0',
        mLineIndex: e.candidate.sdpMLineIndex ?? 0,
        conference: this.conference, ...this.route()
      })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.setState('live')
      else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.cleanup('разрыв связи')
    }
    // отложенные remote-сообщения, пришедшие до создания pc
    const q = this.pendingRemote; this.pendingRemote = []
    q.forEach(ev => this.onSignal(ev))
  }

  private async makeOffer() {
    if (!this.pc || this.offerSent) return
    this.offerSent = true
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await this.send('sdp', { sdp: offer.sdp, type: 0 /* WEBRTC_OFFER, LIVE-PENDING */, conference: this.conference, ...this.route() })
  }

  private async onRemoteSdp(ev: Extract<NativeCallEvent, { kind: 'sdp' }>) {
    if (!this.pc) { this.pendingRemote.push(ev); this.setupPc() }
    const pc = this.pc!
    await pc.setRemoteDescription({ type: ev.sdpType, sdp: ev.sdp })
    if (ev.sdpType === 'offer') {
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await this.send('sdp', { sdp: answer.sdp, type: 1 /* WEBRTC_ANSWER */, conference: this.conference, ...this.route() })
    }
  }

  private async onRemoteCandidate(ev: Extract<NativeCallEvent, { kind: 'candidate' }>) {
    if (!this.pc) { this.pendingRemote.push(ev); return }
    try { await this.pc.addIceCandidate({ candidate: ev.candidate, sdpMid: ev.sdpMid, sdpMLineIndex: ev.mLineIndex }) } catch { /* кандидат до remote-описания */ }
  }

  private cleanup(reason: string) {
    this.pc?.close(); this.pc = undefined
    this.local?.getTracks().forEach(t => t.stop()); this.local = undefined
    this.offerSent = false; this.pendingRemote = []; this.peerInstance = ''
    if (this.state !== 'ended') this.setState('ended', reason)
  }
}
