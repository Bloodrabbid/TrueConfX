// Настройка медиапотоков: лимиты сервера, кодеки, Opus, замер качества связи.

// Источник видео в restrictBitrate: 0 — камера, 1 — демонстрация экрана.
export const SOURCE = { CAMERA: 0, DESKTOP: 1 } as const

export interface BitrateLayer { frameSize: number; maxBitrate: number; minBitrate?: number; framerate: number }
export interface BitrateConfig { sourceType: number; totalBitrate?: number; minBitrate: number; maxFrameSize: number; layerList: BitrateLayer[] }

// Как у оригинального клиента без симулкаста: первый слой, который влезает и по битрейту,
// и по размеру кадра; иначе самый маленький с урезанным битрейтом.
export function pickLayer(cfg: BitrateConfig): BitrateLayer | undefined {
  const layers = [...cfg.layerList].sort((a, b) => b.frameSize - a.frameSize)
  const fit = layers.find(l => l.maxBitrate <= cfg.minBitrate && l.frameSize <= cfg.maxFrameSize)
  if (fit) return fit
  const last = layers.at(-1)
  return last && { ...last, maxBitrate: Math.min(last.maxBitrate, cfg.minBitrate) }
}

// frameSize в протоколе — площадь кадра. Маленькие значения похожи на макроблоки 16×16.
function framePixels(frameSize: number) { return frameSize < 20000 ? frameSize * 256 : frameSize }

export async function applyVideoLimits(sender: RTCRtpSender, cfg: BitrateConfig | undefined, screen: boolean) {
  const track = sender.track
  if (!track) return
  const p = sender.getParameters()
  if (!p.encodings?.length) p.encodings = [{}]
  const enc = p.encodings[0]
  const layer = cfg && pickLayer(cfg)
  if (layer) {
    enc.maxBitrate = layer.maxBitrate
    enc.maxFramerate = screen ? Math.min(layer.framerate || 15, 15) : layer.framerate || 30
    const { width = 0, height = 0 } = track.getSettings()
    const scale = width && height ? Math.sqrt((width * height) / framePixels(layer.frameSize)) : 1
    enc.scaleResolutionDownBy = Math.max(1, Math.round(scale * 100) / 100)
  } else if (screen) {
    enc.maxFramerate = 15
  }
  // Экран: держим чёткость текста, жертвуем частотой кадров. Камера: наоборот.
  ;(p as any).degradationPreference = screen ? 'maintain-resolution' : 'maintain-framerate'
  await sender.setParameters(p).catch(e => console.warn('setParameters', e))
}

// Аппаратный H.264 (VideoToolbox, Media Foundation, VA-API) нагружает процессор меньше VP8.
// Это только порядок предпочтения: если сервер H.264 не примет, выберет другой кодек.
export function preferHardwareCodecs(t: RTCRtpTransceiver) {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs
  if (!caps || !t.setCodecPreferences) return
  const rank = (c: RTCRtpCodec) => (/h264/i.test(c.mimeType) ? (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 0 : 1) : /vp8/i.test(c.mimeType) ? 2 : 3)
  try { t.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))) } catch { /* браузер не дал — оставляем как есть */ }
}

// Повторный offer после offer сервера: Chrome даёт новым m-секциям свои номера RTP-расширений,
// и они сталкиваются с номерами сервера внутри BUNDLE — setLocalDescription падает.
// Берём номера сервера, а незнакомым расширениям раздаём свободные.
export function alignExtmap(sdp: string, remote?: string) {
  if (!remote) return sdp
  const byUri = new Map<string, number>(), used = new Set<number>()
  for (const m of remote.matchAll(/^a=extmap:(\d+)(?:\/\w+)? (\S+)/gm)) { byUri.set(m[2], +m[1]); used.add(+m[1]) }
  let next = 1
  const idFor = (uri: string) => {
    if (!byUri.has(uri)) {
      while (used.has(next)) next++
      if (next > 14) return 0
      byUri.set(uri, next); used.add(next)
    }
    return byUri.get(uri)!
  }
  return sdp.split('\r\n').flatMap(l => {
    const m = /^a=extmap:\d+((?:\/\w+)?) (\S+)(.*)$/.exec(l)
    if (!m) return [l]
    const id = idFor(m[2])
    return id ? [`a=extmap:${id}${m[1]} ${m[2]}${m[3]}`] : []
  }).join('\r\n')
}

// Отклонённые секции в ответе сервера приходят как «m=audio 0 UDP/TLS/RTP/SAVPF» без кодеков
// и без a=mid. Chrome такой SDP не разбирает. Дописываем кодек-заглушку и mid из нашего offer.
export function fixRejected(sdp: string, offer?: string) {
  const mids = [...(offer ?? '').matchAll(/^a=mid:(\S+)/gm)].map(m => m[1])
  const parts = sdp.split(/\r\n(?=m=)/)
  return parts.map((sec, i) => {
    const m = /^m=(\w+) 0 ([\w/]+)\s*$/m.exec(sec.split('\r\n')[0])
    if (!m) return sec
    const lines = sec.replace(/\r\n$/, '').split('\r\n')
    lines[0] = `m=${m[1]} 0 ${m[2]} ${m[1] === 'audio' ? 0 : 96}`
    if (!lines.some(l => l.startsWith('a=mid:')) && mids[i - 1]) lines.push(`a=mid:${mids[i - 1]}`)
    if (m[1] !== 'audio' && !lines.some(l => l.startsWith('a=rtpmap:96'))) lines.push('a=rtpmap:96 VP8/90000')
    return lines.join('\r\n') + (i === parts.length - 1 && sec.endsWith('\r\n') ? '\r\n' : '')
  }).join('\r\n')
}

export type Quality = 'good' | 'fair' | 'poor'
export interface NetStats { rttMs?: number; lossPct: number; outKbps: number; inKbps: number; fpsIn?: number; fpsOut?: number; quality: Quality; codec?: string; audioSent: boolean; audioRecv: boolean }

// Раз в 2 секунды — RTT, потери, скорость в обе стороны и итоговая оценка.
export function sampleStats(pc: RTCPeerConnection, onStats: (s: NetStats) => void) {
  let prev: { t: number; out: number; inb: number; lost: number; recv: number; aOut: number; aIn: number } | undefined
  const timer = setInterval(async () => {
    if (pc.connectionState === 'closed') { clearInterval(timer); return }
    const r = await pc.getStats().catch(() => undefined)
    if (!r) return
    let out = 0, inb = 0, lost = 0, recv = 0, rtt: number | undefined, fpsIn: number | undefined, fpsOut: number | undefined, codecId: string | undefined, aOut = 0, aIn = 0
    r.forEach((s: any) => {
      if (s.type === 'outbound-rtp') { out += s.bytesSent ?? 0; if (s.kind === 'audio') aOut += s.packetsSent ?? 0; if (s.kind === 'video') { fpsOut = s.framesPerSecond; codecId = s.codecId } }
      if (s.type === 'inbound-rtp') { inb += s.bytesReceived ?? 0; if (s.kind === 'audio') aIn += s.packetsReceived ?? 0; lost += s.packetsLost ?? 0; recv += s.packetsReceived ?? 0; if (s.kind === 'video') fpsIn = s.framesPerSecond }
      if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime !== undefined) rtt = s.currentRoundTripTime * 1000
    })
    const codec = codecId ? (r.get(codecId) as any)?.mimeType?.split('/')[1] : undefined
    const t = performance.now()
    if (prev) {
      const dt = (t - prev.t) / 1000
      const dLost = lost - prev.lost, dRecv = recv - prev.recv
      const lossPct = dLost + dRecv > 0 ? (100 * dLost) / (dLost + dRecv) : 0
      const quality: Quality = lossPct > 8 || (rtt ?? 0) > 400 ? 'poor' : lossPct > 2 || (rtt ?? 0) > 200 ? 'fair' : 'good'
      onStats({ rttMs: rtt, lossPct, outKbps: ((out - prev.out) * 8) / 1000 / dt, inKbps: ((inb - prev.inb) * 8) / 1000 / dt, fpsIn, fpsOut, quality, codec, audioSent: aOut > prev.aOut, audioRecv: aIn > prev.aIn })
    }
    prev = { t, out, inb, lost, recv, aOut, aIn }
  }, 2000)
  return () => clearInterval(timer)
}
