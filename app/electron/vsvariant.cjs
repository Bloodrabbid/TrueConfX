'use strict'
// Кодек контейнера VS_Variant нативного протокола TrueConf (порт 4307).
// Адаптивный range-кодер. Порт проверенной Python-реализации
// (TrueConf-RE/tools/vs_rangecoder.py), сверен байт-в-байт по native_testvectors.json.
// Поле контейнера на проводе: [len_имени][имя][0x00][тип][значение].
// Типы: 0=пусто, 1=u32(4Б), 2/5=u64(8Б), 3=строка / 4=байты (префикс длины u32 LE).

const M32 = 0xffffffff
const u32 = (x) => x >>> 0
const mul = (a, b) => (a * b) >>> 0 // a*b может превысить 2^32 — маскируем как ToUint32

function decode (comp, outSize) {
  const n = comp.length
  if (n < 4 || outSize === 0) return null
  const bound = [0, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0]
  const freq = new Int32Array(256)
  let code = (comp[0] * 0x1000000 + comp[1] * 0x10000 + comp[2] * 0x100 + comp[3]) >>> 0
  let pos = 4
  let low = 0
  let rng = M32
  let total = 0x100
  const out = Buffer.alloc(outSize)
  let oi = 0
  while (oi < outSize) {
    const divisor = Math.floor(rng / total)
    if (divisor === 0) return null
    const target = Math.floor((u32(code - low)) / divisor)
    if (target >= total) return null
    const i1 = bound[7]
    let sym, cumv
    if (target < bound[4]) {
      let gOff, cum
      if (target < bound[2]) {
        if (target < bound[1]) {
          bound[1] += 0x40; bound[3] += 0x40; bound[2] += 0x40; bound[5] += 0x40; bound[4] += 0x40
          gOff = 0; cum = 0
        } else {
          bound[3] += 0x40; bound[2] += 0x40; bound[5] += 0x40; bound[4] += 0x40
          gOff = 0x20; cum = bound[1]
        }
      } else if (target < bound[3]) {
        bound[3] += 0x40; bound[5] += 0x40; bound[4] += 0x40
        gOff = 0x40; cum = bound[2]
      } else {
        bound[5] += 0x40; bound[4] += 0x40
        gOff = 0x60; cum = bound[3]
      }
      bound[6] += 0x40
      sym = gOff; bound[7] = i1 + 0x40; cumv = cum
    } else {
      if (target < bound[6]) {
        let gOff = 0xa0; let cum = bound[5]
        if (target < bound[5]) { bound[5] += 0x40; gOff = 0x80; cum = bound[4] }
        bound[6] += 0x40
        sym = gOff; bound[7] = i1 + 0x40; cumv = cum
      } else {
        sym = 0xe0; cumv = bound[7]
        if (bound[7] <= target) {
          // группа 7: границы не трогаем
        } else {
          sym = 0xc0; bound[7] = i1 + 0x40; cumv = bound[6]
        }
      }
    }
    while (true) {
      const nxt = cumv + freq[sym] + 1
      if (target < nxt) break
      sym += 1; cumv = nxt
      if (sym === 0x100) break
    }
    if (sym >= 0x100) return null
    const fsym = freq[sym]
    out[oi++] = sym & 0xff
    const i38 = Math.floor(rng / total)
    low = u32(low + mul(cumv, i38))
    rng = mul(fsym + 1, i38)
    let chk = u32(u32(rng + low) ^ low)
    let done = false
    while (true) {
      if (chk > 0xffffff) {
        if (rng > 0xffff) { done = true; break }
        rng = (-low) & 0xffff
      }
      if (pos >= n) break
      code = u32(code * 0x100 + comp[pos++])
      rng = u32(rng * 0x100)
      low = u32(low * 0x100)
      chk = u32(u32(rng + low) ^ low)
    }
    if (!done) break
    freq[sym] = fsym + 0x40
    total += 0x40
    if (total > 0x10000) {
      let acc = 0
      for (let g = 0; g < 8; g++) {
        bound[g] = acc
        let s = 0; const base = g * 32
        for (let i = 0; i < 32; i++) { const h = freq[base + i] >> 1; freq[base + i] = h; s += h }
        acc = acc + s + 0x20
      }
      total = acc
    }
  }
  return out
}

function encode (data) {
  const bound = [0, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0]
  const freq = new Int32Array(256)
  let low = 0
  let rng = M32
  let total = 0x100
  const out = []
  for (const sym of data) {
    const g = sym >> 5
    let cum = bound[g]
    for (let i = g * 32; i < sym; i++) cum += freq[i] + 1
    const fsym = freq[sym]
    const i38 = Math.floor(rng / total)
    low = u32(low + mul(cum, i38))
    rng = mul(fsym + 1, i38)
    let chk = u32(u32(rng + low) ^ low)
    while (true) {
      if (chk > 0xffffff) {
        if (rng > 0xffff) break
        rng = (-low) & 0xffff
      }
      out.push((low >>> 24) & 0xff)
      rng = u32(rng * 0x100)
      low = u32(low * 0x100)
      chk = u32(u32(rng + low) ^ low)
    }
    for (let k = g + 1; k < 8; k++) bound[k] += 0x40
    freq[sym] = fsym + 0x40
    total += 0x40
    if (total > 0x10000) {
      let acc = 0
      for (let gg = 0; gg < 8; gg++) {
        bound[gg] = acc
        let s = 0; const base = gg * 32
        for (let i = 0; i < 32; i++) { const h = freq[base + i] >> 1; freq[base + i] = h; s += h }
        acc = acc + s + 0x20
      }
      total = acc
    }
  }
  out.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff)
  return Buffer.from(out)
}

function parseContainer (buf) {
  const fields = []
  let p = 0; const n = buf.length
  while (p + 2 <= n) {
    const nl = buf[p]
    if (p + nl + 1 >= n || buf[p + nl] !== 0) break
    let end = p + 1
    while (end < p + nl && buf[end] !== 0) end++
    const name = buf.slice(p + 1, end).toString('latin1')
    const t = buf[p + nl + 1]
    const q = p + nl + 2
    let val, step
    if (t === 0) { val = Buffer.alloc(0); step = 0 } else if (t === 1) { val = buf.slice(q, q + 4); step = 4 } else if (t === 2 || t === 5) { val = buf.slice(q, q + 8); step = 8 } else if (t === 3 || t === 4) {
      if (q + 4 > n) break
      const ln = buf.readUInt32LE(q)
      val = buf.slice(q + 4, q + 4 + ln); step = 4 + ln
    } else break
    fields.push({ name, type: t, value: val })
    p = q + step
  }
  return fields
}

// Сериализация VS_Variant-сообщения на провод: [размер u32 LE][range-coded].
function serialize (fields) {
  const parts = []
  for (const f of fields) {
    const nameB = Buffer.from(f.name, 'latin1')
    parts.push(Buffer.from([nameB.length + 1]), nameB, Buffer.from([0, f.type]))
    const v = f.value || Buffer.alloc(0)
    if (f.type === 3 || f.type === 4) { const h = Buffer.alloc(4); h.writeUInt32LE(v.length); parts.push(h, v) } else if (f.type !== 0) parts.push(v)
  }
  const raw = Buffer.concat(parts)
  const sz = Buffer.alloc(4); sz.writeUInt32LE(raw.length)
  return Buffer.concat([sz, encode(raw)])
}

function deserialize (msg) {
  if (msg.length < 4) return null
  const sz = msg.readUInt32LE(0)
  const raw = decode(msg.slice(4), sz)
  return raw ? parseContainer(raw) : null
}

module.exports = { decode, encode, parseContainer, serialize, deserialize }
