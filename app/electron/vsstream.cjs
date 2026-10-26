'use strict'
// Нативный медиапоток TrueConf (план А): отдельное TCP-соединение к серверу конференции :4307.
// Разбор бинаря 8.3.2 — ~/Documents/TrueConf-RE/SPEC-native-media.md (этапы 1 и 2).
//
// Рукопожатие «_VS_STREAMS_» (клиент шлёт первым, до него на сокете ничего нет):
//   20 Б заголовка net_handshake (как у преамбулы основной сессии, FUN_1001ac410) + тело FUN_1001ba500.
// После ответа сервера — пакеты: [u16 длина][u32 время мс][u8 трек][u8 сумма] + нагрузка (FUN_1001bbd80).
// LIVE-PENDING: ответ сервера и пакеты на проводе ещё не видели — этот модуль и снимает их живьём.
const net = require('net')
const fs = require('fs')

const STREAMS_MAGIC = '_VS_STREAMS_'
const DEFAULT_TRACKS = [1, 2, 0xff, 5, 0xfe] // FUN_10015dbe0: hs+0x868 = 01 02 FF 05 FE
const STREAM_SENDER = 1
const STREAM_RECEIVER = 2

// Контрольные суммы заголовка net_handshake (FUN_1001ac410). buf — заголовок+тело, в [16..19] уже
// стоят версия (биты 0–4) и длина тела − 1 (биты 19–31); суммы вписываются в биты 5–12 и 13–18.
function finalizeHandshake (input) {
  const buf = Buffer.from(input)
  const u = buf.readUInt32LE(16)
  const total = (u >>> 19) + 0x15
  let acc = 0xca
  for (let i = 0x14; i < total; i += 3) acc += buf[i] - i
  const bodyCk = acc & 0x3f
  let sum = 0
  for (let i = 0; i < 16; i++) sum += buf[i]
  const head = ((sum + (u & 0x1f) + (u >>> 19) + bodyCk) * 0x20 + 0x1580) & 0x1fe0
  buf.writeUInt32LE(((u & 0xfff8001f) | head | (bodyCk << 13)) >>> 0, 16)
  return buf
}

const pstr = s => { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([Buffer.from([b.length]), b, Buffer.from([0])]) }

function trackMask (tracks) {
  const mask = Buffer.alloc(32)
  for (const t of tracks) mask[t >> 3] |= 1 << (t & 7)
  return mask
}

// Запрос потока. type: STREAM_SENDER | STREAM_RECEIVER; на проводе байт 0/1 (FUN_1001ba500).
function buildStreamsRequest ({ conf, s, r, ep = s, type, tracks = DEFAULT_TRACKS }) {
  const body = Buffer.concat([
    Buffer.from([type === STREAM_SENDER ? 0 : 1]),
    pstr(conf), pstr(s), pstr(r), pstr(ep),
    Buffer.from([tracks.length]), trackMask(tracks)
  ])
  const head = Buffer.alloc(20)
  head.write(STREAMS_MAGIC, 0, 'latin1')
  head.writeUInt32LE((((body.length - 1) << 19) | 1) >>> 0, 16)
  return finalizeHandshake(Buffer.concat([head, body]))
}

// Ответ сервера (FUN_1001ba4b0). null — данных ещё мало.
function parseStreamsResponse (buf) {
  if (buf.length < 20) return null
  const u = buf.readUInt32LE(16)
  const len = (u >>> 19) + 0x15
  if (buf.length < len) return null
  const magic = buf.subarray(0, 16).toString('latin1').replace(/\0+$/, '')
  const body = buf.subarray(20, len)
  const ok = body.length >= 1 && (body[0] & 1) === 1
  let tracks = null
  if (body.length >= 34 && body[1] !== 0xff) {
    tracks = []
    for (let t = 0; t < 256; t++) if (body[2 + (t >> 3)] & (1 << (t & 7))) tracks.push(t)
  }
  return { magic, version: u & 0x1f, length: len, ok, tracks, rest: buf.subarray(len) }
}

// Сумма нагрузки пакета (FUN_1001ba380): 0xAC + байты с шагом 0xEA, по модулю 256.
function payloadChecksum (p) {
  let c = 0xac
  for (let i = 0; i < p.length; i += 0xea) c += p[i]
  return c & 0xff
}

function buildPacket (track, timeMs, payload) {
  const h = Buffer.alloc(8)
  h.writeUInt16LE(payload.length, 0)
  h.writeUInt32LE(timeMs >>> 0, 2)
  h[6] = track
  h[7] = payloadChecksum(payload)
  return Buffer.concat([h, payload])
}

// Резать поток на пакеты по u16+8 (FUN_10007aee0). Возвращает { packets, rest }.
function splitPackets (buf) {
  const packets = []
  let off = 0
  while (buf.length - off >= 8) {
    const len = buf.readUInt16LE(off)
    if (buf.length - off < len + 8) break
    const payload = buf.subarray(off + 8, off + 8 + len)
    packets.push({ len, time: buf.readUInt32LE(off + 2), track: buf[off + 6], sum: buf[off + 7], sumOk: payloadChecksum(payload) === buf[off + 7], payload })
    off += len + 8
  }
  return { packets, rest: buf.subarray(off) }
}

// Пробный поток: рукопожатие, затем запись сырых байт в файл и сводка по трекам в log.
// Ничего не отправляет после рукопожатия. Закрывается через maxMs или по close().
function probeStream ({ host, port = 4307, conf, s, r, ep, type, dumpPath, log = () => {}, maxMs = 60000 }) {
  const req = buildStreamsRequest({ conf, s, r, ep, type })
  const sock = net.connect(port, host)
  const out = dumpPath ? fs.createWriteStream(dumpPath) : null
  let buf = Buffer.alloc(0)
  let shaken = false
  const stats = {}
  const t0 = Date.now()
  const timer = setTimeout(() => sock.destroy(), maxMs)
  sock.on('connect', () => { log({ ev: 'stream-connect', type, reqLen: req.length }); sock.write(req) })
  sock.on('data', d => {
    out?.write(d)
    buf = Buffer.concat([buf, d])
    if (!shaken) {
      const r = parseStreamsResponse(buf)
      if (!r) return
      shaken = true
      log({ ev: 'stream-answer', type, magic: r.magic, version: r.version, length: r.length, ok: r.ok, tracks: r.tracks, head: buf.subarray(0, Math.min(r.length, 64)).toString('hex') })
      buf = r.rest
    }
    const { packets, rest } = splitPackets(buf)
    buf = rest
    for (const p of packets) {
      const st = stats[p.track] ??= { n: 0, bytes: 0, bad: 0, first: null }
      st.n++; st.bytes += p.len; if (!p.sumOk) st.bad++
      if (!st.first) { st.first = p.payload.subarray(0, 48).toString('hex'); log({ ev: 'stream-first', type, track: p.track, len: p.len, sumOk: p.sumOk, head: st.first }) }
    }
  })
  sock.on('error', e => log({ ev: 'stream-error', type, err: String(e.message) }))
  sock.on('close', () => {
    clearTimeout(timer); out?.end()
    log({ ev: 'stream-close', type, ms: Date.now() - t0, shaken, stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { n: v.n, bytes: v.bytes, bad: v.bad }])) })
  })
  return { close: () => sock.destroy() }
}

// Сервер конференции: «000f…@tc3.t2.ru#vcs» → «tc3.t2.ru».
function confHost (conference) {
  const at = String(conference || '').indexOf('@')
  return at < 0 ? '' : String(conference).slice(at + 1).split('#')[0]
}

module.exports = {
  STREAM_SENDER, STREAM_RECEIVER, DEFAULT_TRACKS,
  finalizeHandshake, buildStreamsRequest, parseStreamsResponse,
  payloadChecksum, buildPacket, splitPackets, probeStream, confHost
}
