'use strict'
// IPConfig (UpdateConfiguration) обязан совпасть с захватом оф. клиента байт в байт.
const assert = require('assert')
const { buildIpConfig, ipConfigChecksum } = require('./vssession.cjs')
const CAPTURED = '8d75294f0d3139322e3136382e312e3131340013ad03546370000000380400000000040000901f00000000'
const got = buildIpConfig({ host: '192.168.1.114', port: 44307 })
assert.strictEqual(got.toString('hex'), CAPTURED, 'байты = захват оф. клиента (cap/tc_hook_out.txt #2)')
assert.strictEqual(ipConfigChecksum(Buffer.from(CAPTURED, 'hex').slice(4)), 0x4f29758d, 'сумма захвата')
const other = buildIpConfig({ host: '10.0.0.5', port: 1234 })
assert.strictEqual(other.readUInt32LE(0), ipConfigChecksum(other.slice(4)), 'сумма пересчитывается для другого адреса')
assert.strictEqual(other.length, 27 + 8 + 3, 'длина = 27 + IP + "Tcp"')
console.log('OK: IPConfig совпадает с захватом оф. клиента')
