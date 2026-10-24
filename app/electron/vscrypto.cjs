'use strict'
// Крипто-примитивы нативного рукопожатия TrueConf (порт 4307).
// Факты из разбора официального клиента (SPEC-native-transport.md); каждый
// примитив проверяется в vscrypto.test.cjs. Сборка живого рукопожатия
// (последовательность сообщений) — отдельно, со сверкой на стенде.

const crypto = require('crypto')

// Случайный нонс v2rnd (клиент генерит ~31 байт ASCII-печатных).
// В оригинале — побайтный ГПСЧ; содержимое произвольное, важна длина и печатность.
function genNonce (len = 31) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const r = crypto.randomBytes(len)
  const out = Buffer.alloc(len)
  for (let i = 0; i < len; i++) out[i] = alpha.charCodeAt(r[i] % alpha.length)
  return out
}

// Вывод ключа сессии: HASH(v1_buf ‖ v2rnd).
// Селектор sign: 8 → SHA-256, 4 → SHA-1 (keyderive @0x100965b40).
function deriveKey (v1buf, v2rnd, signSel) {
  const alg = signSel === 8 ? 'sha256' : signSel === 4 ? 'sha1' : null
  if (!alg) throw new Error('unknown sign selector ' + signSel)
  return crypto.createHash(alg).update(v1buf).update(v2rnd).digest()
}

// Симметричный шифр VS_SymmetricCrypt. Семейства: 1=AES, 0xc=ГОСТ-89.
// AES — режим ECB без IV (setKey @0x100966750: IV=NULL). ГОСТ в Node без
// OpenSSL-движка недоступен — обозначено явно.
class VSSymmetricCrypt {
  constructor () { this.family = 0; this.key = null; this.pad = false }
  setCipher (family /* 1=AES, 0xc=GOST */, variant) {
    this.family = family; this.variant = variant
    if (family !== 1) throw new Error('семейство шифра ' + family + ' (ГОСТ) в Node не поддержано')
    return this
  }
  setKey (key) {
    // AES-128 — 16 байт. Длина ключа = длине хэша, усечение до размера блока
    // AES уточняется на стенде; по умолчанию берём первые 16 байт.
    this.key = key.length >= 16 ? key.slice(0, 16) : Buffer.concat([key, Buffer.alloc(16 - key.length)])
    return this
  }
  _algo () { return 'aes-128-ecb' }
  encrypt (data) {
    const c = crypto.createCipheriv(this._algo(), this.key, null); c.setAutoPadding(this.pad)
    return Buffer.concat([c.update(data), c.final()])
  }
  decrypt (data) {
    const d = crypto.createDecipheriv(this._algo(), this.key, null); d.setAutoPadding(this.pad)
    return Buffer.concat([d.update(data), d.final()])
  }
}

// RSA-шифрование v2rnd открытым ключом из сертификата сервера (режим sign=RSA).
// Извлекаем публичный ключ из PEM-сертификата и шифруем.
function rsaEncryptWithCert (certPem, data, padding = crypto.constants.RSA_PKCS1_PADDING) {
  const pub = new crypto.X509Certificate(certPem).publicKey
  return crypto.publicEncrypt({ key: pub, padding }, data)
}

function certPublicKeyInfo (certPem) {
  const cert = new crypto.X509Certificate(certPem)
  const jwk = cert.publicKey.export({ format: 'jwk' })
  const modBits = jwk.n ? Buffer.from(jwk.n, 'base64url').length * 8 : null
  return { subject: cert.subject, issuer: cert.issuer, type: cert.publicKey.asymmetricKeyType, bits: modBits }
}

// --- Обмен ключами режима RSA: конверт EVP_Seal (RSA-PKCS1 + AES-256-CBC) ---
// Разобрано по FUN_100963950/FUN_100960fe0 (EVP_SealInit) и сверено с захватом
// (кадр 332Б). Клиент генерит два сессионных ключа, запечатывает их конвертом
// на публичный ключ сервера и шлёт. См. NATIVE.md.

const SEAL_AES = 'aes-256-cbc' // шифр конверта (NID 427)

// inner_blob = [family u32][ks u32][key1 ks][ks u32][key2 ks]
function buildInnerBlob (family, keysize, key1, key2) {
  const h = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
  return Buffer.concat([h(family), h(keysize), key1, h(keysize), key2])
}
function parseInnerBlob (buf) {
  const family = buf.readUInt32LE(0)
  const ks = buf.readUInt32LE(4)
  const key1 = buf.slice(8, 8 + ks)
  const ks2 = buf.readUInt32LE(8 + ks)
  const key2 = buf.slice(12 + ks, 12 + ks + ks2)
  return { family, keysize: ks, key1, key2 }
}

// Запечатать два сессионных ключа конвертом на публичный ключ сервера.
// Возвращает { frame, key1, key2 } — кадр на провод и ключи для AES-сессии.
function sealKeyExchange (serverPubKey, { family = 1, keysize = 16 } = {}) {
  const key1 = crypto.randomBytes(keysize)
  const key2 = crypto.randomBytes(keysize)
  const inner = buildInnerBlob(family, keysize, key1, key2)
  const ephKey = crypto.randomBytes(32) // AES-256 эфемерный (EVP_SealInit генерит сам)
  const iv = crypto.randomBytes(16)
  const ek = crypto.publicEncrypt({ key: serverPubKey, padding: crypto.constants.RSA_PKCS1_PADDING }, ephKey)
  const c = crypto.createCipheriv(SEAL_AES, ephKey, iv) // PKCS7-паддинг по умолчанию
  const ct = Buffer.concat([c.update(inner), c.final()])
  const hdr = Buffer.alloc(12)
  const flen = 4 /* type */ + 4 /* rsaLen */ + ek.length + iv.length + ct.length
  hdr.writeUInt32LE(flen, 0); hdr.writeUInt32LE(1, 4); hdr.writeUInt32LE(ek.length, 8)
  return { frame: Buffer.concat([hdr, ek, iv, ct]), key1, key2, ephKey, iv }
}

function sealKeyExchangeFromCert (certPem, opts) {
  const pub = new crypto.X509Certificate(certPem).publicKey
  return sealKeyExchange(pub, opts)
}

// Зеркало EVP_Open — для round-trip теста (нужен приватный ключ, т.е. свой стенд-ключ).
function openKeyExchange (privKey, frame) {
  const rsaLen = frame.readUInt32LE(8)
  const ek = frame.slice(12, 12 + rsaLen)
  const iv = frame.slice(12 + rsaLen, 12 + rsaLen + 16)
  const ct = frame.slice(12 + rsaLen + 16)
  const ephKey = crypto.privateDecrypt({ key: privKey, padding: crypto.constants.RSA_PKCS1_PADDING }, ek)
  const d = crypto.createDecipheriv(SEAL_AES, ephKey, iv)
  const inner = Buffer.concat([d.update(ct), d.final()])
  return parseInnerBlob(inner)
}

module.exports = {
  genNonce, deriveKey, VSSymmetricCrypt, rsaEncryptWithCert, certPublicKeyInfo,
  sealKeyExchange, sealKeyExchangeFromCert, openKeyExchange, buildInnerBlob, parseInnerBlob
}
