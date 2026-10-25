'use strict'
// Сессионный слой нативного протокола TrueConf (порт 4307), ПОСЛЕ обмена ключами.
// Прикладное сообщение = контейнер VS_Variant {Method, params} → сериализация
// (range-код) → payload; payload заворачивается в бинарный конверт
// VS_FixedPartMessage; конверт ЦЕЛИКОМ шифруется AES-128-ECB(PKCS7). Два ключа
// (key1/key2 из EVP_Seal) — по направлению.
//
// GROUNDED по разбору официального клиента 8.3.2 (FUN_1001c9e70 — строитель
// конверта, FUN_100224ed0 — отправка на именованный сервис, encrypt @0x100966910):
//   - шифр AES-128-ECB variant 2 + PKCS7 (байт-точно, см. vscrypto);
//   - конверт НЕ сжимается range-кодом (кодер зовётся только внутри сериализатора
//     VS_Variant); внешней открытой длины на проводе нет — длину несёт заголовок
//     конверта (u16 hdrLen@2 + payloadLen@5..7), приёмник чистит блок 0 ECB и
//     отмеряет остаток, затем снимает PKCS7.
// LIVE-PENDING (финальная байт-сверка на стенде, ключи генерю сам → ответ
// расшифрую): значения runtime-полей заголовка (id@8, from, connId), и какой из
// key1/key2 — на tx (клиент→сервер). Из захвата не взять (нет приватного ключа
// сервера). Поэтому эти поля параметризованы, а не захардкожены.

const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const vv = require('./vsvariant.cjs')
const vt = require('./vstransport.cjs')
const { VSSymmetricCrypt, sealKeyExchangeFromCert } = require('./vscrypto.cjs')

const TAG = '54' // тег протокола (литерал "54" в FUN_100224ed0)
const DEFAULT_APP_NAME = 'TrueConf OS X'
const DEFAULT_CHAT_CAPS = JSON.stringify([
  'list_who_viewed_message',
  'personal_contexts_contain_permissions',
  'sync_last_messages',
  'sync_personal_contexts',
  'with_null_last_read_message_support',
  'without_delivery_confirm',
  'without_embedded_call_ids'
])

function u32Buf (n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
function u64Buf (n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
function md5Upper (s) { return crypto.createHash('md5').update(s).digest('hex').toUpperCase() }

// Pascal-строка конверта: [len:1][bytes:len][0x00]. Длина без завершающего нуля.
function pstr (s) {
  const b = Buffer.from(s || '', 'latin1')
  if (b.length > 0xff) throw new Error('строка конверта > 255 байт: ' + s)
  return Buffer.concat([Buffer.from([b.length]), b, Buffer.from([0])])
}

// Конверт VS_FixedPartMessage (раскладка из FUN_1001c9e70).
//  off 0   byte  0x81 | (flags&3)<<6
//  off 2   u16   длина заголовка (смещение payload)
//  off 5..7      payloadLen-1 (24 бита LE)
//  off 8   u32   id
//  off 0xc u32   timeout/seq
//  off 0x10      9 pascal-строк (сверено по FUN_100224ed0→FUN_1001c8240):
//                connId(uVar8), from(mgr+0x10), "54", fromUser, service, "", to, "", extra
//  off hdrLen    payload (= сериализованный контейнер [dsize][coded])
function buildFixedPartMessage (payload, { service, from, connId = '', fromUser = '', to = '', extra = '', id = 0, timeout = 20000, flags = 1 } = {}) {
  const srv = service || ''
  const senderSrv = from !== undefined ? from : srv
  const strs = [connId, senderSrv, TAG, fromUser, srv, '', to, '', extra].map(pstr)
  const strTotal = strs.reduce((n, b) => n + b.length, 0)
  const headerLen = 0x10 + strTotal
  const buf = Buffer.alloc(headerLen + payload.length)
  buf[0] = 0x81 | ((flags & 3) << 6)
  const pm1 = (payload.length - 1) >>> 0
  buf[5] = pm1 & 0xff; buf[6] = (pm1 >>> 8) & 0xff; buf[7] = (pm1 >>> 16) & 0xff
  buf.writeUInt16LE(headerLen & 0xffff, 2)
  buf.writeUInt32LE(id >>> 0, 8)
  buf.writeUInt32LE(timeout >>> 0, 12)
  let off = 0x10
  for (const b of strs) { b.copy(buf, off); off += b.length }
  payload.copy(buf, headerLen)
  finalizeChecksums(buf)
  return buf
}

// Две однобайтовые контрольные суммы (FUN_1001c8570), иначе сервер молча
// отбрасывает пакет. cs1→байт4 (по payload с шагом 16), cs2→байт1 (по
// заголовку off 2..hdrLen; поле timeout 0xc..0xf на время счёта = 0).
function finalizeChecksums (buf) {
  const hdrLen = buf.readUInt16LE(2)
  const payloadM1 = buf[5] | (buf[6] << 8) | (buf[7] << 16)
  let u, v
  if (payloadM1 < hdrLen) {
    buf[4] = 0xee
  } else {
    let off = hdrLen; u = 0xee; v = 0
    do { v = ((u & 0xff) + buf[off]) & 0xff; u = off + v; off += 0x10 } while (off <= payloadM1)
    buf[4] = (v + off - 0x10) & 0xff
  }
  const savedT = buf.readUInt32LE(12); buf.writeUInt32LE(0, 12)
  u = ((buf[0] & 0xdf) + 0xac) & 0xff; v = u & 0xff; let i = 2
  while (i !== hdrLen) { v = ((u & 0xff) + buf[i]) & 0xff; u = i + v; i++ }
  buf.writeUInt32LE(savedT, 12)
  buf[1] = (v + i - 1) & 0xff
}

// Преобразовать поля VS_Variant в JS-объект (повторяющиеся поля собираются в массив).
function fieldsToObject (fields) {
  const out = {}
  if (!fields) return out
  for (const f of fields) {
    let v
    if (f.type === 1) v = f.value.length >= 4 ? f.value.readUInt32LE(0) : 0
    else if (f.type === 2 || f.type === 5) v = f.value.length >= 8 ? f.value.readBigUInt64LE(0) : 0n
    else if (f.type === 3) v = f.value.toString('utf8')
    else v = f.value
    if (f.name in out) {
      if (Array.isArray(out[f.name])) out[f.name].push(v)
      else out[f.name] = [out[f.name], v]
    } else {
      out[f.name] = v
    }
  }
  return out
}

// Разобрать конверт → { id, timeout, connId, from, tag, fromUser, service, to, extra, fields, data }.
function parseFixedPartMessage (buf) {
  if (buf.length < 16 || (buf[0] & 0x81) !== 0x81) return null
  const headerLen = buf.readUInt16LE(2)
  const payloadLen = (buf[5] | (buf[6] << 8) | (buf[7] << 16)) + 1
  if (headerLen < 0x10 || headerLen + payloadLen > buf.length) return null
  const id = buf.readUInt32LE(8)
  const timeout = buf.readUInt32LE(12)
  const strs = []; let off = 0x10
  for (let i = 0; i < 9 && off < headerLen; i++) {
    const n = buf[off]; const s = buf.slice(off + 1, off + 1 + n).toString('latin1')
    strs.push(s); off += n + 2
  }
  const payload = buf.slice(headerLen, headerLen + payloadLen)
  const fields = vv.deserialize(payload)
  if (!fields) return null
  return {
    id,
    timeout,
    connId: strs[0] || '',
    from: strs[1] || '',
    tag: strs[2] || '',
    fromUser: strs[3] || '',
    service: strs[4] || '',
    to: strs[6] || '',
    extra: strs[8] || '',
    fields,
    data: fieldsToObject(fields)
  }
}

class VSSession {
  // keyTx = key1 (клиент→сервер), keyRx = key2 (сервер→клиент) — подтверждено на живом tc.t2.ru.
  constructor (keyTx, keyRx) {
    this.enc = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyTx)
    this.dec = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyRx)
    this.decRaw = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyRx)
    this.decRaw.pad = false
    this.rxBuf = Buffer.alloc(0)
  }

  encodeBody (fields, opts = {}) {
    const payload = vv.serialize(fields)
    return this.enc.encrypt(buildFixedPartMessage(payload, opts))
  }

  decodeBody (body) {
    return parseFixedPartMessage(this.dec.decrypt(body))
  }

  // Потоковый разбор входящего шифртекста из TCP.
  // Каждый конверт шифруется отдельно с PKCS7 (@0x100966910), поэтому его размер
  // на проводе равен (Math.floor((hdrLen + payloadLen) / 16) + 1) * 16.
  pushCiphertext (chunk) {
    if (chunk && chunk.length) this.rxBuf = Buffer.concat([this.rxBuf, chunk])
    const messages = []
    while (this.rxBuf.length >= 16) {
      const b0 = this.decRaw.decrypt(this.rxBuf.slice(0, 16))
      if ((b0[0] & 0x81) !== 0x81) throw new Error('Неверный заголовок сессионного конверта: 0x' + b0[0].toString(16))
      const hdrLen = b0.readUInt16LE(2)
      const payloadLen = (b0[5] | (b0[6] << 8) | (b0[7] << 16)) + 1
      const plainLen = hdrLen + payloadLen
      const wireLen = (Math.floor(plainLen / 16) + 1) * 16
      if (this.rxBuf.length < wireLen) break
      const frameCipher = this.rxBuf.slice(0, wireLen)
      this.rxBuf = this.rxBuf.slice(wireLen)
      const plain = this.dec.decrypt(frameCipher)
      const msg = parseFixedPartMessage(plain)
      if (msg) messages.push(msg)
    }
    return messages
  }
}

function encodeField (name, raw) {
  if (raw && typeof raw === 'object' && 't' in raw) {
    if (raw.t === 'container') return { name, type: 4, value: vv.serialize(raw.v) }
    if (raw.t === 1 && typeof raw.v === 'number') return { name, type: 1, value: u32Buf(raw.v) }
    if ((raw.t === 2 || raw.t === 5) && (typeof raw.v === 'bigint' || typeof raw.v === 'number')) return { name, type: raw.t, value: u64Buf(raw.v) }
    return { name, type: raw.t, value: Buffer.isBuffer(raw.v) ? raw.v : Buffer.from(String(raw.v), 'utf8') }
  }
  if (typeof raw === 'number') return { name, type: 1, value: u32Buf(raw) }
  if (typeof raw === 'bigint') return { name, type: 5, value: u64Buf(raw) }
  if (Buffer.isBuffer(raw)) return { name, type: 4, value: raw }
  return { name, type: 3, value: Buffer.from(String(raw), 'utf8') }
}

// Прикладное сообщение в виде VS_Variant-полей: Method + параметры.
// Поддерживает массивы значений (для повторяющихся одноимённых полей, как CallId в Subscribe)
// и список пар [[name, val], ...] (как Name/Property в SetProps).
function appMessage (method, params = {}) {
  const fields = [{ name: 'Method', type: 3, value: Buffer.from(method, 'latin1') }]
  const entries = Array.isArray(params) ? params : Object.entries(params)
  for (const [name, raw] of entries) {
    if (raw === undefined) continue
    if (Array.isArray(raw)) {
      for (const item of raw) fields.push(encodeField(name, item))
    } else {
      fields.push(encodeField(name, raw))
    }
  }
  return fields
}

// Вычисление Hash (AppEndpId) по точной формуле FUN_1002a46c0 → FUN_100355e50 (@0x100355e50):
//   h1 = MD5_UPPER(IOPlatformSerialNumber + IOPlatformUUID)
//   h2 = MD5_UPPER(username)
//   h3 = extra ? MD5_UPPER(extra) : ""
//   h4 = appName ? MD5_UPPER(appName) : ""
//   Hash = MD5_UPPER(h1 + h2 + h3 + h4)
function computeAppEndpId ({ serial = '', uuid = '', username = '', extra = '', appName = DEFAULT_APP_NAME } = {}) {
  const h1 = (serial || uuid) ? md5Upper(serial + uuid) : ''
  const h2 = username ? md5Upper(username) : ''
  const h3 = extra ? md5Upper(extra) : ''
  const h4 = appName ? md5Upper(appName) : ''
  return md5Upper(h1 + h2 + h3 + h4)
}

function getMacAppEndpId (appName = DEFAULT_APP_NAME) {
  let serial = ''; let uuid = ''
  if (process.platform === 'darwin') {
    try {
      const out = execSync('/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8', timeout: 3000 })
      serial = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)?.[1] || ''
      uuid = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || ''
    } catch {}
  }
  const username = os.userInfo().username || ''
  return computeAppEndpId({ serial, uuid, username, appName })
}

// Чтение автологин-реквизитов из settings.sqlite официального клиента TrueConf.
function loadOfficialCredentials (domain = 'tc.t2.ru', dbPath) {
  const targetPath = dbPath || path.join(
    os.homedir(),
    'Library/Containers/org.trueconf.client/Data/Library/Application Support/TrueConf/settings.sqlite'
  )
  if (!fs.existsSync(targetPath)) return null
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(targetPath, { open: true, readOnly: true })
  try {
    const settings = {}
    for (const r of db.prepare('SELECT Name, CAST(Value AS TEXT) AS val FROM settings').all()) {
      settings[r.Name] = r.val
    }
    const targetDomain = domain || settings.ServerDomain || settings.ServerAddress || 'tc.t2.ru'
    const row = db.prepare('SELECT Domain, Login, Key FROM logins WHERE Domain = ? COLLATE NOCASE').get(targetDomain)
    if (!row || !row.Login || !row.Key) return null
    const [trueconfId, savedCid] = String(row.Login).split('/')
    return {
      host: settings.ServerAddress || targetDomain,
      port: Number(settings.ServerPort) || 4307,
      domain: row.Domain,
      loginWithCid: row.Login,
      login: trueconfId,
      cid: savedCid || crypto.randomBytes(4).toString('hex'),
      key: row.Key,
      hash: getMacAppEndpId(DEFAULT_APP_NAME)
    }
  } finally {
    db.close()
  }
}

// Собрать поля сообщения LoginUser (порядок полей строго по строителю FUN_100315280).
function buildLoginUserMessage ({ login, cid, key = '', password, domain = '', hash, clientType = 0, appName = DEFAULT_APP_NAME, chatCapabilities = DEFAULT_CHAT_CAPS }) {
  const fullLogin = login.includes('/') ? login : `${login}/${cid || crypto.randomBytes(4).toString('hex')}`
  const entries = [
    ['clientChatVersion', '3'],
    ['chatCapabilities', chatCapabilities],
    ['Login', fullLogin]
  ]
  if (password !== undefined && password !== null && password !== '') {
    entries.push(['Password', password], ['Key', ''])
  } else {
    entries.push(['Key', key])
  }
  entries.push(
    ['UserDefaultDomain', domain],
    ['Hash', hash || getMacAppEndpId(appName)],
    ['ClientType', { t: 1, v: clientType }],
    ['AppName', appName]
  )
  return appMessage('LoginUser', entries)
}

// Сформировать строку локальных IPv4-адресов вида "ip:port;..." (FUN_102c1ef88).
function getLocalEndpoints (port = 6881) {
  const nets = os.networkInterfaces()
  const out = []
  for (const list of Object.values(nets)) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(`${iface.address}:${port}`)
    }
  }
  return out.length ? `${out.join(';')};` : `127.0.0.1:${port};`
}

// Разобрать строку пиров "ip:port;ip:port;..." из PeersListParam / BCPeersListParam (FUN_102c1fce0 → FUN_102c1ea70).
function parsePeerEndpoints (str) {
  if (!str || typeof str !== 'string') return []
  const out = []
  for (const raw of str.split(';')) {
    const item = raw.trim()
    if (!item) continue
    const colon = item.lastIndexOf(':')
    if (colon <= 0) continue
    const host = item.slice(0, colon)
    const port = Number(item.slice(colon + 1))
    if (host && Number.isInteger(port) && port > 0 && port <= 65535) out.push({ host, port })
  }
  return out
}

// Собрать поля сообщения TrackerAnnounce (порядок полей строго по строителю FUN_102c1ee70).
// AnnounceEvent: 1 = started, 2 = completed, 3 = stopped, 4 = none.
function buildTrackerAnnounceMessage ({ infoHash, peerId, endpoints, event = 1, requestId = 1n }) {
  const hexHash = String(infoHash || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(hexHash)) throw new Error('TorrentInfoHash должен быть 40-символьным hex: ' + infoHash)
  const pid = Buffer.isBuffer(peerId) ? peerId.toString('latin1') : String(peerId || '')
  if (Buffer.byteLength(pid, 'latin1') !== 20) throw new Error('TorrentPeerId должен быть ровно 20 байт')
  const ep = Array.isArray(endpoints)
    ? (endpoints.length ? `${endpoints.map(e => typeof e === 'string' ? e : `${e.host}:${e.port}`).join(';')};` : '')
    : (endpoints !== undefined ? String(endpoints) : getLocalEndpoints())
  return appMessage('TrackerAnnounce', [
    ['TorrentInfoHash', hexHash],
    ['TorrentPeerId', pid],
    ['TorrentPeerEndpoints', ep],
    ['AnnounceEvent', { t: 1, v: event >>> 0 }],
    ['AnnounceRequestId', BigInt(requestId)]
  ])
}

// Разобрать входящий ответ TrackerAnnounce (парсер FUN_102c1ff60).
function parseTrackerAnnounceResponse (msgOrFields) {
  const fields = Array.isArray(msgOrFields) ? msgOrFields : msgOrFields?.fields
  const d = Array.isArray(msgOrFields) ? fieldsToObject(fields) : (msgOrFields?.data || fieldsToObject(fields))
  if (d.Method !== 'TrackerAnnounce') return null
  const peers = parsePeerEndpoints(d.PeersListParam)
  const bcPeers = parsePeerEndpoints(d.BCPeersListParam)
  return {
    infoHash: String(d.TorrentInfoHash || '').toLowerCase(),
    peers,
    bcPeers,
    allPeers: [...peers, ...bcPeers],
    interval: typeof d.AnnounceInterval === 'bigint' ? Number(d.AnnounceInterval) : 60,
    requestId: typeof d.AnnounceRequestId === 'bigint' ? d.AnnounceRequestId : BigInt(d.AnnounceRequestId || 0),
    reason: d.NotificationReason
  }
}

// Нормализовать имя трекера для поля extra конверта TORRENT (например "tc.t2.ru" → "tc.t2.ru#vcs").
function normalizeTrackerExtra (tracker, defaultRealm = '') {
  if (!tracker) return defaultRealm || ''
  const t = String(tracker).trim()
  if (!t) return defaultRealm || ''
  if (t.includes('#')) return t
  if (t.includes('@')) return t
  return `${t}#vcs`
}

// Полный цикл подключения и входа по нативному протоколу 4307.
function connectAndLogin (opts = {}) {
  let { host = 'tc.t2.ru', port = 4307, login, cid, key, password, hash, appName = DEFAULT_APP_NAME, timeoutMs = 12000 } = opts
  if (!login || (!key && !password)) {
    const saved = loadOfficialCredentials(host)
    if (saved) {
      host = opts.host || saved.host || host
      port = opts.port || saved.port || port
      login = login || saved.login
      cid = cid || saved.cid
      key = key || saved.key
      hash = hash || saved.hash
    }
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host)
    let settled = false
    const finish = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) { try { sock.destroy() } catch {} reject(err) } else resolve(val)
    }
    const timer = setTimeout(() => finish(new Error('Таймаут нативного входа 4307')), timeoutMs)

    let phase = 'pre'
    let preBuf = Buffer.alloc(0)
    let serverPreamble = null
    let certPem = null
    let session = null
    let nextId = 2
    let nextReqId = 1n
    let sentLogin = false
    const reader = new vt.FrameReader()
    const listeners = new Set()

    const sendApp = (fields, sendOpts = {}) => {
      const id = sendOpts.id ?? nextId++
      const service = sendOpts.service || 'AUTH'
      const raw = session.encodeBody(fields, {
        service,
        from: sendOpts.from ?? service,
        connId: sendOpts.connId ?? serverPreamble.sessionId,
        to: sendOpts.to ?? '',
        extra: sendOpts.extra ?? '',
        id,
        timeout: sendOpts.timeout ?? 20000
      })
      sock.write(raw)
      return id
    }

    const trackerAnnounce = ({ infoHash, peerId, endpoints, event = 1, tracker, requestId, timeoutMs: reqTimeout = 6000 } = {}) => {
      const reqId = requestId !== undefined ? BigInt(requestId) : nextReqId++
      const extra = normalizeTrackerExtra(tracker, serverPreamble?.realm)
      const fields = buildTrackerAnnounceMessage({ infoHash, peerId, endpoints, event, requestId: reqId })
      return new Promise((res, rej) => {
        const t = setTimeout(() => { off(); rej(new Error('Таймаут TrackerAnnounce')) }, reqTimeout)
        const off = onMessage(m => {
          if (m.service !== 'TORRENT' || m.data.Method !== 'TrackerAnnounce') return
          const parsed = parseTrackerAnnounceResponse(m)
          if (!parsed) return
          if (parsed.requestId === reqId || parsed.infoHash === String(infoHash).toLowerCase()) {
            clearTimeout(t)
            off()
            res(parsed)
          }
        })
        sendApp(fields, { from: 'TORRENT', service: 'TORRENT', to: '', extra, timeout: 20000 })
      })
    }

    const getAppProps = ({ clientVersion = '8.3.2.154', name = appName, timeoutMs: reqTimeout = 6000 } = {}) => {
      return new Promise((res, rej) => {
        const t = setTimeout(() => { off(); rej(new Error('Таймаут GetAppProps')) }, reqTimeout)
        const off = onMessage(m => {
          if (m.service === 'NET_CONFIG' && m.data.Method === 'SetProps') {
            clearTimeout(t); off(); res(m.data)
          }
        })
        sendApp(appMessage('GetAppProps', [['ClientVersion', clientVersion], ['Name', name]]), { service: 'NET_CONFIG' })
      })
    }

    const getCurrentTime = ({ seq = nextReqId++, timeoutMs: reqTimeout = 6000 } = {}) => {
      const seqBig = BigInt(seq)
      return new Promise((res, rej) => {
        const t = setTimeout(() => { off(); rej(new Error('Таймаут GetCurrentTime')) }, reqTimeout)
        const off = onMessage(m => {
          if (m.from === 'Time' && m.data.Method === 'GetCurrentTime' && m.data.Seq === seqBig) {
            clearTimeout(t); off(); res(m.data)
          }
        })
        sendApp(appMessage('GetCurrentTime', [['Seq', seqBig]]), { from: 'CHATV2', service: 'Time' })
      })
    }

    const updateStatus = (userPresStatus = 1, extFields) => {
      const entries = [['UserPresStatus', { t: 1, v: userPresStatus }]]
      if (extFields && extFields.length) entries.push(['ExtSt', { t: 'container', v: extFields }])
      return sendApp(appMessage('UpdateStatus', entries), { service: 'PRESENCE' })
    }

    const searchAddressBook = ({ query = '', hash: abHash = 1, addressBook = 1, callId, timeoutMs: reqTimeout = 6000 } = {}) => {
      return new Promise((res, rej) => {
        const t = setTimeout(() => { off(); rej(new Error('Таймаут SearchAddressBook')) }, reqTimeout)
        const off = onMessage(m => {
          if (m.service === 'ABOOK' && m.data.Method === 'SearchAddressBook' && m.data.AddressBook === addressBook) {
            clearTimeout(t); off(); res(m.data)
          }
        })
        const who = callId || login
        sendApp(appMessage('SearchAddressBook', [
          ['Query', query],
          ['Hash', { t: 1, v: abHash >>> 0 }],
          ['AddressBook', { t: 1, v: addressBook >>> 0 }],
          ['CallId', who],
          ['E-Mail', who],
          ['Name', who]
        ]), { service: 'ABOOK' })
      })
    }

    const subscribePresence = (callIds = [], cause = 1) => {
      return sendApp(appMessage('Subscribe', [
        ['Cause', { t: 1, v: cause >>> 0 }],
        ['CallId', callIds]
      ]), { from: 'ABOOK', service: 'PRESENCE' })
    }

    const onMessage = fn => { listeners.add(fn); return () => listeners.delete(fn) }

    sock.on('connect', () => sock.write(vt.buildClientPreamble()))
    sock.on('error', err => finish(err))
    sock.on('close', () => { if (!settled) finish(new Error('Соединение закрыто сервером до завершения входа')) })

    sock.on('data', chunk => {
      try {
        if (phase === 'pre') {
          preBuf = Buffer.concat([preBuf, chunk])
          const sp = vt.parseServerPreamble(preBuf)
          if (!sp || sp.consumed > preBuf.length) return
          serverPreamble = sp
          reader.push(preBuf.slice(sp.consumed))
          phase = 'cert'
          pumpCert()
        } else if (phase === 'cert') {
          reader.push(chunk)
          pumpCert()
        } else {
          const msgs = session.pushCiphertext(chunk)
          for (const m of msgs) {
            for (const fn of listeners) {
              try { fn(m) } catch {}
            }
            handleAuthMsg(m)
          }
        }
      } catch (e) {
        finish(e)
      }
    })

    function pumpCert () {
      let f
      while ((f = reader.nextFields()) !== null) {
        const certField = f.find(x => x.name === 'Certificate')
        if (!certField) continue
        certPem = certField.value.toString('latin1')
        const sealed = sealKeyExchangeFromCert(certPem, { family: 1, keysize: 16 })
        sock.write(sealed.frame)
        session = new VSSession(sealed.key1, sealed.key2)
        phase = 'session'
        // #1 CheckUserLoginStatus (id=2)
        sendApp(appMessage('CheckUserLoginStatus', {}), { service: 'AUTH', from: 'AUTH', id: 2 })
        nextId = 5
      }
    }

    function handleAuthMsg (m) {
      if (m.data.Method !== 'UserLoggedin') return
      const res = m.data.Result
      if (res === 2 && !sentLogin) {
        sentLogin = true
        const loginMsg = buildLoginUserMessage({ login, cid, key, password, hash, appName })
        sendApp(loginMsg, { service: 'AUTH', from: 'AUTH', id: 5 })
        nextId = 6
      } else if (res === 0) {
        finish(null, {
          socket: sock,
          session,
          realm: serverPreamble.realm,
          sessionId: serverPreamble.sessionId,
          certPem,
          result: 0,
          account: m.data,
          rawMessage: m,
          sendApp,
          trackerAnnounce,
          getAppProps,
          getCurrentTime,
          updateStatus,
          searchAddressBook,
          subscribePresence,
          onMessage,
           isAlive: () => !sock.destroyed && sock.writable,
          close: () => sock.destroy()
        })
      } else if (typeof res === 'number' && res !== 2) {
        finish(Object.assign(new Error(`Отказ входа UserLoggedin: Result=${res}`), { result: res, messageData: m.data }))
      }
    }
  })
}

// Менеджер переиспользуемой нативной сессии 4307 (автоподключение и реконнект при обрыве).
let activeConnPromise = null
let activeConnOpts = null

function configureNativeSession (opts = {}) {
  activeConnOpts = { ...activeConnOpts, ...opts }
  if (activeConnPromise) {
    activeConnPromise.then(c => c?.close()).catch(() => {})
    activeConnPromise = null
  }
}

async function ensureNativeSession (opts = {}) {
  const merged = { ...activeConnOpts, ...opts }
  if (activeConnPromise) {
    try {
      const c = await activeConnPromise
      if (c && c.isAlive()) return c
    } catch {}
    activeConnPromise = null
  }
  activeConnPromise = connectAndLogin(merged).then(conn => {
    conn.socket.once('close', () => {
      if (activeConnPromise) activeConnPromise = null
    })
    conn.socket.once('error', () => {
      if (activeConnPromise) activeConnPromise = null
    })
    return conn
  }).catch(err => {
    activeConnPromise = null
    throw err
  })
  return activeConnPromise
}

module.exports = {
  VSSession,
  appMessage,
  buildFixedPartMessage,
  parseFixedPartMessage,
  fieldsToObject,
  u32Buf,
  u64Buf,
  computeAppEndpId,
  getMacAppEndpId,
  loadOfficialCredentials,
  buildLoginUserMessage,
  getLocalEndpoints,
  parsePeerEndpoints,
  buildTrackerAnnounceMessage,
  parseTrackerAnnounceResponse,
  normalizeTrackerExtra,
  connectAndLogin,
  configureNativeSession,
  ensureNativeSession
}
