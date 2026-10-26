'use strict'
// Сигналинг P2P-звонков и конференций TrueConf поверх нативной сессии :4307.
// Медиа (видео/звук) — обычный WebRTC (RTCPeerConnection в renderer). Здесь только
// СИГНАЛИНГ: приглашение/ответ/отбой на сервисе CONFERENCE и обмен SDP/ICE через
// метод SendWebrtcMsg на сервисе CLIENT.
//
// GROUNDED по декомпиляции TrueConfClient832.bin (см. TrueConf-RE/SPEC-native-calls.md):
//   InvitePeer2Call FUN_1002bd860, Ringing FUN_1002bb910, Accept FUN_1002bec60,
//   Reject FUN_1002bb5d0, Hangup FUN_1002baca0, CreateConference FUN_1002b9700,
//   SendWebrtcMsg SDP FUN_10029e2d0/10029e460, ICE FUN_10029e5f0, диспетчер приёма
//   FUN_10029df80 (байт вида: 0/1=SDP, 2=кандидат). Строки — из out/protocol_consts.json.
//
// LIVE-PENDING (помечено KNOWN?/нужен один тестовый звонок с хуком encrypt/decrypt):
//   - P2P_CONF_TYPE / SUBTYPE / SCOPE / MAXPARTS в CreateConference;
//   - содержимое ClientCaps (контейнер FUN_1002b9dc0);
//   - кто первым шлёт offer и точное соответствие Type 0=offer / 1=answer.
//
// ПОДТВЕРЖДЕНО живым захватом 26.10.2026 (входящий ICE-кандидат от пира, cap/call_p2p_cap.txt):
//   SendWebrtcMsg на CLIENT, поля по порядку: SdpParam, SdpMidParam, MLineIndexParam u32,
//   Type u32 (2 = кандидат), Conference ("<hex>@<сервер звонящего>#vcs"), id, ClientRtcVersion u32 = 3,
//   RtcVersion u32 = 4. id = полный экземпляр ОТПРАВИТЕЛЯ (user@srv/inst), to конверта = экземпляр
//   получателя. Поэтому шлём id = свой экземпляр, to = экземпляр пира (узнаём из его входящего id).
// Эти значения тут — именованные константы, их правим после живого захвата, код не трогаем.

const { appMessage, fieldsToObject } = require('./vssession.cjs')

const SRV_CONF = 'CONFERENCE'
const SRV_CLIENT = 'CLIENT'

// ClientCaps — возможности клиента (контейнер в Invite/Accept). Оф. клиент кладёт его в Accept
// всегда (FUN_1002bec60). Поля и значения — из живого Invite TrueConf OS X 8.5.5 (26.10.2026):
// без них звонящий удалял конференцию через 5 с после нашего Accept (Cause=21).
// Строка: [имя, тип VS_Variant (1=u32, 3=строка, 4=байты hex), значение].
const CLIENT_CAPS = [
  ['IntCaps', 1, 1],
  ['StrmDirC', 1, 62],
  ['VideoRcv', 1, 431],
  ['VideoSnd', 1, 7],
  ['AudioRcv', 1, 15],
  ['AudioSnd', 1, 15],
  ['Rating', 1, 870],
  ['Level', 1, 91],
  ['LevelGroup', 1, 98],
  ['ScreenWidth', 1, 1920],
  ['ScreenHeight', 1, 1080],
  ['ClientType', 1, 0],
  ['VadVersionMin', 1, 1],
  ['VadVersionMax', 1, 1],
  ['AppName', 3, 'TrueConf OS X'],
  ['AppVersion', 3, '8.5.5'],
  ['ClientFlags', 1, 7027],
  ['MediaFmt', 4, '30000000680100008002000070763830803e0000f07f0000000500001e00000000000000000000000000000001000000'],
  ['BandWRcv', 1, 4096],
  ['AudioCdc', 4, 'f07f0470037006a106000700017002700570067007706500420041008300087009705500'],
  ['VideoCdc', 4, '70763830683236316832363368323670766836347636346d7636346876683635'],
]
// Поля VS_Variant для vsvariant.serialize (кладётся в ClientCaps как контейнер).
function clientCapsFields () {
  return CLIENT_CAPS.map(([name, type, val]) => {
    if (type === 1) { const b = Buffer.alloc(4); b.writeUInt32LE(val >>> 0); return { name, type, value: b } }
    if (type === 3) return { name, type, value: Buffer.from(val, 'utf8') }
    return { name, type, value: Buffer.from(val, 'hex') }
  })
}

// Вид WebRTC-сообщения (байт 0 структуры, диспетчер FUN_10029df80).
const WEBRTC_OFFER = 0 // KNOWN? 0/1 — SDP; какой из них offer, уточнить живым звонком
const WEBRTC_ANSWER = 1
const WEBRTC_CANDIDATE = 2

// Версии WebRTC-сигналинга — значения из живого кадра пира (26.10.2026).
const CLIENT_RTC_VERSION = 3
const RTC_VERSION = 4

// KNOWN? значения для P2P-конференции (CreateConference). Пока нейтральные; правим по захвату.
const P2P = { type: 0, subType: 0, scope: 0, maxParts: 2, duration: 0 }

const u32 = v => ({ t: 1, v: v >>> 0 })
const flag = () => ({ t: 0, v: 0 }) // поле-флаг (тип 0, без значения)

// --- Строители исходящих (возвращают { fields, opts } для session.sendApp) ---

// Создать P2P-конференцию (звонок). chatId — опц. привязка к чату.
function createConference ({ name = '', password = '', chatId = '', clientCaps } = {}) {
  const e = [
    ['MaxParticipants', u32(P2P.maxParts)],
    ['Duration', u32(P2P.duration)],
    ['Type', u32(P2P.type)],
    ['SubType', u32(P2P.subType)],
    ['Scope', u32(P2P.scope)]
  ]
  if (name) e.push(['Name', name])
  if (password) e.push(['Password', password])
  if (chatId) e.push(['chatId', chatId])
  if (clientCaps) e.push(['ClientCaps', { t: 'container', v: clientCaps }])
  return { fields: appMessage('CreateConference', e), opts: { service: SRV_CONF } }
}

// Пригласить пира в звонок. conference — id конференции, peer — CallId вызываемого,
// myName — моё отображаемое имя/CallId.
function invite ({ conference, peer, myName, audioOnly = false, directConnect = 1, clientCaps } = {}) {
  const e = [
    ['Conference', conference],
    ['Name', myName],
    ['CallId', peer]
  ]
  if (audioOnly) e.push(['AudioOnly', flag()])
  e.push(['DirectConnect', u32(directConnect)])
  if (clientCaps) e.push(['ClientCaps', { t: 'container', v: clientCaps }])
  return { fields: appMessage('Invite', e), opts: { service: SRV_CONF, to: conference } }
}

// Звоним-отвечаем «идёт вызов» (приёмник → серверу конференции).
function ringing ({ conference, me, caller } = {}) {
  const e = []
  if (conference) e.push(['Conference', conference])
  e.push(['CallId', me])
  if (caller) e.push(['CallID2', caller])
  return { fields: appMessage('Ringing', e), opts: { service: SRV_CONF } }
}

// Принять звонок. Разбор FUN_1002bec60: Conference и Name берутся из сохранённого Invite,
// т.е. Name = экземпляр ЗВОНЯЩЕГО; UserName = наш логин; AppId — только если есть.
function accept ({ conference, caller, myName, me, appId, directConnect = 1, clientCaps = clientCapsFields(), symKey } = {}) {
  const e = [
    ['Conference', conference],
    ['Name', caller || myName],
    ['UserName', me]
  ]
  if (appId) e.push(['AppId', appId])
  e.push(['DirectConnect', u32(directConnect)])
  if (clientCaps) e.push(['ClientCaps', { t: 'container', v: clientCaps }])
  if (symKey) e.push(['SymKey', symKey])
  return { fields: appMessage('Accept', e), opts: { service: SRV_CONF, to: conference } }
}

// Отклонить звонок. cause — код причины (u32).
function reject ({ conference, caller, me, cause = 0 } = {}) {
  const e = [
    ['Conference', conference],
    ['Name', caller],
    ['Cause', u32(cause)],
    ['UserName', me]
  ]
  return { fields: appMessage('Reject', e), opts: { service: SRV_CONF, to: conference } }
}

// Положить трубку / завершить. result — опц. код, hangupFlags — u32.
function hangup ({ conference, me, result, hangupFlags = 0 } = {}) {
  const e = [['Conference', conference], ['Name', me]]
  if (result !== undefined) e.push(['Result', u32(result)])
  e.push(['HangupFlags', u32(hangupFlags)])
  return { fields: appMessage('Hangup', e), opts: { service: SRV_CONF, to: conference } }
}

// SDP offer/answer. type — WEBRTC_OFFER|WEBRTC_ANSWER. id — свой экземпляр, to — экземпляр пира.
function webrtcSdp ({ sdp, type, conference, id, to, clientRtcVersion = CLIENT_RTC_VERSION, rtcVersion = RTC_VERSION } = {}) {
  const e = [
    ['SdpParam', sdp],
    ['Type', u32(type)],
    ['Conference', conference],
    ['id', id],
    ['ClientRtcVersion', u32(clientRtcVersion)],
    ['RtcVersion', u32(rtcVersion)]
  ]
  return { fields: appMessage('SendWebrtcMsg', e), opts: { service: SRV_CLIENT, to } }
}

// ICE-кандидат.
function webrtcCandidate ({ candidate, sdpMid, mLineIndex, conference, id, to, clientRtcVersion = CLIENT_RTC_VERSION, rtcVersion = RTC_VERSION } = {}) {
  const e = [
    ['SdpParam', candidate],
    ['SdpMidParam', sdpMid],
    ['MLineIndexParam', u32(mLineIndex)],
    ['Type', u32(WEBRTC_CANDIDATE)],
    ['Conference', conference],
    ['id', id],
    ['ClientRtcVersion', u32(clientRtcVersion)],
    ['RtcVersion', u32(rtcVersion)]
  ]
  return { fields: appMessage('SendWebrtcMsg', e), opts: { service: SRV_CLIENT, to } }
}

// Диспетчер: по виду действия вернуть { fields, opts } для session.sendApp.
// Используется IPC-мостом main-процесса (renderer присылает { kind, args }).
const BUILDERS = {
  createConference, invite, ringing, accept, reject, hangup,
  sdp: webrtcSdp, candidate: webrtcCandidate
}
function build (kind, args = {}) {
  const fn = BUILDERS[kind]
  if (!fn) throw new Error('неизвестное действие звонка: ' + kind)
  return fn(args)
}

// --- Разбор входящих ---

// Классифицировать входящее сообщение звонка. m — { service, from, data } (data = fieldsToObject).
// Возвращает { kind, ...поля } или null, если не про звонок.
function parseIncoming (m) {
  const d = m.data || {}
  const method = d.Method
  if (m.service === SRV_CONF || method === 'Invite' || method === 'InviteToMulti') {
    switch (method) {
      case 'Invite':
      case 'InviteToMulti':
        return { kind: 'invite', conference: str(d.Conference), caller: str(d.Name || d.CallId), displayName: str(d.DisplayName), audioOnly: 'AudioOnly' in d }
      case 'Ringing':
        return { kind: 'ringing', conference: str(d.Conference), peer: str(d.CallId) }
      case 'Accept':
        return { kind: 'accept', conference: str(d.Conference), peer: str(d.UserName || d.Name) }
      case 'Reject':
        return { kind: 'reject', conference: str(d.Conference), peer: str(d.Name || d.UserName), cause: num(d.Cause) }
      case 'Hangup':
        return { kind: 'hangup', conference: str(d.Conference), peer: str(d.Name), result: num(d.Result) }
      case 'ConferenceCreated':
        return { kind: 'created', conference: str(d.Conference || d.id || d.Name) }
    }
  }
  // WebRTC SDP/ICE приходит на CLIENT методом SendWebrtcMsg
  if (method === 'SendWebrtcMsg') {
    const type = num(d.Type)
    if (type === WEBRTC_CANDIDATE) {
      return { kind: 'candidate', candidate: str(d.SdpParam), sdpMid: str(d.SdpMidParam), mLineIndex: num(d.MLineIndexParam), conference: str(d.Conference), id: str(d.id) }
    }
    return { kind: 'sdp', sdpType: type === WEBRTC_ANSWER ? 'answer' : 'offer', sdp: str(d.SdpParam), conference: str(d.Conference), id: str(d.id) }
  }
  return null
}

// IceConfiguration из SetTurnConfiguration → массив для RTCPeerConnection.iceServers.
function parseIceConfiguration (setPropsData) {
  const raw = str(setPropsData && (setPropsData.IceConfiguration || setPropsData.iceConfiguration))
  if (!raw) return []
  let list
  try { list = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(list)) return []
  return list.map(s => {
    const scheme = (s.protocol || 'stun').toLowerCase()
    const url = `${scheme}:${s.host}:${s.port}`
    const o = { urls: url }
    if (s.username) o.username = s.username
    if (s.credential || s.password) o.credential = s.credential || s.password
    return o
  })
}

function str (v) { return Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0+$/, '') : (v == null ? '' : String(v)) }
function num (v) {
  if (Buffer.isBuffer(v)) return v.length >= 4 ? v.readUInt32LE(0) : 0
  const n = Number(v); return Number.isFinite(n) ? n : 0
}

module.exports = {
  SRV_CONF, SRV_CLIENT, CLIENT_CAPS, clientCapsFields, WEBRTC_OFFER, WEBRTC_ANSWER, WEBRTC_CANDIDATE, CLIENT_RTC_VERSION, RTC_VERSION, P2P,
  createConference, invite, ringing, accept, reject, hangup,
  webrtcSdp, webrtcCandidate, build,
  parseIncoming, parseIceConfiguration,
  fieldsToObject
}
