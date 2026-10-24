'use strict'
// Транспорт нативного протокола TrueConf (порт 4307), проверяемая часть:
// преамбула _VS_TRANSPORT_, разбор ответа сервера, чтение кадров и декод
// контейнеров VS_Variant. Форматы сверены с живым захватом tc.t2.ru
// (см. vstransport.test.cjs и native_capture_fixtures.json).
//
// Кадр на проводе:  [flen:u32 LE][dsize:u32 LE][range-coded: flen-4 байт]
//   flen  — длина (dsize-поле + сжатые данные), dsize — размер после распаковки.
// Дальнейшие шаги рукопожатия (приём сертификата сервера, RSA-обмен v2rnd,
// вывод ключа key=HASH(v1_buf‖v2rnd), AES/ГОСТ-сессия) реализуются поверх
// этого слоя — см. SPEC-native-transport.md в проекте разбора.

const vv = require('./vsvariant.cjs')

const MAGIC = Buffer.from('_VS_TRANSPORT_\0\0', 'latin1') // 16 байт

// Заголовок минимальной преамбулы (4Б после MAGIC). Это НЕ случайный нонс, а
// вычисляемое значение, которое сервер ПРОВЕРЯЕТ: случайное → мгновенный FIN,
// а это — принимает (подтверждено живьём на tc.t2.ru, одно и то же значение
// переиспользуется без проблем → для фиксированной 26Б преамбулы оно константа).
const PREAMBLE_HEADER = 0x002bef99

// Клиентская преамбула: MAGIC + header(4 LE) + 0(4) + 0x0001(2) = 26 байт.
function buildClientPreamble (header = PREAMBLE_HEADER) {
  const h = Buffer.alloc(4); h.writeUInt32LE(header >>> 0)
  return Buffer.concat([MAGIC, h, Buffer.from([0, 0, 0, 0, 0, 1])])
}

// Разбор ответа сервера: MAGIC + заголовок(9) + поле-realm + поле-sessionId + хвост.
// Строковое поле на проводе: [len:1][bytes:len][0x00] (длина без завершающего нуля).
function parseServerPreamble (buf) {
  if (buf.length < 26 || !buf.slice(0, 16).equals(MAGIC)) return null
  let p = 16
  const header = buf.slice(p, p + 9); p += 9 // 4+4+1 (контрольные/флаги)
  const readStr = () => { const n = buf[p++]; const s = buf.slice(p, p + n).toString('latin1'); p += n + 1; return s } // +1 = завершающий 0x00
  const realm = readStr()
  const sessionId = readStr()
  return { header, realm, sessionId, consumed: p + 1 } // +1 = финальный байт хвоста
}

// Читатель кадров из потока (накопительный).
class FrameReader {
  constructor () { this.buf = Buffer.alloc(0) }
  push (chunk) { this.buf = Buffer.concat([this.buf, chunk]) }
  // Возвращает следующий кадр как {dsize, coded} или null, если данных мало.
  next () {
    if (this.buf.length < 8) return null
    const flen = this.buf.readUInt32LE(0)
    if (flen < 4 || this.buf.length < 4 + flen) return null
    const dsize = this.buf.readUInt32LE(4)
    const coded = this.buf.slice(8, 4 + flen)
    this.buf = this.buf.slice(4 + flen)
    return { dsize, coded }
  }
  // Следующий кадр уже как список полей VS_Variant (или null).
  nextFields () {
    const f = this.next()
    if (!f) return null
    const raw = vv.decode(f.coded, f.dsize)
    return raw ? vv.parseContainer(raw) : null
  }
}

// Упаковать VS_Variant-поля в кадр для отправки.
function buildFrame (fields) {
  const msg = vv.serialize(fields) // [dsize u32 LE][coded]
  const flen = Buffer.alloc(4); flen.writeUInt32LE(msg.length) // dsize-поле(4)+coded
  return Buffer.concat([flen, msg])
}

module.exports = { MAGIC, buildClientPreamble, parseServerPreamble, FrameReader, buildFrame }
