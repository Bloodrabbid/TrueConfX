'use strict'
// Сессионный слой нативного протокола TrueConf (порт 4307), ПОСЛЕ обмена ключами.
// Прикладное сообщение = контейнер VS_Variant {Method, <params>} → range-код →
// AES-128-ECB (сессионный ключ) → кадр. Два ключа: по одному на направление
// (key1/key2 из EVP_Seal, см. vscrypto.sealKeyExchange).
//
// GROUNDED: состав (VS_Variant + AES-128-ECB) взят из разбора и проверен
// по отдельности. LIVE-PENDING (подтвердить на стенде, когда остынет троттлинг):
//   - точная кадровка сессионного сообщения (заголовок/длины);
//   - схема паддинга под блок AES (здесь zero-pad до 16, декодер сам режет по dsize);
//   - какой из key1/key2 на какое направление (tx/rx).
// Поэтому класс параметризован, а не захардкожен под догадку.

const vv = require('./vsvariant.cjs')
const { VSSymmetricCrypt } = require('./vscrypto.cjs')

function padTo16 (buf) {
  const r = buf.length % 16
  return r === 0 ? buf : Buffer.concat([buf, Buffer.alloc(16 - r)])
}

class VSSession {
  // keyTx — ключ для исходящих, keyRx — для входящих (направления уточнить на стенде).
  constructor (keyTx, keyRx) {
    this.enc = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyTx) // AES-128-ECB (NID 418)
    this.dec = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyRx)
  }

  // Прикладное сообщение → байты тела (range-код контейнера, затем AES-ECB).
  // fields: [{name,type,value}] — VS_Variant-поля (включая Method строкой).
  encodeBody (fields) {
    const serialized = vv.serialize(fields) // [dsize u32 LE][range-coded]
    return this.enc.encrypt(padTo16(serialized))
  }

  // Байты тела → список полей VS_Variant.
  decodeBody (body) {
    const clear = this.dec.decrypt(body) // AES-ECB; хвост-паддинг далее игнорится
    return vv.deserialize(clear) // читает dsize и декодит ровно dsize символов
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

module.exports = { VSSession, appMessage, padTo16 }
