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

// 3) SDP offer: сервис CLIENT, Type=0, ClientRtcVersion=2, to = instance пира
{
  const g = wire(vc.webrtcSdp({ sdp: 'v=0...', type: vc.WEBRTC_OFFER, conference: 'c', id: 'callid1', to: 'bob@tc.t2.ru/ab12' }))
  assert.strictEqual(g.service, 'CLIENT', 'SDP на сервис CLIENT')
  assert.strictEqual(g.to, 'bob@tc.t2.ru/ab12', 'to = пир')
  assert.strictEqual(g.data.Method, 'SendWebrtcMsg')
  assert.strictEqual(g.data.SdpParam, 'v=0...')
  assert.strictEqual(g.data.Type, 0, 'offer Type=0')
  assert.strictEqual(g.data.ClientRtcVersion, 2, 'ClientRtcVersion=2')
}

// 4) ICE-кандидат: Type=2 + SdpMid + MLineIndex
{
  const g = wire(vc.webrtcCandidate({ candidate: 'candidate:1 1 udp', sdpMid: '0', mLineIndex: 0, conference: 'c', id: 'x', to: 'bob' }))
  assert.strictEqual(g.data.Type, 2, 'кандидат Type=2')
  assert.strictEqual(g.data.SdpMidParam, '0')
  assert.strictEqual(g.data.MLineIndexParam, 0)
}

// 5) Hangup: Conference, Name, HangupFlags
{
  const g = wire(vc.hangup({ conference: 'c', me: 'kirill@tc.t2.ru' }))
  assert.strictEqual(g.data.Method, 'Hangup')
  assert.strictEqual(g.to, 'c')
  assert.strictEqual(g.data.HangupFlags, 0)
}

// 6) Разбор входящих
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

console.log('OK: сигналинг звонков — строители и разбор (CONFERENCE/CLIENT, SDP/ICE), формат на проводе сверен')
