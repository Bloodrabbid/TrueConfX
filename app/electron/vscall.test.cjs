'use strict'
// Тест сигналинга звонков: строитель → конверт+сериализация → разбор → сверка полей,
// порядка и сервиса. Байты проходят реальный кодек (vsvariant+конверт), только без AES.
const assert = require('assert')
const vc = require('./vscall.cjs')
const vv = require('./vsvariant.cjs')
const { buildFixedPartMessage, parseFixedPartMessage } = require('./vssession.cjs')

// Пропустить сообщение через провод (без шифра) и вернуть разбор.
function wire ({ fields, opts }) {
  const env = buildFixedPartMessage(vv.serialize(fields), { connId: 'c', id: 1, timeout: 20000, ...opts })
  const got = parseFixedPartMessage(env)
  assert.ok(got, 'конверт разобран')
  return got
}

// 1) Invite: сервис CONFERENCE, порядок Conference, Name, CallId, DirectConnect
{
  const g = wire(vc.invite({ conference: 'conf1@tc.t2.ru#vcs', peer: 'bob@tc.t2.ru', myName: 'kirill@tc.t2.ru' }))
  assert.strictEqual(g.service, 'CONFERENCE', 'Invite на сервис CONFERENCE')
  assert.strictEqual(g.data.Method, 'Invite')
  assert.strictEqual(g.data.Conference, 'conf1@tc.t2.ru#vcs')
  assert.strictEqual(g.data.CallId, 'bob@tc.t2.ru', 'CallId = вызываемый')
  assert.strictEqual(g.data.Name, 'kirill@tc.t2.ru', 'Name = моё имя')
  assert.strictEqual(g.data.DirectConnect, 1, 'DirectConnect u32')
  const names = g.fields.map(f => f.name)
  assert.deepStrictEqual(names, ['Method', 'Conference', 'Name', 'CallId', 'DirectConnect'], 'порядок полей Invite')
}

// 2) AudioOnly — поле-флаг (тип 0), присутствует только когда звонок без видео
{
  const g = wire(vc.invite({ conference: 'c', peer: 'b', myName: 'k', audioOnly: true }))
  const f = g.fields.find(x => x.name === 'AudioOnly')
  assert.ok(f && f.type === 0, 'AudioOnly — поле-флаг тип 0')
  const g2 = wire(vc.invite({ conference: 'c', peer: 'b', myName: 'k' }))
  assert.ok(!g2.fields.some(x => x.name === 'AudioOnly'), 'без audioOnly флага нет')
}

// 3) SDP offer: сервис CLIENT, Type=0, версии из живого кадра, to = instance пира
{
  const g = wire(vc.webrtcSdp({ sdp: 'v=0...', type: vc.WEBRTC_OFFER, conference: 'c', id: 'callid1', to: 'bob@tc.t2.ru/ab12' }))
  assert.strictEqual(g.service, 'CLIENT', 'SDP на сервис CLIENT')
  assert.strictEqual(g.to, 'bob@tc.t2.ru/ab12', 'to = пир')
  assert.strictEqual(g.data.Method, 'SendWebrtcMsg')
  assert.strictEqual(g.data.SdpParam, 'v=0...')
  assert.strictEqual(g.data.Type, 0, 'offer Type=0')
  assert.strictEqual(g.data.ClientRtcVersion, 3, 'ClientRtcVersion=3 (живой кадр)')
  assert.strictEqual(g.data.RtcVersion, 4, 'RtcVersion=4 (живой кадр)')
}

// 4) ICE-кандидат: Type=2 + SdpMid + MLineIndex
{
  const g = wire(vc.webrtcCandidate({ candidate: 'candidate:1 1 udp', sdpMid: '0', mLineIndex: 0, conference: 'c', id: 'x', to: 'bob' }))
  assert.strictEqual(g.data.Type, 2, 'кандидат Type=2')
  assert.strictEqual(g.data.SdpMidParam, '0')
  assert.strictEqual(g.data.MLineIndexParam, 0)
}

// 4б) Кандидат — ровно порядок полей живого кадра пира (cap/call_p2p_cap.txt, 26.10.2026).
{
  const g = wire(vc.webrtcCandidate({ candidate: 'candidate:1 1 udp', sdpMid: '0', mLineIndex: 0, conference: 'f@tc3.t2.ru#vcs', id: 'me@tc.t2.ru/1', to: 'peer@tc3.t2.ru/2' }))
  assert.deepStrictEqual(g.fields.map(f => f.name),
    ['Method', 'SdpParam', 'SdpMidParam', 'MLineIndexParam', 'Type', 'Conference', 'id', 'ClientRtcVersion', 'RtcVersion'],
    'порядок полей = живой кадр')
  assert.strictEqual(g.to, 'peer@tc3.t2.ru/2', 'to = экземпляр пира')
  assert.strictEqual(g.data.id, 'me@tc.t2.ru/1', 'id = свой экземпляр')
}

// 4в) Accept: Name = экземпляр звонящего из Invite (FUN_1002bec60), UserName = мы, без AppId.
{
  const g = wire(vc.accept({ conference: 'f@tc3.t2.ru#vcs', caller: 'peer@tc3.t2.ru/c6', me: 'me@tc.t2.ru/36' }))
  assert.strictEqual(g.data.Name, 'peer@tc3.t2.ru/c6', 'Name = звонящий')
  assert.strictEqual(g.data.UserName, 'me@tc.t2.ru/36', 'UserName = мы')
  assert.ok(!('AppId' in g.data), 'AppId не шлём, если его нет')
  assert.strictEqual(g.data.DirectConnect, 0, 'DirectConnect=0: слушателя прямых входящих нет (FUN_10034e8a0)')
}

// 4в2) Accept с DIRECT_RTC: 7 доходит до провода как u32 (звонящий выберет WebRTC, FUN_1002b07a0).
{
  const g = wire(vc.accept({ conference: 'f@tc3.t2.ru#vcs', caller: 'peer@tc3.t2.ru/c6', me: 'me@tc.t2.ru/36', directConnect: 7 }))
  assert.strictEqual(g.data.DirectConnect, 7, 'DirectConnect=7 (DIRECT_RTC)')
}

// 4в3) Invite/Accept/Reject адресованы серверу конференции: to пуст, extra = часть id после '@'
// (FUN_1002bec60/FUN_1002bb5d0/FUN_1002bce40 → FUN_100225030). С to = id конференции Accept не доходил.
{
  const conf = '000f45730f8fda2f@tc3.t2.ru#vcs'
  for (const g of [
    wire(vc.accept({ conference: conf, caller: 'peer@tc3.t2.ru/c6', me: 'me@tc.t2.ru/36' })),
    wire(vc.reject({ conference: conf, caller: 'peer@tc3.t2.ru/c6', me: 'me@tc.t2.ru/36' })),
    wire(vc.invite({ conference: conf, peer: 'peer@tc3.t2.ru' }))
  ]) {
    assert.strictEqual(g.to, '', g.data.Method + ': to пуст')
    assert.strictEqual(g.extra, 'tc3.t2.ru#vcs', g.data.Method + ': extra = сервер конференции')
  }
}

// 4г) Accept несёт ClientCaps: контейнер разворачивается в поля живого Invite 8.5.5.
{
  const g = wire(vc.accept({ conference: 'f@tc3.t2.ru#vcs', caller: 'peer@tc3.t2.ru/c6', me: 'me@tc.t2.ru/36' }))
  const capsField = g.fields.find(f => f.name === 'ClientCaps')
  assert.ok(capsField, 'ClientCaps есть в Accept')
  const caps = vv.deserialize(capsField.value)
  assert.deepStrictEqual(caps.map(f => f.name), vc.CLIENT_CAPS.map(r => r[0]), 'порядок полей ClientCaps = живой кадр')
  const get = n => caps.find(f => f.name === n)
  assert.strictEqual(get('ClientFlags').value.readUInt32LE(0), 7027)
  assert.strictEqual(get('AppName').value.toString(), 'TrueConf OS X')
  assert.strictEqual(get('VideoCdc').value.length, 32)
}

// 4д) Method продублирован сервером (массив) — offer всё равно распознаётся.
{
  const ev = vc.parseIncoming({ service: 'CLIENT', data: { Method: ['SendWebrtcMsg', 'SendWebrtcMsg'], Type: 0, SdpParam: 'v=0 offer', Conference: 'c1', id: 'peer/1' } })
  assert.ok(ev, 'массив Method распознан')
  assert.strictEqual(ev.kind, 'sdp'); assert.strictEqual(ev.sdpType, 'offer'); assert.strictEqual(ev.id, 'peer/1')
}

// 4е) Настройки TURN берутся из поля TurnConfiguration (SetTurnConfiguration, FUN_10031dfe0).
{
  const ice = vc.parseIceConfiguration({ Method: 'SetTurnConfiguration', TurnConfiguration: JSON.stringify([{ host: 'turn.example', port: 3478, protocol: 'turn', username: 'u', credential: 'c' }]) })
  assert.strictEqual(ice.length, 1, 'TurnConfiguration разобран')
  assert.strictEqual(ice[0].urls, 'turn:turn.example:3478')
  assert.strictEqual(ice[0].username, 'u')
}

// 4ж) Настоящий формат SetTurnConfiguration (журнал оф. клиента): IceConfiguration, логин TURN в поле login.
{
  const ice = vc.parseIceConfiguration({ Method: 'SetTurnConfiguration', TurnUsageMode: 1, IceConfiguration: JSON.stringify([
    { host: 'stun.trueconf.ru', port: 3478, protocol: 'stun', transports: ['udp'], roles: ['nativeclient'] },
    { host: 'turn.trueconf.ru', port: 3478, protocol: 'turn', transports: ['udp'], roles: ['nativeclient'], login: 'L', password: 'P' }]) })
  assert.strictEqual(ice.length, 2)
  assert.strictEqual(ice[1].urls, 'turn:turn.trueconf.ru:3478')
  assert.strictEqual(ice[1].username, 'L', 'логин TURN из поля login')
  assert.strictEqual(ice[1].credential, 'P')
}

// 5) Hangup: Conference, Name, HangupFlags
{
  const g = wire(vc.hangup({ conference: 'c', me: 'kirill@tc.t2.ru' }))
  assert.strictEqual(g.data.Method, 'Hangup')
  assert.strictEqual(g.to, 'c')
  assert.strictEqual(g.data.HangupFlags, 0)
}

// 6) Разбор входящих
// ConferenceDeleted: Name = id конференции, Cause — причина (живой журнал 26.10.2026).
{
  const ev = vc.parseIncoming({ service: 'CONFERENCE', data: { Method: 'ConferenceDeleted', Name: 'c9@tc3.t2.ru#vcs', Cause: 21, Result: 1 } })
  assert.deepStrictEqual(ev, { kind: 'deleted', conference: 'c9@tc3.t2.ru#vcs', cause: 21 }, 'ConferenceDeleted → deleted')
}

{
  const inv = vc.parseIncoming({ service: 'CONFERENCE', data: { Method: 'Invite', Conference: 'c1', Name: 'alice@tc.t2.ru' } })
  assert.deepStrictEqual({ kind: inv.kind, caller: inv.caller, conference: inv.conference }, { kind: 'invite', caller: 'alice@tc.t2.ru', conference: 'c1' })

  const sdp = vc.parseIncoming({ service: 'CLIENT', data: { Method: 'SendWebrtcMsg', Type: 1, SdpParam: 'v=0 answer', Conference: 'c1', id: 'q' } })
  assert.deepStrictEqual({ kind: sdp.kind, sdpType: sdp.sdpType, sdp: sdp.sdp }, { kind: 'sdp', sdpType: 'answer', sdp: 'v=0 answer' })

  const cand = vc.parseIncoming({ service: 'CLIENT', data: { Method: 'SendWebrtcMsg', Type: 2, SdpParam: 'candidate:1', SdpMidParam: '0', MLineIndexParam: 0 } })
  assert.strictEqual(cand.kind, 'candidate')

  assert.strictEqual(vc.parseIncoming({ service: 'CHAT', data: { Method: 'Message' } }), null, 'не-звонок → null')
}

// 7) IceConfiguration → iceServers
{
  const ice = vc.parseIceConfiguration({ IceConfiguration: '[{"host":"stun.trueconf.ru","port":3478,"protocol":"stun"},{"host":"turn.x","port":3478,"protocol":"turn","username":"u","credential":"p"}]' })
  assert.strictEqual(ice.length, 2)
  assert.strictEqual(ice[0].urls, 'stun:stun.trueconf.ru:3478')
  assert.strictEqual(ice[1].urls, 'turn:turn.x:3478')
  assert.strictEqual(ice[1].username, 'u')
  assert.strictEqual(ice[1].credential, 'p')
}

// 8) Тест обязан уметь падать: мутация порядка/типа ломает сверку
{
  const g = wire(vc.invite({ conference: 'c', peer: 'b', myName: 'k' }))
  let caught = false
  try { assert.deepStrictEqual(g.fields.map(f => f.name), ['Method', 'Name', 'Conference', 'CallId', 'DirectConnect']) } catch { caught = true }
  assert.ok(caught, 'перестановка полей обязана валить сверку')
}

// 9) Диспетчер build(kind,args) — тот же результат, что прямой строитель
{
  const direct = vc.invite({ conference: 'c', peer: 'b', myName: 'k' })
  const viaBuild = vc.build('invite', { conference: 'c', peer: 'b', myName: 'k' })
  assert.deepStrictEqual(viaBuild.opts, direct.opts)
  assert.strictEqual(viaBuild.fields.length, direct.fields.length)
  assert.throws(() => vc.build('ненет', {}), /неизвестное действие/, 'неизвестный kind → ошибка')
}

console.log('OK: сигналинг звонков — строители, диспетчер и разбор (CONFERENCE/CLIENT, SDP/ICE), формат на проводе сверен')
