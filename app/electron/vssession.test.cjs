'use strict'
const assert = require('assert')
const crypto = require('crypto')
const { VSSession, appMessage } = require('./vssession.cjs')

// Два сессионных ключа (как из EVP_Seal). tx одного конца = rx другого.
const k1 = crypto.randomBytes(16)
const k2 = crypto.randomBytes(16)
const client = new VSSession(k1, k2) // шлёт k1, принимает k2
const server = new VSSession(k2, k1) // зеркало

// Прикладное сообщение логина (семантика как в мосте TrueConfX)
const msg = appMessage('LoginUser', { Login: 'user@tc.t2.ru', Password: 'md5hex', KeepAutologin: { t: 1, v: Buffer.from('01000000', 'hex') } })

// Клиент кодирует → «сервер» (зеркало) декодирует
const body = client.encodeBody(msg)
assert.ok(body.length % 16 === 0, 'тело кратно блоку AES')
const got = server.decodeBody(body)
const map = Object.fromEntries(got.map(f => [f.name, f.value.toString('latin1')]))
assert.strictEqual(map.Method, 'LoginUser', 'Method прошёл')
assert.strictEqual(map.Login, 'user@tc.t2.ru', 'Login прошёл')
assert.strictEqual(map.Password, 'md5hex', 'Password прошёл')

// И обратное направление
const resp = server.encodeBody(appMessage('LoginResponse', { result: { t: 1, v: Buffer.from('00000000', 'hex') }, CID: '12345' }))
const back = client.decodeBody(resp)
assert.strictEqual(back.find(f => f.name === 'Method').value.toString('latin1'), 'LoginResponse')
assert.strictEqual(back.find(f => f.name === 'CID').value.toString('latin1'), '12345')

console.log('OK: сессионный слой — round-trip прикладного сообщения в обе стороны (AES-128-ECB + VS_Variant)')
