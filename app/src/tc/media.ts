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

// Opus: FEC переживает потерю пакетов, DTX не шлёт тишину, моно 48 кГц для голоса.
export function tuneOpus(sdp: string) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1]
  if (!pt) return sdp
  return sdp.replace(new RegExp(`a=fmtp:${pt} (.*)`), (_m, params: string) => {
    const kv = new Map(params.split(';').map(x => x.trim().split('=') as [string, string]))
    kv.set('useinbandfec', '1'); kv.set('usedtx', '1'); kv.set('stereo', '0')
    return `a=fmtp:${pt} ${[...kv].map(([k, v]) => `${k}=${v}`).join(';')}`
  })
}

export type Quality = 'good' | 'fair' | 'poor'
export interface NetStats { rttMs?: number; lossPct: number; outKbps: number; inKbps: number; fpsIn?: number; fpsOut?: number; quality: Quality; codec?: string }

// Раз в 2 секунды — RTT, потери, скорость в обе стороны и итоговая оценка.
export function sampleStats(pc: RTCPeerConnection, onStats: (s: NetStats) => void) {
  let prev: { t: number; out: number; inb: number; lost: number; recv: number } | undefined
  const timer = setInterval(async () => {
    if (pc.connectionState === 'closed') { clearInterval(timer); return }
    const r = await pc.getStats().catch(() => undefined)
    if (!r) return
    let out = 0, inb = 0, lost = 0, recv = 0, rtt: number | undefined, fpsIn: number | undefined, fpsOut: number | undefined, codecId: string | undefined
    r.forEach((s: any) => {
      if (s.type === 'outbound-rtp') { out += s.bytesSent ?? 0; if (s.kind === 'video') { fpsOut = s.framesPerSecond; codecId = s.codecId } }
      if (s.type === 'inbound-rtp') { inb += s.bytesReceived ?? 0; lost += s.packetsLost ?? 0; recv += s.packetsReceived ?? 0; if (s.kind === 'video') fpsIn = s.framesPerSecond }
      if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime !== undefined) rtt = s.currentRoundTripTime * 1000
    })
    const codec = codecId ? (r.get(codecId) as any)?.mimeType?.split('/')[1] : undefined
    const t = performance.now()
    if (prev) {
      const dt = (t - prev.t) / 1000
      const dLost = lost - prev.lost, dRecv = recv - prev.recv
      const lossPct = dLost + dRecv > 0 ? (100 * dLost) / (dLost + dRecv) : 0
      const quality: Quality = lossPct > 8 || (rtt ?? 0) > 400 ? 'poor' : lossPct > 2 || (rtt ?? 0) > 200 ? 'fair' : 'good'
      onStats({ rttMs: rtt, lossPct, outKbps: ((out - prev.out) * 8) / 1000 / dt, inKbps: ((inb - prev.inb) * 8) / 1000 / dt, fpsIn, fpsOut, quality, codec })
    }
    prev = { t, out, inb, lost, recv }
  }, 2000)
  return () => clearInterval(timer)
}
