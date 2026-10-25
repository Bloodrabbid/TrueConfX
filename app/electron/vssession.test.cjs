'use strict'
const assert = require('assert')
const crypto = require('crypto')
const {
  VSSession,
  appMessage,
  buildFixedPartMessage,
  computeAppEndpId,
  loadOfficialCredentials,
  buildTrackerAnnounceMessage,
  parseTrackerAnnounceResponse,
  connectAndLogin
} = require('./vssession.cjs')
const p2p = require('./p2p.cjs')

// Два сессионных ключа (как из EVP_Seal). tx одного конца = rx другого.
const k1 = crypto.randomBytes(16)
const k2 = crypto.randomBytes(16)
const client = new VSSession(k1, k2) // шлёт k1, принимает k2
const server = new VSSession(k2, k1) // зеркало

// 1) Прикладное сообщение логина (сервис AUTH)
const msg = appMessage('LoginUser', { Login: 'user@tc.t2.ru', Password: 'md5hex', ClientType: { t: 1, v: Buffer.from('01000000', 'hex') } })
const body = client.encodeBody(msg, { service: 'AUTH', from: '', connId: 'conn1', id: 7, timeout: 20000 })
assert.ok(body.length % 16 === 0, 'тело кратно блоку AES (PKCS7)')
const got = server.decodeBody(body)
assert.strictEqual(got.service, 'AUTH', 'сервис в конверте')
assert.strictEqual(got.connId, 'conn1', 'connId в конверте')
assert.strictEqual(got.tag, '54', 'тег протокола "54"')
assert.strictEqual(got.data.Method, 'LoginUser', 'Method прошёл')
assert.strictEqual(got.data.Login, 'user@tc.t2.ru', 'Login прошёл')
assert.strictEqual(got.data.Password, 'md5hex', 'Password прошёл')
assert.strictEqual(got.data.ClientType, 1, 'ClientType u32 прошёл')

// 2) Обратное направление (ответ сервера)
const resp = server.encodeBody(appMessage('LoginResponse', { result: { t: 1, v: 0 }, CID: '12345' }), { service: 'AUTH', from: 'server' })
const back = client.decodeBody(resp)
assert.strictEqual(back.service, 'AUTH')
assert.strictEqual(back.data.Method, 'LoginResponse')
assert.strictEqual(back.data.CID, '12345')

// 3) Потоковое чтение pushCiphertext: склейка 3 конвертов и нарезка по 7 байт
{
  const c1 = server.encodeBody(appMessage('CheckUserLoginStatus', {}), { service: 'AUTH', id: 2 })
  const c2 = server.encodeBody(appMessage('Subscribe', { Cause: 1, CallId: ['a@tc', 'b@tc', 'c@tc'] }), { service: 'PRESENCE', from: 'ABOOK', id: 19 })
  const c3 = server.encodeBody(appMessage('GetCurrentTime', { Seq: 123456789012345n }), { service: 'Time', from: 'CHATV2', id: 18 })
  const combined = Buffer.concat([c1, c2, c3])
  const rx = new VSSession(k1, k2)
  const parsed = []
  for (let i = 0; i < combined.length; i += 7) {
    parsed.push(...rx.pushCiphertext(combined.slice(i, i + 7)))
  }
  assert.strictEqual(parsed.length, 3, 'распарсено ровно 3 склеенных и фрагментированных конверта')
  assert.strictEqual(parsed[0].id, 2)
  assert.strictEqual(parsed[0].data.Method, 'CheckUserLoginStatus')
  assert.strictEqual(parsed[1].id, 19)
  assert.strictEqual(parsed[1].from, 'ABOOK')
  assert.strictEqual(parsed[1].service, 'PRESENCE')
  assert.deepStrictEqual(parsed[1].data.CallId, ['a@tc', 'b@tc', 'c@tc'], 'повторяющиеся поля CallId сохранены')
  assert.strictEqual(parsed[2].id, 18)
  assert.strictEqual(parsed[2].data.Seq, 123456789012345n)
}

// 4) Проверка раскладки конверта (FUN_1001c9e70): байт0, hdrLen@2, payloadLen@5..7
const pl = Buffer.from('payload-bytes-here')
const env = buildFixedPartMessage(pl, { service: 'CLIENT', connId: 'c', id: 1, timeout: 2 })
assert.strictEqual(env[0], 0x81 | (1 << 6), 'байт0 = 0x81|флаги (0xC1)')
const hdrLen = env.readUInt16LE(2)
const payloadLen = (env[5] | (env[6] << 8) | (env[7] << 16)) + 1
assert.strictEqual(payloadLen, pl.length, 'payloadLen@5..7 = длина payload')
assert.ok(env.slice(hdrLen, hdrLen + payloadLen).equals(pl), 'payload лежит с off hdrLen')
assert.strictEqual(env.readUInt32LE(8), 1, 'id@8')
assert.strictEqual(env.readUInt32LE(12), 2, 'timeout@0xc')

// 5) Формула AppEndpId (FUN_100355e50)
const h = computeAppEndpId({ serial: 'S1', uuid: 'U1', username: 'usr', appName: 'TrueConf OS X' })
assert.strictEqual(h.length, 32)
assert.notStrictEqual(h, computeAppEndpId({ serial: 'S2', uuid: 'U1', username: 'usr', appName: 'TrueConf OS X' }), 'мутация серийника меняет AppEndpId')

// 6) Сборка и разбор TrackerAnnounce (FUN_102c1ee70 / FUN_102c1ff60)
{
  const infoHash = 'A4FD6003BE0FE2CA7917B50914189D8A17D478BF'
  const peerId = '-LT1270-112233445566'
  const reqFields = buildTrackerAnnounceMessage({
    infoHash,
    peerId,
    endpoints: [{ host: '192.168.1.10', port: 44307 }, { host: '10.0.0.5', port: 44307 }],
    event: 1,
    requestId: 777n
  })
  const wire = client.encodeBody(reqFields, { from: 'TORRENT', service: 'TORRENT', extra: 'tc.t2.ru#vcs' })
  const decoded = server.decodeBody(wire)
  assert.strictEqual(decoded.service, 'TORRENT')
  assert.strictEqual(decoded.extra, 'tc.t2.ru#vcs')
  assert.strictEqual(decoded.data.Method, 'TrackerAnnounce')
  assert.strictEqual(decoded.data.TorrentInfoHash, infoHash.toLowerCase(), 'info_hash сериализуется в lowercase')
  assert.strictEqual(decoded.data.TorrentPeerId, peerId)
  assert.strictEqual(decoded.data.TorrentPeerEndpoints, '192.168.1.10:44307;10.0.0.5:44307;')
  assert.strictEqual(decoded.data.AnnounceEvent, 1)
  assert.strictEqual(decoded.data.AnnounceRequestId, 777n)

  const respFields = appMessage('TrackerAnnounce', [
    ['TorrentInfoHash', infoHash.toLowerCase()],
    ['AnnounceInterval', 60n],
    ['PeersListParam', '192.168.1.10:44307;10.0.0.5:44307;'],
    ['BCPeersListParam', ''],
    ['AnnounceRequestId', 777n]
  ])
  const parsedResp = parseTrackerAnnounceResponse(respFields)
  assert.strictEqual(parsedResp.infoHash, infoHash.toLowerCase())
  assert.strictEqual(parsedResp.requestId, 777n)
  assert.deepStrictEqual(parsedResp.peers, [
    { host: '192.168.1.10', port: 44307 },
    { host: '10.0.0.5', port: 44307 }
  ])
}

console.log('OK: сессионный слой — конверт VS_FixedPartMessage + SessionReader + AppEndpId + TrackerAnnounce')

// 7) Живой интеграционный тест входа, сервисов и TrackerAnnounce (если доступен settings.sqlite официального клиента)
;(async () => {
  const creds = loadOfficialCredentials('tc.t2.ru')
  if (!creds) {
    console.log('SKIP: settings.sqlite официального клиента не найден — живой тест входа пропущен')
    return
  }
  const live = await connectAndLogin(creds)
  try {
    assert.strictEqual(live.result, 0, 'Result=0 при живом входе')
    assert.ok(live.account.UserName && live.account.UserName.startsWith(creds.login + '/'), 'вернулся UserName с новым cid')
    assert.ok(live.account.Session && live.account.Session.length > 0, 'вернулся Session-токен')
    console.log(`OK: живой вход на ${creds.host}:${creds.port} — Result=0, UserName=${live.account.UserName}, Session=${live.account.Session.slice(0, 8)}…`)

    // Проверим базовые сервисы после входа
    const props = await live.getAppProps()
    assert.strictEqual(props.Method, 'SetProps')
    assert.strictEqual(props.tc_trackers, 'tc.t2.ru#vcs', 'сервер вернул tc_trackers = tc.t2.ru#vcs')

    const timeData = await live.getCurrentTime({ seq: 42n })
    assert.strictEqual(timeData.Method, 'GetCurrentTime')
    assert.strictEqual(timeData.Seq, 42n)
    assert.ok(Buffer.isBuffer(timeData.time) && timeData.time.length === 8, 'сервер вернул 8-байтовую метку времени')

    live.updateStatus(1)
    const abook = await live.searchAddressBook({ addressBook: 1 })
    assert.strictEqual(abook.Method, 'SearchAddressBook')
    assert.ok(abook.UserName, 'вернулись записи адресной книги')
    console.log('OK: живые сервисы NET_CONFIG (GetAppProps) + Time (GetCurrentTime) + PRESENCE + ABOOK (SearchAddressBook)')

    // Живой цикл TrackerAnnounce: peerA анонсирует раздачу → peerB получает его endpoint в PeersListParam → остановка раздачи
    const testHash = crypto.createHash('sha1').update('trueconfx-live-tracker-test-' + Date.now()).digest('hex')
    const peerA = p2p.makePeerId()
    const peerB = p2p.makePeerId()
    await live.trackerAnnounce({
      infoHash: testHash,
      peerId: peerA,
      endpoints: '192.168.1.114:55111;',
      event: 1
    })
    const disc = await live.trackerAnnounce({
      infoHash: testHash,
      peerId: peerB,
      endpoints: '192.168.1.114:55222;',
      event: 1
    })
    assert.ok(
      disc.allPeers.some(p => p.host === '192.168.1.114' && p.port === 55111),
      `TrackerAnnounce вернул зарегистрированный пир 192.168.1.114:55111 (получено: ${JSON.stringify(disc.allPeers)})`
    )
    // Снимаем тестовые пиры с раздачи (event=3 stopped)
    await live.trackerAnnounce({ infoHash: testHash, peerId: peerA, endpoints: '192.168.1.114:55111;', event: 3 })
    await live.trackerAnnounce({ infoHash: testHash, peerId: peerB, endpoints: '192.168.1.114:55222;', event: 3 })
    console.log('OK: живой TrackerAnnounce (TORRENT) — регистрация пира, получение PeersListParam и снятие с раздачи')

    // Живое скачивание реальной картинки из чата через p2p.fetchFile с единым peerId и нативной сессией
    const imgBuf = await p2p.fetchFile(['tc.t2.ru'], 'a163df931f42507a082ae39f2361598be355bc94', null, { nativeSession: live })
    assert.strictEqual(imgBuf.length, 39742, 'скачан WEBP-файл 39742 байт')
    assert.strictEqual(imgBuf.slice(0, 4).toString('latin1'), 'RIFF', 'заголовок RIFF корректен')
    assert.strictEqual(imgBuf.slice(8, 12).toString('latin1'), 'WEBP', 'заголовок WEBP корректен')
    console.log('OK: живое скачивание вложения через p2p.fetchFile (TrackerAnnounce + MSE + BitTorrent, 39742 байт WEBP)')
  } finally {
    live.close()
  }
})().catch(err => {
  console.error('FAIL живого теста:', err)
  process.exit(1)
})
