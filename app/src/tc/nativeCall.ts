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
  incoming: (info: { conference: string; caller: string; displayName?: string; audioOnly: boolean }) => void
  remoteStream: (s: MediaStream) => void
  localStream: (s: MediaStream) => void
}

// Типы прямого соединения VS_ConfPeer (таблица строк 0x105bcb860): 0 NO_DIRECT_CONNECT … 7 DIRECT_RTC.
const NO_DIRECT_CONNECT = 0
const DIRECT_RTC = 7
// Сколько ждать WebRTC до Accept. Звонящий в это время видит «звонит».
const RTC_WAIT_MS = 15000

const STUN_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.trueconf.ru:3478' }]

export class NativeCall {
  state: NativeCallState = 'idle'
  conference = ''
  peer = ''
  // Полный экземпляр пира (user@srv/inst) — из поля id его SDP/ICE; до этого шлём на callId.
  private peerInstance = ''
  // Завершённая конференция: её запоздавшие повторы Invite не поднимают окно снова.
  private endedConference = ''
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
    // Список мог прийти до создания звонка (сразу после входа) — забираем сохранённый.
    n?.getIceServers?.().then(list => { if (list?.length && !this.ice.length) this.ice = list }).catch(() => {})
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
  // Как оф. клиент (разбор VS_ConfPeer/VS_Conference, 26.10.2026): WebRTC поднимается ДО Accept.
  //   - FUN_1002e3d90: принимающая сторона при «RTC соединён» отмечает тип DIRECT_RTC (7) успешным;
  //   - FUN_10034e8a0: DirectConnect в Accept = лучший успешный тип;
  //   - FUN_1002b07a0: звонящий берёт DirectConnect из Accept как выбранный тип. При 7 он не рвёт
  //     WebRTC и пускает медиа через него (FUN_1002da300/FUN_1002da6f0), иначе ждёт нативные TCP-потоки.
  // Поэтому: медиа → offer → ждём connected (до RTC_WAIT_MS) → Accept с 7; не соединилось — Accept с 0.
  async answer(media: CallMedia) {
    this.initiator = false
    this.setState('connecting')
    try { await this.openMedia(media) } catch (e: any) {
      try { await this.openMedia({ ...media, video: false }) } catch { this.mediaError = String(e?.message ?? e) }
    }
    if (this.state === 'ended') { this.cleanup('ended'); return }
    this.setupPc()
    if (!this.remoteSdpSeen) await this.makeOffer()
    const rtc = await this.waitConnected(RTC_WAIT_MS)
    if ((this.state as NativeCallState) === 'ended') return
    const directConnect = rtc ? DIRECT_RTC : NO_DIRECT_CONNECT
    window.native?.callLog?.({ ev: 'accept', directConnect })
    const r = await this.send('accept', { conference: this.conference, caller: this.peer, me: this.self.callId, directConnect })
    if (!r?.ok) { this.cleanup(`Accept не ушёл: ${r?.error ?? 'нет ответа'}`); return }
    if (rtc) this.setState('live')
  }

  private waitConnected(ms: number) {
    return new Promise<boolean>(resolve => {
      const t0 = Date.now()
      const tick = () => {
        const pc = this.pc
        if (!pc || this.state === 'ended') return resolve(false)
        if (pc.connectionState === 'connected') return resolve(true)
        if (pc.connectionState === 'failed' || Date.now() - t0 >= ms) return resolve(false)
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  private remoteSdpSeen = false

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
  // Строго по очереди: повторный offer звонящего не должен накладываться на обработку предыдущего.
  private signalChain: Promise<void> = Promise.resolve()
  private onSignal(ev: NativeCallEvent) {
    this.signalChain = this.signalChain.then(() => this.handleSignal(ev)).catch(e => window.native?.callLog?.({ ev: 'signal-error', kind: ev.kind, err: String(e?.message ?? e).slice(0, 200) }))
    return this.signalChain
  }
  private async handleSignal(ev: NativeCallEvent) {
    if ((ev.kind === 'sdp' || ev.kind === 'candidate') && ev.id) this.peerInstance = ev.id
    switch (ev.kind) {
      case 'created':
        if (this.initiator) {
          this.conference = ev.conference
          await this.send('invite', { conference: this.conference, peer: this.peer, myName: this.self.displayName })
        }
        break
      case 'invite':
        // Сервер шлёт Invite дважды (Hops 4 и 5 — два маршрута): повтор той же конференции пропускаем.
        if (ev.conference === this.conference && this.state !== 'idle' && this.state !== 'ended') break
        if (ev.conference === this.endedConference) break
        // Новый звонок при незакрытом прежнем: сначала освобождаем камеру и соединение прежнего.
        if (this.pc || this.local) this.cleanup('новый звонок')
        this.conference = ev.conference; this.peer = ev.caller
        this.setState('incoming')
        this.emit('incoming', { conference: ev.conference, caller: ev.caller, displayName: ev.displayName, audioOnly: ev.audioOnly })
        // Как оф. клиент: сразу сообщаем серверу «звонит» (CallId = мы, CallID2 = звонящий).
        this.send('ringing', { conference: ev.conference, me: this.self.callId, caller: ev.caller })
        break
      case 'accept':
        // Пир принял — инициатор создаёт offer. LIVE-PENDING: подтвердить направление.
        if (this.initiator) { this.setupPc(); await this.makeOffer() }
        break
      case 'reject': this.cleanup('отклонён'); break
      case 'hangup': this.cleanup('завершён'); break
      case 'deleted': if (ev.conference === this.conference) this.cleanup(`конференция закрыта (${ev.cause})`); break
      case 'sdp': await this.onRemoteSdp(ev); break
      case 'candidate': await this.onRemoteCandidate(ev); break
    }
  }

  private async openMedia(media: CallMedia) {
    await window.native?.ensureMediaAccess?.()
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
    window.native?.callLog?.({ ev: 'ice-servers', n: this.ice.length, turn: this.ice.filter(s => String(s.urls).startsWith('turn')).length })
    this.pc = pc
    // Как у оф. клиента (журнал 26.10.2026): каждая сторона предлагает только отправку своих потоков,
    // чужие приходят его offer'ом с sendonly. Наши медиалинии sendrecv звонящий отклонял (порт 0).
    for (const track of this.local?.getTracks() ?? []) pc.addTransceiver(track, { direction: 'sendonly', streams: [this.local!] })
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
    const log = (ev: string, extra: Record<string, any> = {}) => window.native?.callLog?.({ ev, conn: pc.connectionState, ice: pc.iceConnectionState, sig: pc.signalingState, ...extra })
    pc.oniceconnectionstatechange = () => {
      log('ice')
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'failed') {
        this.logPair(pc)
        // Замер транспорта 5 раз через 2 с: идёт ли DTLS и приходят ли байты от звонящего.
        for (let i = 0; i <= 4; i++) setTimeout(() => this.logTransport(pc), i * 2000)
      }
    }
    pc.onicegatheringstatechange = () => log('gather', { gather: pc.iceGatheringState })
    pc.onsignalingstatechange = () => log('sig')
    pc.onicecandidateerror = (e: any) => log('cand-error', { code: e.errorCode, text: e.errorText, url: e.url })
    pc.onconnectionstatechange = () => {
      log('conn')
      if (pc.connectionState === 'connected' && this.state !== 'connecting') this.setState('live')
      // disconnected — временное состояние WebRTC, из него соединение восстанавливается; закрываем только failed.
      else if (pc.connectionState === 'failed') this.cleanup('разрыв связи')
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

  // Транспорт: состояние и роль DTLS, счётчики байт и пакетов (без адресов и ключей).
  private async logTransport(pc: RTCPeerConnection) {
    try {
      const st = await pc.getStats()
      st.forEach((r: any) => {
        if (r.type === 'transport') window.native?.callLog?.({ ev: 'transport', dtls: r.dtlsState, role: r.dtlsRole, ice: r.iceState, srtp: r.srtpCipher, tx: r.bytesSent, rx: r.bytesReceived, pktRx: r.packetsReceived })
        if (r.type === 'inbound-rtp') window.native?.callLog?.({ ev: 'inbound', kind: r.kind, pkts: r.packetsReceived, bytes: r.bytesReceived })
      })
    } catch {}
  }

  // Какая пара кандидатов выбрана (типы и протокол, без адресов) — в журнал.
  private async logPair(pc: RTCPeerConnection) {
    try {
      const st = await pc.getStats(); const by = new Map<string, any>(); st.forEach((r: any) => by.set(r.id, r))
      st.forEach((r: any) => { if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
        const l = by.get(r.localCandidateId), rm = by.get(r.remoteCandidateId)
        window.native?.callLog?.({ ev: 'pair', local: `${l?.candidateType}/${l?.protocol}`, remote: `${rm?.candidateType}/${rm?.protocol}` }) } })
      let pairs = 0, failed = 0; st.forEach((r: any) => { if (r.type === 'candidate-pair') { pairs++; if (r.state === 'failed') failed++ } })
      window.native?.callLog?.({ ev: 'pairs', pairs, failed })
    } catch {}
  }

  private async onRemoteSdp(ev: Extract<NativeCallEvent, { kind: 'sdp' }>) {
    this.remoteSdpSeen = true
    window.native?.callLog?.({ ev: 'remote-sdp', type: ev.sdpType, sig: this.pc?.signalingState })
    // Без постановки в очередь: setupPc проигрывает очередь, и тот же offer применился бы дважды.
    if (!this.pc) this.setupPc()
    const pc = this.pc!
    try {
      await pc.setRemoteDescription({ type: ev.sdpType, sdp: ev.sdp })
      await this.flushCandidates()
      if (ev.sdpType === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await this.send('sdp', { sdp: answer.sdp, type: 1 /* WEBRTC_ANSWER */, conference: this.conference, ...this.route() })
      }
    } catch (e: any) {
      window.native?.callLog?.({ ev: 'sdp-error', type: ev.sdpType, sig: pc.signalingState, err: String(e?.message ?? e).slice(0, 300) })
    }
  }

  // Кандидаты, пришедшие раньше удалённого описания своей линии: применяем после setRemoteDescription.
  // Раньше они выбрасывались (offer звонящего и его кандидаты приходят в одну секунду).
  private lateCandidates: Extract<NativeCallEvent, { kind: 'candidate' }>[] = []
  private async flushCandidates() {
    const q = this.lateCandidates; this.lateCandidates = []
    for (const c of q) await this.onRemoteCandidate(c)
  }

  private async onRemoteCandidate(ev: Extract<NativeCallEvent, { kind: 'candidate' }>) {
    if (!this.pc) { this.pendingRemote.push(ev); return }
    try { await this.pc.addIceCandidate({ candidate: ev.candidate, sdpMid: ev.sdpMid, sdpMLineIndex: ev.mLineIndex }) } catch (e: any) {
      // Линия ещё не известна (описание не применено) — отложить; иначе — в журнал.
      if (this.lateCandidates.length < 50 && this.lateCandidates.indexOf(ev) < 0 && !this.pc.remoteDescription?.sdp.includes(`a=mid:${ev.sdpMid}\r`)) this.lateCandidates.push(ev)
      else window.native?.callLog?.({ ev: 'cand-add-error', mid: ev.sdpMid, mline: ev.mLineIndex, err: String(e?.message ?? e).slice(0, 200) })
    }
  }

  private cleanup(reason: string) {
    window.native?.callLog?.({ ev: 'cleanup', reason, tracks: this.local?.getTracks().length ?? 0 })
    this.pc?.getSenders().forEach(s => s.track?.stop())
    this.pc?.close(); this.pc = undefined
    this.local?.getTracks().forEach(t => t.stop()); this.local = undefined
    this.offerSent = false; this.pendingRemote = []; this.peerInstance = ''; this.remoteSdpSeen = false; this.lateCandidates = []
    if (this.conference) this.endedConference = this.conference
    if (this.state !== 'ended') this.setState('ended', reason)
  }
}
