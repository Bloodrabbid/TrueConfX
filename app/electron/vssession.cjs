'use strict'
// Сессионный слой нативного протокола TrueConf (порт 4307), ПОСЛЕ обмена ключами.
// Прикладное сообщение = контейнер VS_Variant {Method, <params>} → range-код →
// кадр [flen][dsize][coded] → AES-128-ECB(PKCS7) целиком. Два ключа: по одному
// на направление (key1/key2 из EVP_Seal, см. vscrypto.sealKeyExchange).
//
// GROUNDED по разбору официального клиента 8.3.2:
//   - encrypt/decrypt класса VS_SymmetricCrypt (@0x100966910/@0x1009669f0) —
//     AES-128-ECB variant 2 с PKCS7 (байт-точно, см. vscrypto);
//   - обёртки VS_TransportSession (@0x100159870 enc / @0x1009599b0 dec) шифруют
//     буфер НА МЕСТЕ и возвращают новую длину — кадровку не добавляют;
//   - на проводе у сессионного пакета НЕТ открытой длины (c2s[358] в захвате
//     сразу высокоэнтропийный, kратен 16), а все прочие кадры — [flen]...;
//     ECB позволяет расшифровать блок 0 и прочесть flen. Отсюда: шифруется
//     ЦЕЛИКОМ кадр [flen][dsize][coded], приёмник снимает PKCS7 и парсит его.
// LIVE-PENDING (финальная байт-сверка на стенде, где ключи генерю я сам):
//   - подтвердить внутреннюю раскладку [flen][dsize][coded] на расшифрованном
//     ответе сервера;
//   - какой из key1/key2 на направление клиент→сервер (tx/rx).

const vv = require('./vsvariant.cjs')
const { buildFrame } = require('./vstransport.cjs')
const { VSSymmetricCrypt } = require('./vscrypto.cjs')

// Разобрать кадр [flen:u32 LE][dsize:u32 LE][range-coded: flen-4] в поля VS_Variant.
function parseFrame (buf) {
  if (buf.length < 8) return null
  const flen = buf.readUInt32LE(0)
  if (flen < 4 || buf.length < 4 + flen) return null
  const dsize = buf.readUInt32LE(4)
  const coded = buf.slice(8, 4 + flen)
  const raw = vv.decode(coded, dsize)
  return raw ? vv.parseContainer(raw) : null
}

class VSSession {
  // keyTx — ключ для исходящих, keyRx — для входящих (направления уточнить на стенде).
  constructor (keyTx, keyRx) {
    this.enc = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyTx) // AES-128-ECB variant 2, PKCS7
    this.dec = new VSSymmetricCrypt().setCipher(1, 2).setKey(keyRx)
  }

  // Прикладное сообщение → байты тела на провод.
  // fields: [{name,type,value}] — VS_Variant-поля (включая Method строкой).
  // Кадр [flen][dsize][coded] шифруется целиком (PKCS7 даёт кратность блоку).
  encodeBody (fields) {
    return this.enc.encrypt(buildFrame(fields))
  }

  // Байты тела с провода → список полей VS_Variant.
  // Снять PKCS7 (decrypt), затем распарсить кадр [flen][dsize][coded].
  decodeBody (body) {
    return parseFrame(this.dec.decrypt(body))
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

module.exports = { VSSession, appMessage, parseFrame }
