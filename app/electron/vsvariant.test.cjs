'use strict'
const assert = require('assert')
const vv = require('./vsvariant.cjs')
const vecs = require('./native_testvectors.json')
let ok = 0
for (const v of vecs) {
  const input = Buffer.from(v.in, 'hex')
  const enc = vv.encode(input)
  // 1) энкодер совпал с Python байт-в-байт
  assert.strictEqual(enc.toString('hex'), v.enc, `encode mismatch (size ${v.size})`)
  // 2) декодер восстанавливает вход
  if (input.length) {
    const dec = vv.decode(enc, input.length)
    assert.ok(dec && dec.equals(input), `decode round-trip fail (size ${v.size})`)
  }
  ok++
}
// 3) разбор реального поля-контейнера
const f = [{ name: 'v1_buf', type: 4, value: Buffer.from('01020304', 'hex') },
           { name: 'v2rnd', type: 3, value: Buffer.from('abcdef', 'hex') }]
const msg = vv.serialize(f)
const back = vv.deserialize(msg)
assert.strictEqual(back.length, 2)
assert.strictEqual(back[0].name, 'v1_buf'); assert.strictEqual(back[0].value.toString('hex'), '01020304')
assert.strictEqual(back[1].name, 'v2rnd'); assert.strictEqual(back[1].value.toString('hex'), 'abcdef')
console.log(`OK: ${ok}/${vecs.length} векторов совпали с Python, serialize/deserialize работает`)
