'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const t = require('./vstransport.cjs')

// 1) Формат клиентской преамбулы (чистый, без данных захвата)
const cp = t.buildClientPreamble(0x002bef99)
assert.strictEqual(cp.length, 26)
assert.strictEqual(cp.toString('hex'), '5f56535f5452414e53504f52545f000099ef2b00000000000001', 'client preamble format')

// 2) Сверка с живым захватом — только если локальные фикстуры на месте (gitignored)
const fxP = path.join(__dirname, 'native_capture_fixtures.json')
const frP = path.join(__dirname, '.cert_frame.bin')
if (fs.existsSync(fxP)) {
  const fx = JSON.parse(fs.readFileSync(fxP, 'utf8'))
  assert.strictEqual(cp.toString('hex'), fx.client_preamble26, 'клиентская преамбула == захват')
  const sp = t.parseServerPreamble(Buffer.from(fx.server_preamble74, 'hex'))
  assert.strictEqual(sp.realm, 'tc.t2.ru#vcs', 'realm из серверной преамбулы')
  assert.strictEqual(sp.sessionId.length, 32, 'ID сессии 32 hex-символа')
  if (fs.existsSync(frP)) {
    const r = new t.FrameReader(); r.push(fs.readFileSync(frP))
    const fields = r.nextFields()
    const names = fields.map(f => f.name)
    assert.ok(names.includes('Certificate'), 'кадр сервера декодирован: есть поле Certificate')
    const cert = fields.find(f => f.name === 'Certificate').value.toString('latin1')
    assert.ok(cert.startsWith('-----BEGIN CERTIFICATE-----'), 'сертификат — валидный PEM')
    console.log('OK: преамбула, разбор ответа сервера и декод кадра сертификата сверены с живым захватом')
  } else console.log('OK: формат преамбулы ок; .cert_frame.bin нет — декод кадра пропущен')
} else {
  console.log('OK: формат преамбулы ок; фикстур захвата нет (норма для чистого репо)')
}
