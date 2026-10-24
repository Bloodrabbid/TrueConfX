'use strict'
const assert = require('assert')
const crypto = require('crypto')
const { VSSession, appMessage, buildFixedPartMessage, parseFixedPartMessage } = require('./vssession.cjs')

// Два сессионных ключа (как из EVP_Seal). tx одного конца = rx другого.
const k1 = crypto.randomBytes(16)
const k2 = crypto.randomBytes(16)
const client = new VSSession(k1, k2) // шлёт k1, принимает k2
const server = new VSSession(k2, k1) // зеркало

// Прикладное сообщение логина (сервис AUTH; семантика как в мосте TrueConfX)
const msg = appMessage('LoginUser', { Login: 'user@tc.t2.ru', Password: 'md5hex', ClientType: { t: 1, v: Buffer.from('01000000', 'hex') } })

// Клиент кодирует (конверт VS_FixedPartMessage на сервис AUTH) → «сервер» декодирует
const body = client.encodeBody(msg, { service: 'AUTH', from: '', connId: 'conn1', id: 7, timeout: 20000 })
assert.ok(body.length % 16 === 0, 'тело кратно блоку AES (PKCS7)')
const got = server.decodeBody(body)
assert.strictEqual(got.service, 'AUTH', 'сервис в конверте')
assert.strictEqual(got.connId, 'conn1', 'connId в конверте')
assert.strictEqual(got.tag, '54', 'тег протокола "54"')
const map = Object.fromEntries(got.fields.map(f => [f.name, f.value.toString('latin1')]))
assert.strictEqual(map.Method, 'LoginUser', 'Method прошёл')
assert.strictEqual(map.Login, 'user@tc.t2.ru', 'Login прошёл')
assert.strictEqual(map.Password, 'md5hex', 'Password прошёл')

// Обратное направление (ответ сервера)
const resp = server.encodeBody(appMessage('LoginResponse', { result: { t: 1, v: Buffer.from('00000000', 'hex') }, CID: '12345' }), { service: 'AUTH', from: 'server' })
const back = client.decodeBody(resp)
assert.strictEqual(back.service, 'AUTH')
assert.strictEqual(back.fields.find(f => f.name === 'Method').value.toString('latin1'), 'LoginResponse')
assert.strictEqual(back.fields.find(f => f.name === 'CID').value.toString('latin1'), '12345')

// Проверка самой раскладки конверта (FUN_1001c9e70): байт0, hdrLen@2, payloadLen@5..7
const pl = Buffer.from('payload-bytes-here')
const env = buildFixedPartMessage(pl, { service: 'CLIENT', connId: 'c', id: 1, timeout: 2 })
assert.strictEqual(env[0], 0x81 | (1 << 6), 'байт0 = 0x81|флаги (0xC1)')
const hdrLen = env.readUInt16LE(2)
const payloadLen = (env[5] | (env[6] << 8) | (env[7] << 16)) + 1
assert.strictEqual(payloadLen, pl.length, 'payloadLen@5..7 = длина payload')
assert.ok(env.slice(hdrLen, hdrLen + payloadLen).equals(pl), 'payload лежит с off hdrLen')
assert.strictEqual(env.readUInt32LE(8), 1, 'id@8')
assert.strictEqual(env.readUInt32LE(12), 2, 'timeout@0xc')

console.log('OK: сессионный слой — конверт VS_FixedPartMessage + AES-128-ECB-PKCS7, round-trip обе стороны')
