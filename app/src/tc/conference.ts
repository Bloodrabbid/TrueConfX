// Участие в конференции TrueConf через WebRTC.
// Сервер — MCU: присылает одну сведённую видеодорожку и одну аудиодорожку,
// а раскладку участников на кадре — отдельным сообщением webrtc{type:"layout"}.
import type { TCClient } from './client'
import type { Frame } from './socket'
import { toRtcConfig } from './turn'

export const REJECT: Record<number, string> = {
  12: 'Нужен пароль конференции', 13: 'Неверный пароль конференции', 401: 'Конференция не найдена',
}
export const REACTION = { NONE: 0, HAND: 1, YES: 2, NO: 3, LAUGH: 4, APPLAUD: 5, AWAY: 6 } as const
export const ROLE = ['Участник', 'Участник', 'Ведущий', 'Трибуна', 'Докладчик', 'Слушатель']

export interface Participant {
  trueconfId: string
  displayname: string
  role: number
  isOperator?: boolean
  pinned?: boolean
  deviceStatus?: number
  reaction?: number
}
export interface LayoutCell { id: string; rect: [number, number, number, number]; priority?: boolean }
export interface Layout { width: number; height: number; list: LayoutCell[] }

export type ConfState = 'joining' | 'connecting' | 'live' | 'ended'

type Events = {
  state: (s: ConfState, reason?: string) => void
  remoteStream: (s: MediaStream) => void
  participants: (list: Participant[]) => void
  layout: (l: Layout) => void
  reactions: (m: Map<string, number>) => void
  remoteMute: (kind: 'mic' | 'cam', on: boolean) => void
  recording: (on: boolean) => void
}

// Статус устройства участника: старшие 16 бит — видео, младшие — звук. 0 = работает.
export const micOn = (p: Participant) => p.deviceStatus === undefined || (p.deviceStatus & 0xffff) === 0
export const camOn = (p: Participant) => p.deviceStatus === undefined || p.deviceStatus >>> 16 === 0

export class Conference {
  state: ConfState = 'joining'
  streamId = ''
  chatId = ''
  topic = ''
  owner = ''
  permissions = 0
  pc?: RTCPeerConnection
  remote = new MediaStream()
  participants = new Map<string, Participant>()
  reactions = new Map<string, number>()
  micMuted = false
  camOff = false
  sharing = false
  layout?: Layout
  recording = false

  private mic?: MediaStreamTrack
  private cam?: MediaStreamTrack
  private screen?: MediaStreamTrack
  private videoSender?: RTCRtpSender
  private audioSender?: RTCRtpSender
  private offs: (() => void)[] = []
  private listeners: { [K in keyof Events]?: Set<Events[K]> } = {}
  private makingOffer = false
  private pendingCandidates: RTCIceCandidateInit[] = []

  constructor(private client: TCClient, public conferenceId: string, private password = '') {}

  on<K extends keyof Events>(ev: K, fn: Events[K]) {
    ;(this.listeners[ev] ??= new Set() as any).add(fn)
    return () => this.listeners[ev]!.delete(fn as any)
  }
  private emit<K extends keyof Events>(ev: K, ...a: Parameters<Events[K]>) { this.listeners[ev]?.forEach(fn => (fn as any)(...a)) }
  private setState(s: ConfState, reason?: string) { this.state = s; this.emit('state', s, reason) }

  private send(f: Frame) { this.client.sock.send({ ...f, CID: this.client.cid }) }

  // ── Вход ─────────────────────────────────────────────────────────────
  async join(media: { audio: boolean; video: boolean; audioDeviceId?: string; videoDeviceId?: string }) {
    const sock = this.client.sock
    this.wire()
    // Сервер может прислать ограничение битрейта раньше, чем мы его ждём.
    const restrict = sock.request(null, 'webrtc', f => f.type === 'restrictBitrate', 20000).catch(() => null)

    const res = await sock.request(
      { method: 'join', conferenceId: this.conferenceId.replace(/^\\c\\/, ''), Password: this.password, simulcastSupported: false, CID: this.client.cid },
      'conferenceStateChange', f => f.conference?.message === 'joinResponse' || f.conference?.message === 'deleteConference', 20000)
    const c = res.conference
    if (c.message !== 'joinResponse' || c.lastRejectReason !== 6) {
      const reason = REJECT[c.lastRejectReason] ?? `Сервер отказал во входе (код ${c.lastRejectReason})`
      this.setState('ended', reason)
      this.dispose()
      throw Object.assign(new Error(reason), { code: c.lastRejectReason })
    }
    Object.assign(this, { streamId: c.streamConferenceId, chatId: c.chatId, topic: c.topic ?? '', owner: c.owner ?? '', permissions: c.cmr_flags ?? 0 })
    if (Array.isArray(res.commands)) {
      if (res.commands.includes('remote:mic_off')) this.micMuted = true
      if (res.commands.includes('remote:cam_off')) this.camOff = true
    }
    this.setState('connecting')

    const ice = await sock.request({ method: 'getIceConfig', streamConferenceId: this.streamId }, 'getIceConfig')
    const config = await toRtcConfig(ice as any, this.client.cid, this.streamId)

    const local = await navigator.mediaDevices.getUserMedia({
      audio: media.audio ? { deviceId: media.audioDeviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      video: media.video ? { deviceId: media.videoDeviceId, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
    }).catch(() => new MediaStream())
    this.mic = local.getAudioTracks()[0]
    this.cam = local.getVideoTracks()[0]

    await restrict
    this.createPeer(config)
    this.send({ method: 'connectMedia', streamConferenceId: this.streamId, type: 1 })
    this.reportDevices()
    this.send({ method: 'getConferenceReactions', streamConferenceId: this.streamId })
  }

  get localVideo(): MediaStreamTrack | undefined { return this.sharing ? this.screen : this.camOff ? undefined : this.cam }

  private createPeer(config: RTCConfiguration) {
    const pc = new RTCPeerConnection(config)
    this.pc = pc
    // Приём: «пустые» трансиверы на звук и видео, как у оригинального клиента.
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.addTransceiver('video', { direction: 'recvonly' })
    // Отдача: отдельные sendonly-трансиверы.
    if (this.mic) { this.mic.enabled = !this.micMuted; this.audioSender = pc.addTransceiver(this.mic, { direction: 'sendonly' }).sender }
    if (this.cam) { this.cam.enabled = !this.camOff; this.videoSender = pc.addTransceiver(this.cam, { direction: 'sendonly' }).sender }

    pc.ontrack = e => {
      if (!this.remote.getTracks().includes(e.track)) this.remote.addTrack(e.track)
      this.emit('remoteStream', this.remote)
    }
    pc.onicecandidate = e => {
      if (!e.candidate) return
      this.send({ method: 'webrtc', type: 'candidate', candidate: e.candidate.candidate, sdpMLineIndex: e.candidate.sdpMLineIndex, sdpMid: e.candidate.sdpMid, my_peer_id: this.client.account!.instance, conf_id: this.streamId })
    }
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        this.send({ method: 'webrtc', type: 'offer', sdp: pc.localDescription!.sdp, conf_id: this.streamId, browser: navigator.userAgent, my_peer_id: this.client.account!.instance })
      } finally { this.makingOffer = false }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && this.state !== 'live') this.setState('live')
      if (pc.connectionState === 'failed') this.setState('ended', 'Медиасоединение не установилось')
    }
  }

  // Совместимо с «вежливой» стороной perfect negotiation: при встречном offer откатываем свой.
  private async onWebrtc(f: Frame) {
    const pc = this.pc
    if (f.type === 'layout') { this.layout = { width: f.width, height: f.height, list: f.list ?? [] }; this.emit('layout', this.layout); return }
    if (!pc) return
    if (f.type === 'answer' || f.type === 'offer') {
      const collision = f.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable')
      if (collision) await pc.setLocalDescription({ type: 'rollback' })
      await pc.setRemoteDescription({ type: f.type, sdp: f.sdp })
      for (const c of this.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {})
      if (f.type === 'offer') {
        await pc.setLocalDescription()
        this.send({ method: 'webrtc', type: 'answer', sdp: pc.localDescription!.sdp, conf_id: this.streamId, browser: navigator.userAgent, my_peer_id: this.client.account!.instance })
      }
    } else if (f.type === 'candidate' && f.candidate) {
      const c = { candidate: f.candidate, sdpMid: f.sdpMid, sdpMLineIndex: f.sdpMLineIndex }
      if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {})
      else this.pendingCandidates.push(c)
    } else if (f.type === 'negotiation') {
      pc.dispatchEvent(new Event('negotiationneeded'))
    }
  }

  private wire() {
    const s = this.client.sock
    this.offs.push(
      s.on('webrtc', f => { this.onWebrtc(f).catch(e => console.warn('webrtc', e)) }),
      s.on('sendPartsList', f => this.onParts(f)),
      s.on('conferenceStateChange', f => {
        if (f.conference?.message === 'deleteConference' && this.state !== 'joining') {
          this.setState('ended', f.conference.terminationCause === 15 ? 'Конференцию завершил администратор' : 'Конференция завершена')
          this.dispose()
        }
      }),
      s.on('changeConferenceReaction', f => {
        for (const r of f.reactions ?? []) r.reaction ? this.reactions.set(r.userId, r.reaction) : this.reactions.delete(r.userId)
        this.emit('reactions', new Map(this.reactions))
      }),
      s.on('getConferenceReactions', f => {
        this.reactions = new Map((f.reactions ?? []).filter((r: any) => r[1]))
        this.emit('reactions', new Map(this.reactions))
      }),
      s.on('command', f => {
        const cmd = String(f.command ?? '')
        if (cmd === 'remote:mic_off') { this.setMicMuted(true); this.emit('remoteMute', 'mic', false) }
        if (cmd === 'remote:mic_on') this.emit('remoteMute', 'mic', true)
        if (cmd === 'remote:cam_off') { this.setCamOff(true); this.emit('remoteMute', 'cam', false) }
        if (cmd === 'remote:cam_on') this.emit('remoteMute', 'cam', true)
      }),
      s.on('setDeviceState', f => { if (f.Type === 'microphone' && typeof f.Mute === 'boolean') this.setMicMuted(f.Mute) }),
      s.on('updateConfRecordingState', f => { this.recording = !!f.RecordingState; this.emit('recording', this.recording) }),
      s.on('stopContentSharing', () => this.stopScreenShare()),
    )
  }

  private onParts(f: Frame) {
    const map = (p: any): Participant => ({ trueconfId: p.trueconfId, displayname: p.displayname || p.trueconfId, role: p.role ?? 0, isOperator: p.IsOperator, pinned: p.Pinned, deviceStatus: p.DeviceStatus })
    const list: any[] = f.list ?? []
    if (f.type === 0 || f.type === 1) this.participants = new Map(list.map(p => [p.trueconfId, map(p)]))
    else if (f.type === 2 || f.type === 4) for (const p of list) this.participants.set(p.trueconfId, { ...this.participants.get(p.trueconfId), ...map(p) })
    else if (f.type === 3) for (const p of list) this.participants.delete(p.trueconfId)
    this.emit('participants', [...this.participants.values()])
  }

  // ── Устройства ───────────────────────────────────────────────────────
  private deviceStatus() {
    const audio = !this.mic ? 4 : this.micMuted ? 16 : 0
    const video = !this.localVideo ? 16 : 0
    return (video << 16) | audio
  }
  private reportDevices() {
    if (this.mic) this.send({ method: 'DeviceChanged', Type: 'microphone', id: this.mic.getSettings().deviceId ?? 'default', Name: this.mic.label })
    if (this.mic) this.send({ method: 'DeviceState', Type: 'microphone', id: this.mic.getSettings().deviceId ?? 'default', Name: this.mic.label, Mute: this.micMuted })
    const v = this.localVideo
    this.send({ method: 'DeviceChanged', Type: this.sharing ? 'desktop' : 'camera', id: v ? (this.sharing ? 'screen' : v.getSettings().deviceId ?? 'cam') : '', Name: v ? (this.sharing ? 'screen' : v.label) : '' })
    this.send({ method: 'DeviceStatus', value: this.deviceStatus() })
  }

  setMicMuted(muted: boolean) {
    this.micMuted = muted
    if (this.mic) this.mic.enabled = !muted
    this.send({ method: 'DeviceState', Type: 'microphone', id: this.mic?.getSettings().deviceId ?? '', Name: this.mic?.label ?? '', Mute: muted })
    this.send({ method: 'DeviceStatus', value: this.deviceStatus() })
  }

  async setCamOff(off: boolean) {
    this.camOff = off
    if (!off && (!this.cam || this.cam.readyState === 'ended')) {
      this.cam = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0]
    }
    if (!this.sharing) await this.setOutgoingVideo(off ? null : this.cam!)
    if (off && this.cam) { this.cam.stop(); this.cam = undefined }
    this.reportDevices()
  }

  private async setOutgoingVideo(track: MediaStreamTrack | null) {
    if (this.videoSender) await this.videoSender.replaceTrack(track)
    else if (track && this.pc) this.videoSender = this.pc.addTransceiver(track, { direction: 'sendonly' }).sender
  }

  async switchDevice(kind: 'audio' | 'video', deviceId: string) {
    if (kind === 'audio') {
      const t = (await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } })).getAudioTracks()[0]
      t.enabled = !this.micMuted
      this.mic?.stop(); this.mic = t
      if (this.audioSender) await this.audioSender.replaceTrack(t)
      else if (this.pc) this.audioSender = this.pc.addTransceiver(t, { direction: 'sendonly' }).sender
    } else {
      const t = (await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0]
      this.cam?.stop(); this.cam = t; this.camOff = false
      if (!this.sharing) await this.setOutgoingVideo(t)
    }
    this.reportDevices()
  }

  async startScreenShare() {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false })
    this.screen = s.getVideoTracks()[0]
    this.screen.contentHint = 'detail'
    this.screen.onended = () => this.stopScreenShare()
    this.sharing = true
    await this.setOutgoingVideo(this.screen)
    this.reportDevices()
    this.send({ method: 'VideoSourceType', Type: 2, Conference: this.streamId })
  }

  async stopScreenShare() {
    if (!this.sharing) return
    this.sharing = false
    this.screen?.stop(); this.screen = undefined
    await this.setOutgoingVideo(this.camOff ? null : this.cam ?? null)
    this.reportDevices()
    this.send({ method: 'VideoSourceType', Type: 1, Conference: this.streamId })
  }

  // ── Прочее ───────────────────────────────────────────────────────────
  setReaction(reaction: number) { this.client.sock.send({ method: 'setConferenceReaction', streamConferenceId: this.streamId, reaction }) }
  invite(trueconfId: string) { this.send({ method: 'inviteUser', UserName: trueconfId, conferenceStreamId: this.streamId }) }
  kick(trueconfId: string) { this.send({ method: 'kick', UserName: trueconfId, conferenceStreamId: this.streamId }) }
  remoteMute(trueconfId: string, kind: 'mic' | 'cam') { this.client.sock.send({ to: trueconfId, method: 'command', CID: this.client.cid, command: `remote:${kind}_off` }) }
  pin(trueconfId: string, pinned: boolean) { this.send({ method: 'PinUser', Conference: this.streamId, UserName: trueconfId, Type: 0, Pinned: pinned }) }

  hangup(forAll = false) {
    if (this.state !== 'ended') this.send({ method: 'hangup', result: forAll, conferenceId: this.conferenceId.replace(/^\\c\\/, '') })
    this.setState('ended', 'Вы вышли из конференции')
    this.dispose()
  }

  private dispose() {
    this.offs.splice(0).forEach(off => off())
    for (const t of [this.mic, this.cam, this.screen]) t?.stop()
    this.pc?.close()
    this.pc = undefined
  }
}

// Создать свою конференцию и сразу войти; так же делается «звонок» пользователю из веб-протокола.
export async function createConference(client: TCClient, topic: string, opts: { allowGuests?: boolean; waitingRoom?: boolean } = {}) {
  const r = await client.sock.request({
    method: 'createConference', topic, preset: 0, audioMute: false, videoMute: false,
    useWaitingRoom: !!opts.waitingRoom, allowGuests: opts.allowGuests ?? true, maxParticipants: 0, maxCasters: 0, CID: client.cid,
  }, 'conferenceStateChange', f => !!f.conference, 20000)
  return r.conference
}
