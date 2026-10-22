// MD5 для credentialsType=4 (сервер принимает md5 пароля в hex).
export function md5(str: string): string {
  const bytes = new TextEncoder().encode(str)
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0
  const len = bytes.length, nBlocks = ((len + 8) >> 6) + 1
  const w = new Uint32Array(nBlocks * 16)
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8)
  w[len >> 2] |= 0x80 << ((len % 4) * 8)
  w[nBlocks * 16 - 2] = (len * 8) >>> 0
  w[nBlocks * 16 - 1] = Math.floor(len / 0x20000000)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let b = 0; b < nBlocks; b++) {
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      const s = S[(i >> 4) * 4 + (i % 4)]
      const x = (A + F + K[i] + w[b * 16 + g]) >>> 0
      A = D; D = C; C = B
      B = (B + ((x << s) | (x >>> (32 - s)))) >>> 0
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
  }
  return [a0, b0, c0, d0].map(v => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 255).toString(16).padStart(2, '0')).join('')).join('')
}
