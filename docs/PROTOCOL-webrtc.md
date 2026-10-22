# TrueConf Server 5.5 (tc.example.com) — протокол WebRTC-клиента `/webrtc`

Источник: статика `https://tc.example.com/webrtc/` (сборка 5.5.4.12, сервер 5.5.5.10009).
Разбор статический: в конференцию не входили, логин не делали.

Обозначения ссылок на код:

- `SDK:<строка>` — `/tmp/tcrecon/wr/sdk.pretty.js` (это `chunks/web-sdk.bundle-5.5.4.12.js` после prettier).
- `VEND:<строка>` — `/tmp/tcrecon/vend.pretty.js` (`chunks/vendors.bundle-5.5.4.12.js`).
- `APP:<строка>` — `/tmp/tcrecon/wr/app.pretty.js` (`bundle-5.5.4.12.js`, Vue-приложение и webpack runtime).
- `C52:` / `CSUP:` — `/tmp/tcrecon/wr/c_52.pretty.js`, `/tmp/tcrecon/wr/c_supported.pretty.js` (ленивые чанки `52`, `supported`, скачаны в `webrtc/chunks/`).
- `UA:` — бандлы личного кабинета `/tmp/tcrecon/user-area/chunks/index.bundle-5.5.4.1019.js` и соседние.
- `#NNNNN` — номер webpack-модуля.

Короткий ответ:

1. Сигналинг — один WebSocket `wss://tc.example.com:443/websocket/`. Кадры — JSON-объекты с полем `method`.
2. Вход — сообщение `loginUser`. В нём пароль открытым текстом (`credentialsType: 2`), MD5 пароля (`4`), JWT (`0`) или токен (`3`).
3. Вход в конференцию: `join` → `conferenceStateChange/joinResponse` → `getIceConfig` → `webrtc{restrictBitrate}` → SDP и ICE в `method:"webrtc"` → `connectMedia`.
4. Сервер работает как MCU. Он присылает одну смешанную видеодорожку и одну смешанную аудиодорожку. Раскладку участников он присылает отдельно сообщением `webrtc{type:"layout"}`.
5. SDK можно переиспользовать без Vue-приложения. Для этого нужен свой маленький webpack-runtime. Готовый лежит в `/tmp/tcrecon/wr/sdk-loader/tc-sdk-runtime.js`, фасад проверен в Node (раздел 5).
6. Исходящих и входящих P2P-звонков пользователю в веб-SDK 5.5 нет. Работают только конференции `\c\<id>`. Чат, контакты и присутствие идут по тому же WebSocket (раздел 6).

```
 Браузер / наш клиент                         tc.example.com
 ─────────────────────                        ────────
 HTTPS  /api/v4/oauth2/token ───────────────► OAuth2 (личный кабинет, гость)
 HTTPS  /bridge/api/client/v1/auth/* ───────► обмен на JWT для веб-клиента
 WSS    /websocket/ ────────────────────────► сигналинг (JSON, method=...)
          ping/pong → loginUser → join → getIceConfig → webrtc(offer/answer/candidate)
 ICE/DTLS-SRTP (UDP 53000-55000 или TURN) ──► медиасервер (MCU)
```

---

## 1. Аутентификация

### 1.1. Публичные эндпоинты без авторизации (проверены GET-запросом)

| Эндпоинт | Ответ на tc.example.com |
|---|---|
| `GET /api/v4/server` | `config.storage_type: "LDAP"`, `web_config.url: "https://tc.example.com"`, `product.id: "<SERVER_ID>"` |
| `GET /api/v4/auth/manifest` | `{"password": true, "microsoft_outlook": false}`. Внешних OAuth-провайдеров нет, вход только по паролю (LDAP). |
| `GET /api/v4/webrtc/public` | `{"min_port": 53000, "max_port": 55000}` — UDP-порты медиа |
| `GET /api/v4/software/clients?case=download&lang=ru` | список клиентов. Без токена и `call_id` поле `web_url` у «TrueConf Web Client» пустое. Ещё есть `deeplinks.default = "trueconf:\c\&h=tc.example.com:4307&topic="`: нативный протокол на порту 4307, к WebRTC он не относится. |

### 1.2. Вход внутри WebSocket (главное для своего клиента)

Сам веб-клиент знает только вход через WS. HTTP он нужен лишь для того, чтобы получить токен до открытия WS.

`SDK:9015-9036` (#51122, `sendLoginRequest`):

```js
let s = { AppID: e, method: "loginUser", login: t, credentialsType: i,
          chatV2Enabled: !0, browser: navigator.userAgent, version: r,
          appLang: c.k.getCurrentLang(), appVersion: c.k.getVersion(), appName: c.k.getName() };
(i === W.AUTH_TYPE.MD5 ? (s.credentials = o(n)) : (s.credentials = n), d(s));
```

Точная форма запроса:

```json
{ "method": "loginUser",
  "AppID": "<32 hex UPPERCASE>",          // md5(UA+Date.now()+Math.random()).toUpperCase(), хранится в IndexedDB appIds
  "login": "<trueconf id / login>",
  "credentials": "<пароль | md5(пароль) | JWT | token>",
  "credentialsType": 2,
  "chatV2Enabled": true,
  "browser": "<UA>", "appLang": "ru", "appVersion": "5.1.0", "appName": "TrueConf WebClient" }
```

`W.AUTH_TYPE` (`SDK:9960`): `JWT:0, JWE:1, RAW:2, TOKEN:3, MD5:4, AUTOLOGIN:5`.

- `RAW` (2) — пароль открытым текстом внутри WSS. Так работает форма входа веб-клиента: `ee.login(e, t, o)` без типа, по умолчанию `RAW` (`C52:3147`, `SDK:9893`).
- `MD5` (4) — `credentials = md5(password)`, hex в нижнем регистре (своя реализация MD5, `SDK:8858-9000`).
- `TOKEN` (3) — для автологина и для токена из URL. Если ключ похож на `/^\$2.+\*\d+\*.+$/`, тип переключается на `TOKEN`, иначе на `AUTOLOGIN` (`SDK:9876`).
- `JWT` (0) — когда в hash URL есть `tokenType=JWT` (`C52:3135-3147`).

Перед `loginUser` клиент шлёт `{"method":"ping"}` и ждёт `{"method":"pong","version":<protocolVersion>}` (`SDK:9046-9053`). Версия влияет на ветки кода: `protocolVersion < 23`, `>= 25` и т.д. Внутри SDK константа `ye = 41` (`SDK:12274`).

Ответ сервера `loginResponse` (`SDK:8999-9013`). Поля: `result, CID, Key, trueconfId, displayName, Rights, Session, applicationSettings{BandwidthIn,BandwidthOut}, webTools[], messageEditDuration`.

- `result == 0` (`USER_LOGGEDIN_OK`) — вход успешен.
- `CID` — идентификатор сессии. Его надо класть во многие последующие запросы, а клиент хранит его в `sessionStorage["CID"]`.
- `Key` — ключ автологина.
- `Rights` — битовая маска прав (`SDK:9614-9645`: `CHAT=16777216`, `DESKTOP_SHARING=131072`, `CALL=32768` …).
- `Session` — ключ сессии (параметр `k` для web-tools и т.п.).

Коды `LOGIN_STATE` (`SDK:9930-9955`): `-1 UNKNOWN_ERROR, 0 OK, 1 USER_ALREADY_LOGGEDIN, 2 NO_USER_LOGGEDIN, 3 ACCESS_DENIED, 4 SILENT_REJECT_LOGIN, 5 LICENSE_USER_LIMIT, 6 USER_DISABLED, 7 RETRY_LOGIN, 9 SESSION_WAIT, 10 ACCOUNT_IS_LOCKED, 12 AMBIGUOUS, 65213 USER_PASSWORD_EXPIRED …`.

После входа SDK сам отправляет (`SDK:5640-5667`):

- `{"method":"clientInfo", appVersion, device, hardware, platform, runtime}`;
- `{"method":"networkInfo", adapterList:[{id, ipAddressList:[{address,family}]}]}`.

Выход: `{"CID":"…","method":"logoutUser"}` → `logoutResponse{cause}` (`SDK:9043`). `LOGOUT_CAUSE`: `0 BY_REQUEST, 1 USER_LOGGEDIN` (вход с другого места).

**Вывод для корпоративной учётки:** самый простой путь — `loginUser` с `credentialsType: 2` (LDAP-пароль) или `4` (md5). OAuth не нужен.

### 1.3. Параметры веб-клиента в hash URL

`APP:80-95`, `APP:140-150`. Hash вида `/webrtc/<confId>#login=…&token=…` разбирается в `hashParams`. Поддерживаемые ключи: `login, password, token, host, port, path, secure, noAutologin, lang, disabled, forbid, storageDisabled, version, redirectUrl, tokenType, bearer`.

Логика `CSUP:283-300`:

- если есть `login`, вызывается `te({login, password, token, conferenceId: "\\c\\"+id})`;
- иначе, если нет `noAutologin`, выполняется автологин по ключу из IndexedDB `trueconf_client.users.autoLoginKey`.
- В `te` (`C52:3130-3148`): если есть `token`, вызывается `login(login, token, conn, tokenType==="JWT" ? JWT : TOKEN)`; иначе `login(login, password, conn)` с типом RAW.
- `bearer` — OAuth access_token личного кабинета. Чанк `in-app-chat` использует его для REST-запросов адресной книги (`c_in-app-chat.pretty.js:87,160`).

### 1.4. Как личный кабинет получает токен для веб-клиента (HTTP)

Все запросы ниже — POST JSON к `https://tc.example.com`, клиент axios (`UA: index.bundle-5.5.4.1019.js`).

1. **Пользователь (пароль):** `POST /api/v4/oauth2/token`

   ```json
   {"grant_type":"password","client_id":"trueconf_server_users","username":"…","password":"…"}
   ```

   Ответ: `{access_token, refresh_token?, expires_in|expires_at, …}`. Если включена 2FA, приходит ошибка с `reason:"2FactorAuthEnabled", email`. Цитата: `authorization(r,e="inner"){const t={grant_type:"password",client_id:"trueconf_server_users"};return this.authorizationStore.authorization({...t,...r})`.
   Другие `grant_type`:
   - `refresh_token`;
   - `trusted_password` — внешний провайдер;
   - `client_secretkey` — параметры `call_id`, `k` из ссылки клиента;
   - `webtool` — `client_id, call_id, msg_id, display_name, s`;
   - `guest` — `{"grant_type":"guest","client_id":"trueconf_server_guests","display_name":"…"}`.

   Сохраняется в `localStorage["trueconfServerUserAuthorization"]`. Дальше идёт заголовок `Authorization: Bearer <access_token>`.
2. **JWT для веб-клиента/чата** (маршрут `user.chats`):
   - `POST /bridge/api/client/v1/auth/web_rest_api_token` с телом `{"client_id":"trueconf_server_users","token":"<oauth access_token>"}` → `{authorization_code}`;
   - `POST /bridge/api/client/v1/auth/token` с телом `{"client_id":"trueconf_server_users","grant_type":"authorization_code","code":"<authorization_code>"}` → `jwtTokenInfo{access_token,…}`.

   Затем переход на `"/webrtc/chat#login="+me.login_name+"&token="+jwt.access_token+"&tokenType=JWT&bearer="+oauth_access_token` (`UA: index.bundle-5.5.4.101919.js`, `webRTCConnectionUrl`).
3. **Конференция из ЛК/гостем:** URL веб-клиента генерирует сервер. Это поле `web_url` у клиента `{type:"web", platform:"webrtc", name:"TrueConf Web Client"}` из `GET /api/v4/software/clients?call_id=<confId>&case=…&lang=…&user=…` с Bearer (`UA: conferenceMixin.bundle…`, `webRTCConnectionUrl`). *Не проверено:* точный формат hash в этом `web_url` генерирует сервер. Ожидается `…/webrtc/<confId>#login=…&token=…[&tokenType=JWT]`.
4. `/guest/auth/login` — это **страница**, а не API. Клиент делает `window.location.replace("/guest/auth/login")`, когда сервер не настроен.

---

## 2. Транспорт сигналинга

- URL: `ws[s]://<host>:<port>/<path>` с `path = "websocket/"` по умолчанию, плюс `?prevCID=<CID>` при переподключении (`SDK:7236-7245`, `SDK:7358-7362`). Для tc.example.com: **`wss://tc.example.com:443/websocket/`**. Хост, порт, secure и path берутся из `document.location` или из hash-параметров (`C52:3012-3031`). Таймаут открытия — 15 с.
  - Особенность: приложение передаёт `websocket/?call_id=…` четвёртым аргументом в `TCServerConnectionParams(host, port, secure, prevCID, path)`. Это позиция `prevCID`, а `login()` потом всё перезаписывает (`SDK:9845-9856`). В итоге `call_id` на сервер не уходит.
- Кадр — **один JSON-объект в текстовом сообщении**: `t.send(JSON.stringify(e))` (`SDK:7199-7206`). Конвертов, id запросов и seq нет. Исключение — ChatV2 со своим `sn` (раздел 6).
- Входящие: тип сообщения берётся из `method` или `Method`, первая буква приводится к нижнему регистру (`SDK:7253-7262`). Дальше идёт диспетчеризация по имени: `addMessagesCallback(fn, "<method>")`. Ответы на запросы приходят с тем же `method` (например, `getIceConfig` → `getIceConfig`).
- Почти все запросы в конференции несут `"CID": "<CID из loginResponse>"`.
- Peer-to-peer команды через сервер (`SDK:7209-7215`): `{"to":"<trueconfId>","method":"command","CID":"…","command":"<cmd>[:<args>]"}`. Входящие: `{"method":"command","from":"…","command":"remote:mic_off"}`. Префикс до `:` выбирает обработчик.
- Keepalive: на прикладном уровне периодического ping нет. `ping/pong` используется для запроса версии протокола, а «наблюдатель задержки» есть, но приложение его не включает (`SDK:7221`, `SDK:7335-7339`). Держится на WS-уровне. При закрытии сокета клиент считает себя отключённым, а приложение перезагружает страницу с `?error_code=`.
- Сервер может прислать `{"method":"connectionFail"}`. Это ошибка входа, `onConnectionFail`.

Последовательность handshake:

```
C→S  {"method":"ping"}
S→C  {"method":"pong","version":N}
C→S  {"method":"loginUser",...}
S→C  {"method":"loginResponse","result":0,"CID":"…","trueconfId":"user@tc.example.com",...}
C→S  {"method":"clientInfo",...} {"method":"networkInfo",...}
S→C  {"method":"webToolsChanged","webTools":[...]}   (и др. уведомления)
```

---

## 3. Сообщения

### 3.1. Вход в конференцию по ID

API: `client.conferenceManager.call("\\c\\<confId>", password)` (`SDK:12321-12346`). Префикс `\c\` обязателен. Он отрезается, и в `join` уходит голый id.

`SDK:14066-14081` (#92386, `p`):

```json
C→S {"method":"join","conferenceId":"<confId>","Password":"","simulcastSupported":true,"CID":"…"}
```

Ответ — `conferenceStateChange` (`SDK:14175-14196`):

```json
S→C {"method":"conferenceStateChange",
     "conference":{"message":"joinResponse","lastRejectReason":6,"streamConferenceId":"…","conferenceId":"…",
                   "subtype":3,"chatId":"…","owner":"…","topic":"…","type":5,"cmr_flags":<bitmask>},
     "commands":["remote:mic_off","remote:cam_off"],
     "WRState":false,"VadVersion":1,"VadSelectorEnabled":false,"VadParametricEnabled":false,
     "RecordingState":0,"UseTranslation":false,"IsTranslator":false,"Scalability":{"Enabled":true}}
```

- `lastRejectReason == 6` (`JOIN_OK`) — успех. Другие коды: `REJECT_CAUSE`, `SDK:12460-12497`. Например, `12 CONFERENCE_PASSWORD_REQUIRED`, `13 REJECTED_BY_WRONG_PASSWORD`, `401 CONF_NOT_FOUND`.
- `cmr_flags` — права в конференции (`SDK:13677-13694`): `CHAT_SEND 1, SS_SEND 4, FT_SEND 64, DS_ALLOWED 256, AUDIO_SEND 1024, VIDEO_SEND 4096…`.
- `commands` — начальное состояние: модератор выключил микрофон или камеру.

Обработка `Ne` (`SDK:15388-15440`):

1. Сохранить `streamConferenceId`, `chatId` и т.д.
2. `getIceConfig` (раздел 4).
3. Дождаться `webrtc{type:"restrictBitrate"}`.
4. Создать `RTCPeerConnection` и добавить дорожки.
5. `C→S {"method":"connectMedia","streamConferenceId":"…","type":1,"CID":"…"}`.

Сервер отвечает `{"method":"connectMedia","result":true,"type":1,"connectionId":…}`. При `result` false или `type != 1` — ошибка (`SDK:15441-15449`). Таймаут соединения — 15 с, после `connected` — `onCallSuccess`.

Создать новую конференцию: `{"method":"createConference","topic","preset","audioMute","videoMute","useWaitingRoom","allowGuests","maxParticipants","maxCasters","CID"}` (`SDK:14127-14139`).

### 3.2. P2P-звонок пользователю и входящий звонок

**В веб-SDK 5.5 этого нет.**

- `call()` для ID без `\c\` просто ничего не делает (`SDK:12331-12346`, `isMultiConferenceCallId`).
- `TCConferenceListener.onIncomingCall` — пустая заглушка (`SDK:7572`). Сообщений входящего звонка не обрабатывается.
- Есть ветка `isP2P`/`canOffering` (`SDK:15680`), но её никто не включает.
- ЛК для звонка контакту отдаёт deeplink нативного клиента (`case:"call_login"`, `UA: index.bundle-5.5.4.101911.js`).

Обходной путь в рамках веб-протокола (*не проверено*): `createConference` и затем `{"method":"inviteUser","UserName":"<trueconfId>","conferenceStreamId":"…","CID":"…"}` (`SDK:10976-10983`). Принять приглашение в чужую конференцию веб-клиент тоже не умеет. Для полноценных P2P-звонков нужен нативный протокол (порт 4307), это вне веб-SDK.

### 3.3. SDP и ICE

Все сообщения идут с `"method":"webrtc"` (`SDK:14378-14440`):

```json
C→S {"method":"webrtc","type":"offer","sdp":"…","conf_id":"<streamConferenceId>","browser":"<UA>","my_peer_id":"<my trueconfId>","trueconf_id":<undefined>,"CID":"…"}
C→S {"method":"webrtc","type":"candidate","candidate":"candidate:…","sdpMLineIndex":0,"sdpMid":"0","my_peer_id":"…","conf_id":"…","CID":"…"}
S→C {"method":"webrtc","type":"answer"|"offer","sdp":"…"}
S→C {"method":"webrtc","type":"candidate","candidate":"…","sdpMid":"…","sdpMLineIndex":0}
S→C {"method":"webrtc","type":"candidate_complete"}
S→C {"method":"webrtc","type":"negotiation"}
S→C {"method":"webrtc","type":"restrictBitrate","bitrateConfigs":[{"sourceType":…,"totalBitrate":…,"minBitrate":…,"maxFrameSize":…,
                                                              "layerList":[{"frameSize":…,"maxBitrate":…,"minBitrate":…,"framerate":…}]}]}
S→C {"method":"webrtc","type":"layout","fixed":bool,"width":W,"height":H,"list":[{"id":"<trueconfId>","rect":[x1,y1,x2,y2],"priority":bool}]}
```

- Согласование SDP — «perfect negotiation», клиент вежливый (`getPoliteness() → true`, `SDK:8785`). Код задач: `VEND:181328-181508`. **Offer создаёт клиент** по `negotiationneeded` (`VEND:183484-183492`). Если сервер присылает свой offer, клиент отвечает answer.
- Свои дорожки добавляются как `addTransceiver(track,{direction:"sendonly"})`, видео — с simulcast `sendEncodings` (`VEND:179880-179910`). Приём идёт через «дефолтные» трансиверы audio и video (`VEND:179996`). Unified Plan.
- Принятые кандидаты фильтруются по `gatherer.server.transport` (`SDK:14775-14784`).
- Все локальные аудиодорожки сводятся в одну через AudioWorklet `/webrtc/audioworklet.bundle-5.5.4.12.js`, с VAD. Клиент периодически шлёт `{"method":"AudioLevel","Conference":"<streamId>","VadVersion":1,"AudioStatTm":…,"AudioStatInterval":…,"AudioLevelValue":[…],"AudioVadValue":[…]}` (`SDK:14090-14103`).
- **Приём:** сервер — MCU. Приходит одна видеодорожка с готовой раскладкой. Клиент режет её по `layout.list[].rect` на canvas (`TCMultiplexedVideoTrackLayoutListener`, `SDK:13700-14040`). Аудио приходит одной смешанной дорожкой.

Раскладка: `{"method":"ManageLayout","func":"Get"|"SetP0"|"SetP1"|"SetP2"|"Swap"|"PriorityType","UserName":[…],"type":n,"CID":"…"}` (`SDK:14276-14318`).

### 3.4. Микрофон, камера, демонстрация экрана

Протокольные сообщения (`SDK:14083-14154`, `SDK:11778-11796`):

```json
{"method":"DevicesList","Type":"camera"|"microphone"|"speaker"|"desktop","list":[{"id":"…","Name":"…"}],"CID":"…"}
{"method":"DeviceChanged","Type":"camera","id":"<deviceId>","Name":"<label>","CID":"…"}      // id:"" → устройство выключено
{"method":"DeviceState","Type":"microphone","id":"…","Name":"…","Mute":true,"CID":"…"}      // mute/unmute = track.enabled
{"method":"DeviceState","Type":"microphone","id":"…","Volume":50,"CID":"…"}
{"method":"DeviceStatus","value":<(videoStatus<<16)|audioStatus>,"CID":"…"}                 // 0=OK,16=SND_PAUSED,4=SND_NOT_CHOSEN
{"method":"VideoSourceType","Type":1|2,"Conference":"<streamId>","CID":"…"}                  // 1 CAMERA, 2 DESKTOP
```

- **Mute и unmute** на стороне клиента: `track.enabled = false/true`, затем `DeviceState{Mute}` и пересчёт `DeviceStatus` (`SDK:15318-15323`, `SDK:12087-12111`).
- **Камера выкл.:** дорожка удаляется из трансивера, отправляется `DeviceChanged` с пустыми `id`/`Name`.
- **Экран:** захват `getDisplayMedia` (`TCMediaCapture.screenCapture`). Дорожка добавляется с `SOURCE_TYPE.SYSTEM`, отправляются `DeviceChanged{Type:"desktop",id:"screen",Name:"screen"}` и `VideoSourceType{Type:2}`. При остановке отправляется `VideoSourceType{Type:1}` (`SDK:15296-15329`). Экран заменяет видео камеры в том же исходящем видео.

Сервер шлёт:

- `deviceStatus{UserName,DeviceStatus,conferenceStreamId}` — статус участника;
- `setDeviceState{Type,Mute,id,Volume}` — сервер или модератор меняет моё устройство;
- `changeDevice`;
- `stopContentSharing{Conference,From}`.

Модератор:

- удалённо управляет устройствами командой `command`: `"remote:mic_off"|"remote:mic_on"|"remote:cam_off"|"remote:cam_on"` (`SDK:11780-11789`);
- останавливает чужой показ: `{"method":"StopContentSharing","Conference":"…","UserName":"…"}`.

### 3.5. Участники (roster)

`S→C {"method":"sendPartsList","conferenceStreamId":"…","type":0|1|2|3|4,"list":[{"trueconfId":"…","displayname":"…","IsOperator":bool,"role":n,"Pinned":bool,"WRState":bool,"participantFlags":n,"podium":bool,"DeviceStatus":n}]}`

- `type`: `0 DEFAULT, 1 ALL` — полный список, `2 ADD`, `3 DELETE`, `4 UPDATE` (`SDK:10882-10889`, `SDK:11061-11089`, разбор полей — `SDK:16818-16830`).
- `role`: `0 EQUAL, 1 COMMON, 2 LEADER, 3 PODIUM, 4 REPORTER, 5 REMARK` (`SDK:12792-12800`).

Сопутствующие сообщения (`SDK:10912-11017`):

- `roleEvent{type:0 INQUIRY|1|2 ANSWER|3 NOTIFY, UserName, role, result, podium, conferenceStreamId}`;
- `queryRole{UserName,role}`, `answerRole{UserName,role,result}`;
- `takePodium{podium:bool}`, `kick{UserName}`, `inviteUser{UserName,conferenceStreamId}`;
- `PinUser{Conference,UserName,Type,Pinned}` → `pinUser{…Result}`;
- `ChangeWRState{Conference,parts,WRState}`, `wrStateChanged{WRState,callId,…}` — комната ожидания;
- `reqInvite{UserName,displayname,conferenceStreamId}` — запрос на вход; ответ `AnswerReqInvite{UserName,accept}`;
- `listenToChannel` и `translateToChannel{Username,Channel,Conference}`, `interpretingChannels`, `updateFlatVolume` — синхронный перевод;
- `updateConfRecordingState{Conference,RecordingState}`, `updateConfAlias{Conference,Alias,CallId}`, `vadStateChange`, `listenersFltr{MediaFiltr}`.

### 3.6. Поднять руку (реакции)

`SDK:15000-15058`:

```json
C→S {"method":"setConferenceReaction","streamConferenceId":"…","reaction":1}     // ответ {"method":"setConferenceReaction","status":true}
C→S {"method":"getConferenceReactions","streamConferenceId":"…"}                // ответ {"reactions":[["<trueconfId>",1],…]}
C→S {"method":"resetConferenceReactions","streamConferenceId":"…"}              // только LEADER
S→C {"method":"changeConferenceReaction","reactions":[{"userId":"…","reaction":1}]}
```

Коды `reaction`: `0 NONE, 1 HAND, 2 YES, 3 NO, 4 LAUGH, 5 APPLAUD, 6 AWAY` (`SDK:13157-13173`). «Опустить руку» — `reaction: 0`.

### 3.7. Чат в конференции

У конференции есть `chatId` из `joinResponse`. Сообщение отправляется через ChatV2 `SEND_GROUP_MESSAGE` с этим `chatId` (раздел 6). Старый `{"method":"chat",…}` уходит только во **внутреннюю** шину SDK, не на сервер (`SDK:12404-12412`).

### 3.8. Выход и завершение

- `C→S {"method":"hangup","result":false,"conferenceId":"<confId>","CID":"…"}` (`SDK:14078`). `result=true` — завершить для всех (параметр `hangUp(e)`).
- Сервер присылает `conferenceStateChange{conference:{message:"deleteConference",conferenceId,streamConferenceId,lastRejectReason,terminationCause}}` (`SDK:14178-14185`). `terminationCause`: `BY_PART_LEAVE 2, BY_DELETE 3, BY_ADMIN 15 …` (`SDK:7586-7606`).

### 3.9. Прочее в конференции

- Слайд-шоу: `showSlide{type,size,name,slideNumber,slidesCount,fileName}`, `finishSlideshow`.
- Согласие на запись — команды `plugin:Record:Accept|Reject`, `VRecord:Busy` (`SDK:2800-2830`).
- Файлы:
  - `FileUploadLimits`, `createUploadTask{fileName,…}`, `fileInfo{fileId}`;
  - загрузка HTTP POST `upload_file` multipart на URL из ответа (`SDK:3270-3330`);
  - временные файлы записи — `/bridge/api/client/v1/tmpfiles` (`SDK:15161`).

---

## 4. ICE и TURN

- Запрос: `C→S {"method":"getIceConfig","streamConferenceId":"<streamId>"}`. Ответ приходит с тем же `method` (`SDK:7459-7496`, #21799):

  ```json
  {"method":"getIceConfig",
   "iceServers":[{"serviceType":0|1,"address":"…","port":3478,"transport":0|1|2,"userName":"…","credential":"<hex>","credentialType":…}],
   "gatherer":{"client":{"policy":0|1,"transport":0|1|2},"server":{"policy":…,"transport":…}}}
  ```

  - `serviceType`: `0 STUN, 1 TURN` (`VEND:178185`).
  - `transport`: `0 UDP, 1 TCP, 2 TLS` (`VEND:9860`).
  - `policy`: `1 RELAY` → `iceTransportPolicy:"relay"`, иначе `"all"` (`VEND:183714-183722`).
- **TURN `credential` зашифрован** (`SDK:7413-7457`). Схема расшифровки:

  ```
  baseKey = HKDF-import(UTF8(CID))
  key     = HKDF-SHA256(baseKey, salt=UTF8(streamConferenceId),
                        info="app=bridge;module=conference;dir=s2c;") → AES-GCM-256
  iv      = UTF8(CID)[0..12], tag 128 бит
  plaintext = AES-GCM-decrypt(hex2bin(credential))
  ```

  Расшифровывается только TURN, STUN передаётся как есть.
- В `RTCPeerConnection` уходит `{urls:"turn:addr:port?transport=…", username, credential}` (`VEND:178313-178325`).
- Медиа-порты сервера — UDP `53000-55000` (`/api/v4/webrtc/public`).
- `defaultICEServersLocation` / `useDefaultStunServers` в `TCConferenceManager.defaultConfiguration.connectionConfig` (`SDK:10799-10830`) фактически не влияют: `getIceServers()` возвращает пусто, все серверы приходят от `getIceConfig`.

---

## 5. Публичный JS API SDK и как его запустить без Vue-приложения

Глобального объекта SDK **нет**. Модули лежат в массиве `self.webpackChunk_tc_server_webrtc_client`: чанк `896` — web-sdk, чанк `96` — vendors. Фасад, который собирает приложение (`APP:2134-2174`, модуль #55486):

```
TCMediaCapture #52302, TCCapturedDeviceListener #52524, TCMediaDevices #71578, TCMediaDevicesListener #45403,
TCConferenceListener #28630, TCMediaListener #18142, TCConferenceManager #57952, TCConferenceParticipant #68113,
TCWebClientListener #69815, TCWebClientBuilder #51122, TCServerConnectionParams #37873, TCConference #92386,
TCUser #81815, TCDevice #76906, TCMultiplexedVideoTrackLayoutListener #51243, PIN_MESSAGE_ANSWER_RESULT #70056
(+ разрешения #62346/#45678/#96082/#25740 — эти в bundle приложения), ChatCore = #5151.i
```

Замыкание зависимостей фасада — 93 модуля, все есть в `web-sdk` и `vendors`. Модули приложения не нужны (проверено скриптом `/tmp/tcrecon/wr/deps.js`).

**Готовый мини-runtime:** `/tmp/tcrecon/wr/sdk-loader/tc-sdk-runtime.js`. Он реализует `__webpack_require__` (`d/r/n/o/g/p/b`) поверх массива чанков и экспортирует `TCSDK()`. Проверено в Node (`node-smoke.js`): все классы резолвятся, `AUTH_TYPE` читается.

Порядок подключения в WebView или Electron:

1. Подключить `tc-sdk-runtime.js`.
2. Подключить `web-sdk.bundle-5.5.4.12.js`.
3. Подключить `vendors.bundle-5.5.4.12.js`.
4. Вызвать `TCSDK()`.

Для своего origin задать `req.p` и `req.b`. Так SDK найдёт `/webrtc/110ffca9a0e15a0dbb5b.wasm` и `/webrtc/audioworklet.bundle-5.5.4.12.js`.

Основные методы (по коду):

- `TCWebClientBuilder.getInstance({storageEnabled})` — синглтон (`SDK:9653`, `SDK:9926`). Методы: `login(login, credentials, connParams|null, authType=RAW, appId?, {usePrevCid, useUniqueConnectionId})`, `autoLogin(conn, trueconfId?)`, `canAutoLogin(conn)`, `checkConnection(conn)`, `logout(client)`, `disconnect(client)`, `addClientListener(l)`, `removeClientListener(l)`.
- Также у него статические `LOGIN_STATE`, `AUTH_TYPE`, `LOGOUT_CAUSE`.
- `TCWebClientListener`: `onConnectionEstablished, onConnectionFailed(id,err), onConnectionClosed(id,byUser), onLoginSuccess(client), onLoginFail(login,code), onLogout(id,cause)`.
- `TCServerConnectionParams(host, port, secure, prevCID, path)`.
- Объект `client` (#5151 `on`, `SDK:5520-5680`): `conferenceManager, accountInfoManager, slideshowManager, conferenceRecording, userManager, fileManager, getUser(), getUserId(), getAddressBook(), getChatManager(), getDataTransferManager(), getWebToolsManager(), getNetworkInformation(), logout(), disconnect(), clientState`.
- `conferenceManager` (#57952): `call("\\c\\<id>", password, connectMedia=true)`, `createNewConference(...)`, `hangUpAll()`, `addConferenceListener(l)`, `currentConferences`, `mediaManager`, `deviceManager`, `participantRoleManager`, `defaultConfiguration`.
  - Слушатель `TCConferenceListener`: `onCallSuccess(conf), onCallFail(callId, cause), onHangUp, onRemoteHangUp, onDisconnected, onVadStateChange, onServerRecordingStateChange, onStopContentSharing, onInterpretingLanguages, onUpdateFlatVolume, onAliasChanged`.
- `mediaManager`: `addLocalTrack/addLocalStream/removeLocalTrack, addDevice/removeDevice, setLocalAudioMuted, setLocalVideoMuted, getLocalTracks, addListener(TCMediaListener)`.
  - События `TCMediaListener`: `onRemoteTrackAdded(track, …)`, `onLocalTrackAdded`, …
- `TCConference` (#92386 `Z`): `hangUp(forAll)`, `getParticipants()` → `getList/get/kick/invite/setPinned/setWaitingRoomState/stopContentSharing`, `getParams()`, `getChatId()`, `getStreamConferenceId()`, `getPermissions()`, `getReactionManager()` → `setReaction/resetReactions/getStatistics`, `setVadSelectorEnabled`, `getRecordingState`, `getConnectionInfo`.
- `TCMediaCapture.getInstance()`: `captureDevices(...)`, `captureDevice(dev)`, `screenCapture.capture()`; `TCMediaDevices.getInstance()`: `getCameras/getMicrophones/getSpeakers`.

Ограничения:

1. SDK браузерный. Ему нужны `RTCPeerConnection`, `AudioWorklet`, `IndexedDB` (`storageEnabled:false` отключает БД клиента), `crypto.subtle`, `window`.
2. Для кроссплатформенного клиента реалистичные варианты:
   - **(a)** Electron/WebView с этим SDK — минимум кода, работает «как браузер»;
   - **(b)** своя реализация по разделам 2–4 на libwebrtc/pion/aiortc. Протокол небольшой.

---

## 6. Чат, контакты, присутствие (тот же WebSocket)

**ChatV2.** Транспорт описан в `SDK:5570-5605` и `VEND:175155-175210`. Исходящие кадры:

```json
{"method":"ChatV2","sn":<int++>,"containerType":0,"messageType":<P>,"payload":{…}}
```

- Ответ приходит с тем же `sn` и `containerType` `1` (SUCCESS) или `2` (ERROR).
- Событие: `containerType:3` с полями `eventType` и `event`.
- Входящий `method` нормализуется к `chatV2`. Возможности: `exactHandlerVersion:50`.

Коды `messageType` (`VEND:171975-172005`):

| Код | Имя |
|---|---|
| 0 | `CHAT_LIST` |
| 1 | `CHAT_INFO` |
| 2 | `CHAT_PARTICIPANT_LIST` |
| 3 | `CHAT_BAN_LIST` |
| 4 | `CHAT_FILE_LIST` |
| 5 | `CHAT_PERMISSION` |
| 6 | `CHAT_HISTORY` |
| 7 | `CREATE_GROUP_CHAT` |
| 8 | `CREATE_P2P_CHAT` |
| 9 | `EDIT_CHAT` |
| 10 | `LEAVE_CHAT` |
| 11 | `ADD_CHAT_PARTICIPANT` |
| 12 | `KICK_CHAT_PARTICIPANT` |
| 13 | `SEND_GROUP_MESSAGE` |
| 14 | `SEND_P2P_MESSAGE` |
| 15 | `REMOVE_MESSAGE` |
| 16 | `EDIT_MESSAGE` |
| 17 | `FORWARD_MESSAGE` |
| 18 | `CLEAR_CHAT_HISTORY` |
| 19 | `REMOVE_CHAT` |
| 20 | `CHANGE_ROLE` |
| 21 | `GRANT_PERMISSION` |
| 22 | `REVOKE_PERMISSION` |
| 23 | `CHAT_AVATAR` |
| 24 | `MESSAGE_INFO` |
| 25 | `ACTIVITY` |
| 26 | `MESSAGE_DRAFT` |
| 27 | `READ_MESSAGE` |
| 28 | `PERMISSIONS_CONFIG` |

Примеры `payload` (`VEND:174265-174345`, `VEND:174956-175030`):

- `CHAT_LIST {pageSize, pageNum}`;
- `CREATE_P2P_CHAT {callId:"<trueconfId>"}` → `{chatId,…}`;
- `SEND_GROUP_MESSAGE {chatId, type:200, replyMessageId, content:{text}}`;
- `SEND_P2P_MESSAGE {chatId, to:"<trueconfId>", type:200, replyMessageId, content:{text}}`;
- `CHAT_HISTORY {chatId, count, type:BACKWARD|FORWARD, messageId}`;
- `READ_MESSAGE {chatId, messageId}`;
- `EDIT_MESSAGE {chatId, messageId, type, content}`;
- `REMOVE_MESSAGE {chatId, messageId, forAll}`.

Типы содержимого (`VEND:172890-172930`): `TEXT 200, FILE 201, LOCATION 203, WEB_APP 204`. Системные: `P2P_CALL_OK 300, GROUP_CONF_START 310 …`.

События `eventType` (`VEND:172851`): `0 RECEIVE_MESSAGE, 1 EDIT_MESSAGE, 2 CREATE_CHAT, 3 PERMISSIONS_CHANGED, 4 ACTIVITY, 5 DRAFT_MESSAGE, 6 MESSAGE_READ, 7 ROLE_CHANGED`.

**Адресная книга** (`SDK:4400-4990`):

- Запросы:
  - `addressBookInit{contactListHash, groupsHash, phoneListHash, banListHash}`;
  - `getUserDetails{callId,hash}`, `searchAddressBook{searchTerm}`;
  - `addExternalContact{callId,displayName}`, `removeExternalContact{callId}`;
  - `createGroup{name}`, `renameGroup{groupId,name}`, `deleteGroup{groupId}`;
  - `addUserToGroup{groupId,callId}`, `removeUserFromGroup{groupId,callId}`;
  - `blockContact{callId}`, `unblockContact{callId}`;
  - `add|update|removePhoneNumber`;
  - `get|set|removeProfilePicture`.
- Входящие: `contactListUpdated, contactsAdded, contactsRemoved, groupsUpdated, banListUpdated, phonesUpdated, addToPhoneBook, removeFromPhoneBook, phoneUpdate, notModified, profilePictureRemoved`.

**Присутствие** (`SDK:4940-5030`):

- Подписка: `{"method":"bulkSubscribeUserStatus","callIds":[…]}`, отписка: `bulkUnsubscribeUserStatus`.
- Уведомления: `{"method":"contactsStatusUpdate","contacts":[{"callId":"…","status":n,…}]}`.
- Статусы: `USER_LOGOFF 0, USER_AVAIL 1, USER_BUSY 2, USER_PUBLIC 3, USER_MULTIHOST 5` (`SDK:4570-4590`).
- Свой текстовый статус: `setAdditionalStatus{description}`.

**Профиль:**

- `changeUserProfile{requestId,…}` → `changeUserProfileResponse`;
- `changeUserPassword` → `changeUserPasswordResponse`;
- `updateSessionKey` → `updateSessionKeyResponse{isUpdated,sessionKey}`;
- `userProfileChangedNotification`.

**Данные между клиентами:** через `command` / `info`. Например, `statusRequest`/`statusResponse{version:"2.0"}`, `dataTransfer{method:"create"|"message"}` (`SDK:2960-3100`).

---

## 7. Чего не проверяли и где риск

- Вживую ничего не отправляли. Порядок шагов и поля взяты из кода, их нужно подтвердить на стенде своей учёткой. Удобно снять трафик WS в DevTools во время настоящего входа.
- Точный формат `web_url` для конференции из `/api/v4/software/clients` генерирует сервер. Для своего клиента это не нужно: достаточно `loginUser` с паролем.
- Как сервер отвечает на вход по RAW-паролю при LDAP. Форма веб-клиента делает именно так, значит это должно работать.
- `version` в `loginUser` фактически `undefined`: SDK вызывает `sendLoginRequest` с 4 аргументами.
- Флаги `participantFlags.TRANSLATOR` и некоторые enum'ы (`L.$` для `PinUser.Type`, `A` для `roleEvent.type` 1/2) раскрыты частично.
