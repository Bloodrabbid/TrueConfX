// Скачивание вложения напрямую у сервера отправителя (порт 4307).
// Транспорт TrueConf — это libtorrent 1.2.7 с шифрованием MSE и одной добавкой:
// перед рукопожатием обе стороны шлют 20 байт «TC_FILETRANSFER_____». Описание — tccap/TC_FILETRANSFER.md.
const net = require('node:net')
const crypto = require('node:crypto')
const vs = require('./vssession.cjs')

const MAGIC = Buffer.from('TC_FILETRANSFER_____')
// Прайм у TrueConf свой, не из спецификации BitTorrent (взят из бинарника нативного клиента, 768 бит, генератор 2).
const P = BigInt('0xDA74893B24FB372126F7347C86503750EE0F26AC892A6B812ACD951D8BEC2A25FF0336B957C53DE35DF0514FC618D6788F5A61812D564F3B11F4D50B2EC0311B39D687572E94B2B019397A47016874F75546A000C4ABDD46B6A2E7AB5CA31D2F')
const sha1 = (...b) => crypto.createHash('sha1').update(Buffer.concat(b.map(x => (typeof x === 'string' ? Buffer.from(x) : x)))).digest()

function modPow(b, e, m) {
  let r = 1n
  b %= m
  while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m }
  return r
}
const toBuf96 = n => Buffer.from(n.toString(16).padStart(192, '0'), 'hex')

class RC4 {
  constructor(key) {
    this.s = new Uint8Array(256); this.i = 0; this.j = 0
    for (let i = 0; i < 256; i++) this.s[i] = i
    for (let i = 0, j = 0; i < 256; i++) { j = (j + this.s[i] + key[i % key.length]) & 255; [this.s[i], this.s[j]] = [this.s[j], this.s[i]] }
    this.run(Buffer.alloc(1024))
  }
  run(buf) {
    const out = Buffer.allocUnsafe(buf.length), s = this.s
    for (let n = 0; n < buf.length; n++) {
      this.i = (this.i + 1) & 255; this.j = (this.j + s[this.i]) & 255;
      [s[this.i], s[this.j]] = [s[this.j], s[this.i]]
      out[n] = buf[n] ^ s[(s[this.i] + s[this.j]) & 255]
    }
    return out
  }
}

// ── bencode ─────────────────────────────────────────────────────────────
function bencode(v) {
  if (typeof v === 'number') return Buffer.from(`i${v}e`)
  if (typeof v === 'string') v = Buffer.from(v)
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v])
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')])
  const keys = Object.keys(v).sort()
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap(k => [bencode(k), bencode(v[k])]), Buffer.from('e')])
}
// Возвращает [значение, позиция после него]. Строки остаются Buffer.
function bdecode(b, p = 0) {
  const c = b[p]
  if (c === 0x69) { const e = b.indexOf(0x65, p); return [Number(b.toString('latin1', p + 1, e)), e + 1] }
  if (c === 0x6c || c === 0x64) {
    const list = [], dict = {}
    p++
    while (b[p] !== 0x65) {
      const [k, np] = bdecode(b, p)
      if (c === 0x6c) { list.push(k); p = np } else { const [v, np2] = bdecode(b, np); dict[k.toString('latin1')] = v; p = np2 }
    }
    return [c === 0x6c ? list : dict, p + 1]
  }
  const colon = b.indexOf(0x3a, p), len = Number(b.toString('latin1', p, colon))
  return [b.subarray(colon + 1, colon + 1 + len), colon + 1 + len]
}

// ── соединение: байтовый поток с ожиданием нужного числа байт ───────────
class Wire {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.waiters = []; this.err = null
    this.dec = null; this.enc = null
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, this.dec ? this.dec.run(d) : d]); this.pump() })
    sock.on('error', e => this.fail(e))
    sock.on('close', () => { dbg('closed, buffered', this.buf.length); this.fail(new Error('Соединение закрыто')) })
  }
  fail(e) { this.err = this.err ?? e; this.pump() }
  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0]
      if (this.err) { this.waiters.shift(); w.reject(this.err); continue }
      if (this.buf.length < w.n) break
      this.waiters.shift(); const out = this.buf.subarray(0, w.n); this.buf = this.buf.subarray(w.n); w.resolve(out)
    }
  }
  read(n) { return new Promise((resolve, reject) => { this.waiters.push({ n, resolve, reject }); this.pump() }) }
  write(b, plain) { this.sock.write(!plain && this.enc ? this.enc.run(b) : b) }
}

async function connect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    const t = setTimeout(() => { sock.destroy(); reject(new Error('Таймаут соединения')) }, timeout)
    sock.once('connect', () => { clearTimeout(t); resolve(sock) })
    sock.once('error', e => { clearTimeout(t); reject(e) })
  })
}

// Рукопожатие MSE поверх «TC_FILETRANSFER_____». После него поток шифруется RC4.
async function handshake(w, infoHash) {
  w.write(MAGIC, true)
  const theirs = await w.read(20)
  dbg('magic', theirs.toString())
  if (!theirs.equals(MAGIC)) throw new Error('Сервер не ответил как TrueConf')
  const xa = BigInt('0x' + crypto.randomBytes(20).toString('hex'))
  w.write(Buffer.concat([toBuf96(modPow(2n, xa, P)), crypto.randomBytes(crypto.randomInt(0, 64))]), true)
  const yb = await w.read(96)
  dbg('yb received')
  const S = toBuf96(modPow(BigInt('0x' + yb.toString('hex')), xa, P))
  const encA = new RC4(sha1('keyA', S, infoHash)), decB = new RC4(sha1('keyB', S, infoHash))
  const xor = (a, b) => Buffer.from(a.map((x, i) => x ^ b[i]))
  w.sock.write(Buffer.concat([
    sha1('req1', S), xor(sha1('req2', infoHash), sha1('req3', S)),
    encA.run(Buffer.concat([Buffer.alloc(8), Buffer.from([0, 0, 0, 2]), Buffer.from([0, 0]), Buffer.from([0, 0])])),
  ]))
  // Ответ: PadB (открытый, до 512 байт), потом зашифрованный VC из восьми нулей. Ищем его перебором сдвига.
  let skip = -1
  for (let off = 0; off <= 512 && skip < 0; off++) {
    const probe = await w.read(off + 8)
    const test = new RC4(sha1('keyB', S, infoHash)).run(probe.subarray(off, off + 8))
    w.buf = Buffer.concat([probe, w.buf]) // вернули прочитанное обратно
    if (test.every(x => x === 0)) skip = off
  }
  dbg('sync at', skip)
  if (skip < 0) throw new Error('Не нашёл синхронизацию MSE')
  await w.read(skip)
  w.enc = encA; w.dec = null
  // Всё, что пришло дальше, расшифровываем вручную: данные уже лежат в буфере открытыми.
  const rest = w.buf; w.buf = Buffer.alloc(0)
  w.dec = decB
  w.buf = decB.run(rest)
  const head = await w.read(8 + 4 + 2)
  if (!head.subarray(0, 8).every(x => x === 0)) throw new Error('Неверный VC')
  const select = head.readUInt32BE(8)
  if (!(select & 2)) throw new Error('Сервер не выбрал RC4')
  await w.read(head.readUInt16BE(12))
}

const BLOCK = 16384
const dbg = (...a) => process.env.P2P_DEBUG && console.log('[p2p]', ...a)

function makePeerId() {
  return `-LT1270-${crypto.randomBytes(6).toString('hex')}`
}

async function download(host, hexHash, { port = 4307, timeout = 15000, maxSize = 512 * 1048576, onProgress, peerId } = {}) {
  const infoHash = Buffer.from(hexHash, 'hex')
  const sock = await connect(host, port, timeout)
  const w = new Wire(sock)
  const guard = setTimeout(() => sock.destroy(new Error('Таймаут передачи')), 120000)
  try {
    await handshake(w, infoHash)
    const myId = peerId
      ? (Buffer.isBuffer(peerId) ? peerId : Buffer.from(String(peerId), 'latin1'))
      : Buffer.from(makePeerId(), 'latin1')
    const reserved = Buffer.alloc(8); reserved[5] |= 0x10
    w.write(Buffer.concat([Buffer.from([19]), Buffer.from('BitTorrent protocol'), reserved, infoHash, myId]))
    dbg('mse done')
    const hs = await w.read(68)
    dbg('bt handshake', hs.subarray(0, 20).toString('latin1'), hs.subarray(20, 28).toString('hex'))
    if (!hs.subarray(28, 48).equals(infoHash)) throw new Error('Сервер ответил про другой файл')
    const msg = payload => { const b = Buffer.alloc(4 + payload.length); b.writeUInt32BE(payload.length, 0); payload.copy(b, 4); return b }
    const next = async () => { for (;;) { const len = (await w.read(4)).readUInt32BE(0); if (len) return await w.read(len) } }
    const ext = (id, d, tail) => w.write(msg(Buffer.concat([Buffer.from([20, id]), bencode(d), tail ?? Buffer.alloc(0)])))

    ext(0, { m: { ut_metadata: 2 } })
    let utId = 0, metaSize = 0, meta = null, metaGot = 0
    const pieces = []
    // Ждём метаданные торрента (info-словарь).
    while (!meta) {
      const m = await next()
      if (m[0] !== 20) continue
      const [d, p] = bdecode(m, 2)
      if (m[1] === 0) {
        utId = d.m?.ut_metadata ?? 0; metaSize = d.metadata_size ?? 0
        if (!utId || !metaSize) throw new Error('Сервер не отдаёт метаданные')
        for (let i = 0; i * BLOCK < metaSize; i++) ext(utId, { msg_type: 0, piece: i })
      } else if (d.msg_type === 1) {
        pieces[d.piece] = m.subarray(p); metaGot += m.length - p
        if (metaGot >= metaSize) {
          const all = Buffer.concat(pieces)
          if (!sha1(all).equals(infoHash)) throw new Error('Метаданные не сходятся с хешем')
          meta = all
        }
      } else if (d.msg_type === 2) throw new Error('Сервер отклонил запрос метаданных')
    }
    const [info] = bdecode(meta)
    const length = info.length, pieceLen = info['piece length'], hashes = info.pieces
    if (!length || !pieceLen || !hashes) throw new Error('Многофайловые раздачи не поддерживаются')
    if (length > maxSize) throw new Error('Файл слишком большой')
    const count = Math.ceil(length / pieceLen)
    const out = Buffer.alloc(length)

    w.write(msg(Buffer.from([2]))) // interested
    let unchoked = false, requested = 0, received = 0
    const total = Math.ceil(length / BLOCK)
    const blocks = []
    for (let pi = 0; pi < count; pi++) {
      const plen = Math.min(pieceLen, length - pi * pieceLen)
      for (let off = 0; off < plen; off += BLOCK) blocks.push([pi, off, Math.min(BLOCK, plen - off)])
    }
    const pump = () => {
      while (unchoked && requested < blocks.length && requested - received < 8) {
        const [pi, off, len] = blocks[requested++]
        const b = Buffer.alloc(13); b[0] = 6; b.writeUInt32BE(pi, 1); b.writeUInt32BE(off, 5); b.writeUInt32BE(len, 9)
        w.write(msg(b))
      }
    }
    while (received < total) {
      const m = await next()
      if (m[0] === 1) { unchoked = true; pump() } else if (m[0] === 0) unchoked = false
      else if (m[0] === 7) {
        const pi = m.readUInt32BE(1), off = m.readUInt32BE(5), data = m.subarray(9)
        data.copy(out, pi * pieceLen + off); received++
        onProgress?.(Math.min(length, received * BLOCK), length)
        pump()
      }
    }
    for (let pi = 0; pi < count; pi++) {
      const piece = out.subarray(pi * pieceLen, Math.min(length, (pi + 1) * pieceLen))
      if (!sha1(piece).equals(hashes.subarray(pi * 20, pi * 20 + 20))) throw new Error('Часть файла повреждена')
    }
    return out
  } finally {
    clearTimeout(guard); sock.destroy()
  }
}

// Пиры из трекера: сначала через нативный сервис TORRENT (TrackerAnnounce внутри VS-сессии :4307,
// FUN_102c1ee70 / FUN_102c1ff60), при недоступности — резервный HTTP /announce.
async function peersFromTracker(host, hexHash, { port = 4307, peerId, endpoints, nativeSession } = {}) {
  const pid = peerId ? (Buffer.isBuffer(peerId) ? peerId.toString('latin1') : String(peerId)) : makePeerId()
  try {
    const conn = nativeSession || await vs.ensureNativeSession({ host, port })
    if (conn && typeof conn.trackerAnnounce === 'function') {
      const resp = await conn.trackerAnnounce({
        infoHash: hexHash,
        peerId: pid,
        endpoints,
        event: 1,
        tracker: host
      })
      if (resp?.allPeers?.length) {
        dbg('native TrackerAnnounce peers:', resp.allPeers)
        return resp.allPeers
      }
    }
  } catch (e) {
    dbg('native TrackerAnnounce error:', e.message)
  }
  try {
    const ih = [...Buffer.from(hexHash, 'hex')].map(b => '%' + b.toString(16).padStart(2, '0')).join('')
    const r = await fetch(`http://${host}:${port}/announce?info_hash=${ih}&peer_id=${encodeURIComponent(pid)}&port=44307&uploaded=0&downloaded=0&left=1&compact=1&event=started`, { signal: AbortSignal.timeout(5000) })
    const [d] = bdecode(Buffer.from(await r.arrayBuffer()))
    const raw = d.peers
    const out = []
    if (Buffer.isBuffer(raw)) {
      for (let i = 0; i + 6 <= raw.length; i += 6) out.push({ host: [...raw.subarray(i, i + 4)].join('.'), port: raw.readUInt16BE(i + 4) })
    } else if (Array.isArray(raw)) {
      // У TrueConf пиры идут списком словарей {ip, port, peer_id}.
      for (const x of raw) if (Buffer.isBuffer(x.ip) && typeof x.port === 'number') out.push({ host: x.ip.toString(), port: x.port })
    }
    return out
  } catch { return [] }
}

// Качаем у первого, кто отдаст: сначала серверы (свой и отправителя), потом пиры из трекера.
// Важно: один и тот же 20-байтовый peerId передаётся и в TrackerAnnounce, и в BitTorrent handshake.
async function fetchFile(hosts, hexHash, onProgress, opts = {}) {
  const unique = [...new Set((hosts || []).filter(Boolean))]
  const peerId = opts.peerId || makePeerId()
  const peers = (await Promise.all(unique.map(h => peersFromTracker(h, hexHash, { peerId, endpoints: opts.endpoints, nativeSession: opts.nativeSession })))).flat()
  // Дедуп по host:port: трекер часто отдаёт один и тот же недостижимый origin-пир
  // десятки раз, и без дедупа он забивает все слоты Promise.any.
  const seen = new Set()
  const targets = [...unique.map(host => ({ host, port: 4307 })), ...peers]
    .filter(t => { const k = `${t.host}:${t.port}`; return seen.has(k) ? false : (seen.add(k), true) })
  dbg('targets', targets.map(t => `${t.host}:${t.port}`).join(' '))
  try {
    return await Promise.any(targets.map(t => download(t.host, hexHash, { port: t.port, timeout: 4000, onProgress, peerId })))
  } catch (e) {
    throw new Error(e.errors?.[0]?.message ?? 'Файл никто не раздаёт')
  }
}

module.exports = { download, peersFromTracker, fetchFile, makePeerId }
