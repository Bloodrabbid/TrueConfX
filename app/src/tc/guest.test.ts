// Тест чистой логики кросс-сервер гостевого входа. Запуск без зависимостей:
//   node --test app/src/tc/guest.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confServerHost, isCrossServer, confNumber, extractGuestToken, parseConfLink } from './guest.ts'

test('confServerHost: берёт хост после @, убирает #vcs и /instance', () => {
  assert.equal(confServerHost('2811027@tc2.t2.ru', 'tc.t2.ru'), 'tc2.t2.ru')
  assert.equal(confServerHost('2811027@tc2.t2.ru#vcs', 'tc.t2.ru'), 'tc2.t2.ru')
  assert.equal(confServerHost('u@tc2.t2.ru/0000', 'tc.t2.ru'), 'tc2.t2.ru')
})

test('confServerHost: без @ возвращает домашний хост', () => {
  assert.equal(confServerHost('2811027', 'tc.t2.ru'), 'tc.t2.ru')
})

test('isCrossServer: другой сервер = true, тот же (без учёта регистра) = false', () => {
  assert.equal(isCrossServer('2811027@tc2.t2.ru', 'tc.t2.ru'), true)
  assert.equal(isCrossServer('2811027@tc.t2.ru', 'tc.t2.ru'), false)
  assert.equal(isCrossServer('2811027@TC.T2.RU', 'tc.t2.ru'), false)
  assert.equal(isCrossServer('2811027', 'tc.t2.ru'), false)
})

test('confNumber: убирает \\c\\ и @host', () => {
  assert.equal(confNumber('2811027@tc2.t2.ru#vcs'), '2811027')
  assert.equal(confNumber('\\c\\2811027@tc2.t2.ru'), '2811027')
  assert.equal(confNumber('2811027'), '2811027')
})

test('extractGuestToken: достаёт $2…*время*md5 из строки и из JSON', () => {
  const tok = '$2YVZqHdJXiO*1794919129*7d754ebb21d48db4abddaad6ee636369'
  assert.equal(extractGuestToken(`...&token=${tok}&lang=auto`), tok)
  assert.equal(extractGuestToken({ clients: [{ web_url: `https://h/webrtc/1#login=*guest*&token=${tok}` }] }), tok)
})

test('extractGuestToken: нет токена → undefined', () => {
  assert.equal(extractGuestToken({ clients: [] }), undefined)
  assert.equal(extractGuestToken(''), undefined)
  assert.equal(extractGuestToken(null), undefined)
})

test('parseConfLink: веб-ссылка сохраняет сервер как <id>@<host>', () => {
  assert.equal(parseConfLink('https://tc2.t2.ru/c/2811027'), '2811027@tc2.t2.ru')
  assert.equal(parseConfLink('https://tc2.t2.ru/webrtc/2811027#login=*guest*'), '2811027@tc2.t2.ru')
  assert.equal(parseConfLink('https://tc.t2.ru:443/c/55'), '55@tc.t2.ru')
})

test('parseConfLink: deeplink trueconf несёт сервер внутри id', () => {
  assert.equal(parseConfLink('trueconf:\\c\\2811027@tc2.t2.ru#vcs&h=tc2.t2.ru'), '2811027@tc2.t2.ru#vcs')
})

test('parseConfLink: голый id и id@host — как есть; мусор → undefined', () => {
  assert.equal(parseConfLink('2811027'), '2811027')
  assert.equal(parseConfLink('2811027@tc2.t2.ru'), '2811027@tc2.t2.ru')
  assert.equal(parseConfLink('просто текст'), undefined)
})
