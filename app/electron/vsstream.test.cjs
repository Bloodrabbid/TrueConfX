'use strict'
// Тест нативного медиапотока: рукопожатие _VS_STREAMS_ и пакеты (SPEC-native-media.md, этапы 1–2).
const assert = require('assert')
const st = require('./vsstream.cjs')

// 1) Суммы заголовка net_handshake сверены с известной преамбулой основной сессии (u32 = 0x002bef99).
{
  const known = 0x002bef99
  const b = Buffer.alloc(26)
  b.write('_VS_TRANSPORT_', 0, 'latin1')
  b.writeUInt32LE((known & 0xfff8001f) >>> 0, 16)
  b[25] = 1
  assert.strictEqual(st.finalizeHandshake(b).readUInt32LE(16), known, 'суммы заголовка = преамбула основной сессии')
}

// 2) Запрос отправителя байт в байт с эталоном streams_handshake.py (FUN_1001ba500).
{
  const want = '5f56535f53545245414d535f00000000e1814a0300163030306658585858407463332e74322e727523766373000d6d654074632e74322e72752f31001070656572407463332e74322e72752f32000d6d654074632e74322e72752f31000526000000000000000000000000000000000000000000000000000000000000c0'
  const got = st.buildStreamsRequest({ conf: '000fXXXX@tc3.t2.ru#vcs', s: 'me@tc.t2.ru/1', r: 'peer@tc3.t2.ru/2', type: st.STREAM_SENDER })
  assert.strictEqual(got.toString('hex'), want, 'запрос отправителя = эталон')
  const recv = st.buildStreamsRequest({ conf: '000fXXXX@tc3.t2.ru#vcs', s: 'me@tc.t2.ru/1', r: 'peer@tc3.t2.ru/2', type: st.STREAM_RECEIVER })
  assert.strictEqual(recv[20], 1, 'получатель: байт типа 1')
}

// 3) Ответ: бит 0 тела = успех, 0xFF = без маски; маска переводится в треки.
{
  const head = Buffer.alloc(20); head.write('_VS_STREAMS_', 0, 'latin1')
  const body = Buffer.concat([Buffer.from([1, 5]), Buffer.alloc(32)])
  for (const t of [1, 2, 5, 254, 255]) body[2 + (t >> 3)] |= 1 << (t & 7)
  head.writeUInt32LE((((body.length - 1) << 19) | 1) >>> 0, 16)
  const r = st.parseStreamsResponse(st.finalizeHandshake(Buffer.concat([head, body, Buffer.from([9])])))
  assert.ok(r.ok); assert.deepStrictEqual(r.tracks, [1, 2, 5, 254, 255]); assert.strictEqual(r.rest.length, 1)
}

// 4) Пакет: заголовок 8 Б, сумма 0xAC + байты с шагом 234; разрезка по u16+8.
{
  const p = Buffer.alloc(500, 1); p[0] = 3; p[234] = 4; p[468] = 5
  assert.strictEqual(st.payloadChecksum(p), (0xac + 3 + 4 + 5) & 0xff)
  const two = Buffer.concat([st.buildPacket(1, 1000, p), st.buildPacket(254, 1001, Buffer.from([1, 4, 0, 0])), Buffer.from([7])])
  const { packets, rest } = st.splitPackets(two)
  assert.deepStrictEqual(packets.map(x => [x.track, x.len, x.time, x.sumOk]), [[1, 500, 1000, true], [254, 4, 1001, true]])
  assert.strictEqual(rest.length, 1)
}
assert.strictEqual(st.confHost('000f@tc3.t2.ru#vcs'), 'tc3.t2.ru')
console.log('OK: медиапоток — рукопожатие _VS_STREAMS_ (эталон), ответ, пакеты и суммы')
