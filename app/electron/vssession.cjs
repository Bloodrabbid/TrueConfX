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

const vv = require('./vsvariant.cjs')
const { VSSymmetricCrypt } = require('./vscrypto.cjs')

const TAG = '54' // тег протокола (литерал "54" в FUN_100224ed0)

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
//                connId(uVar8), from(mgr+0x10), "54", "", service, "", to, "", extra
//  off hdrLen    payload (= сериализованный контейнер [dsize][coded])
function buildFixedPartMessage (payload, { service, from = '', connId = '', to = '', extra = '', id = 0, timeout = 0, flags = 1 } = {}) {
  const strs = [connId, from, TAG, '', service || '', '', to, '', extra].map(pstr)
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
// Реализованы скалярные рекуррентности (в бинаре SIMD — их векторизация).
function finalizeChecksums (buf) {
  const hdrLen = buf.readUInt16LE(2)
  const payloadM1 = buf[5] | (buf[6] << 8) | (buf[7] << 16)
  // cs1: off = hdrLen, шаг 0x10, пока off <= payloadM1; seed 0xee.
  // Если payloadM1 < hdrLen (крошечный payload) — оригинал (FUN_1001c8570) цикл НЕ
  // крутит и ставит byte4 = 0xee. Для логина payloadM1 >> hdrLen, так что цикл идёт.
  let u, v
  if (payloadM1 < hdrLen) {
    buf[4] = 0xee
  } else {
    let off = hdrLen; u = 0xee; v = 0
    do { v = ((u & 0xff) + buf[off]) & 0xff; u = off + v; off += 0x10 } while (off <= payloadM1)
    buf[4] = (v + off - 0x10) & 0xff
  }
  // cs2: off 2..hdrLen; seed (byte0 & 0xdf)+0xac; timeout обнулён
  const savedT = buf.readUInt32LE(12); buf.writeUInt32LE(0, 12)
  u = ((buf[0] & 0xdf) + 0xac) & 0xff; v = u & 0xff; let i = 2
  while (i !== hdrLen) { v = ((u & 0xff) + buf[i]) & 0xff; u = i + v; i++ }
  buf.writeUInt32LE(savedT, 12)
  buf[1] = (v + i - 1) & 0xff
}

// Разобрать конверт → { service, from, connId, to, fields }.
function parseFixedPartMessage (buf) {
  if (buf.length < 16) return null
  const headerLen = buf.readUInt16LE(2)
  const payloadLen = (buf[5] | (buf[6] << 8) | (buf[7] << 16)) + 1
  if (headerLen < 0x10 || headerLen + payloadLen > buf.length) return null
  // 9 pascal-строк с off 0x10
  const strs = []; let off = 0x10
  for (let i = 0; i < 9 && off < headerLen; i++) {
    const n = buf[off]; const s = buf.slice(off + 1, off + 1 + n).toString('latin1')
    strs.push(s); off += n + 2
  }
  const payload = buf.slice(headerLen, headerLen + payloadLen)
  const fields = vv.deserialize(payload) // [dsize][coded] → поля VS_Variant
  return { connId: strs[0], from: strs[1], tag: strs[2], service: strs[4], to: strs[6], fields }
}

class VSSession {
  // keyTx — ключ для исходящих, keyRx — для входящих (направления уточнить на стенде).
  constructor (keyTx, keyRx) {
    this.enc = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyTx) // AES-128-ECB variant 2, PKCS7
    this.dec = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyRx)
  }

  // Прикладное сообщение → байты на провод.
  // fields: VS_Variant-поля (включая Method). opts: {service, from, connId, to, id, timeout}.
  encodeBody (fields, opts = {}) {
    const payload = vv.serialize(fields) // [dsize u32 LE][range-coded]
    return this.enc.encrypt(buildFixedPartMessage(payload, opts))
  }

  // Байты с провода → {service, from, connId, to, fields}.
  decodeBody (body) {
    return parseFixedPartMessage(this.dec.decrypt(body))
  }
}

// Прикладное сообщение в виде VS_Variant-полей: Method + параметры.
// params: { имя: {t, v} } либо { имя: строка|Buffer }. Строка → тип 3, Buffer → тип 4.
function appMessage (method, params = {}) {
  const fields = [{ name: 'Method', type: 3, value: Buffer.from(method, 'latin1') }]
  for (const [name, raw] of Object.entries(params)) {
    if (raw && typeof raw === 'object' && 't' in raw) fields.push({ name, type: raw.t, value: Buffer.isBuffer(raw.v) ? raw.v : Buffer.from(String(raw.v), 'latin1') })
    else if (Buffer.isBuffer(raw)) fields.push({ name, type: 4, value: raw })
    else fields.push({ name, type: 3, value: Buffer.from(String(raw), 'latin1') })
  }
  return fields
}

module.exports = { VSSession, appMessage, buildFixedPartMessage, parseFixedPartMessage }
