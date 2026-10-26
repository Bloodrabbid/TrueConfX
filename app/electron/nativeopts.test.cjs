'use strict'
// configureNativeSession не должен рвать живую сессию, если настройки не поменялись.
const assert = require('assert')
const { nativeOptsChanged } = require('./vssession.cjs')
const cur = { host: 'tc.t2.ru', login: 'kirill@tc.t2.ru', cid: 'ab', key: 'K1', password: 'p' }
assert.strictEqual(nativeOptsChanged(cur, { ...cur }), false, 'те же настройки — не пересоздаём')
assert.strictEqual(nativeOptsChanged(cur, {}), false, 'пустой вызов — не пересоздаём')
assert.strictEqual(nativeOptsChanged(cur, { host: undefined, login: 'kirill@tc.t2.ru' }), false, 'undefined = не трогать')
assert.strictEqual(nativeOptsChanged(cur, { key: 'K2' }), true, 'новый ключ — пересоздаём')
assert.strictEqual(nativeOptsChanged(cur, { host: 'tc3.t2.ru' }), true, 'другой сервер — пересоздаём')
assert.strictEqual(nativeOptsChanged(null, { host: 'tc.t2.ru' }), true, 'первая настройка — создаём')
console.log('OK: нативная сессия пересоздаётся только при смене настроек')
