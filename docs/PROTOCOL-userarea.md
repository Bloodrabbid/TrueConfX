# TrueConf Server 5.5 (tc.example.com): API личного кабинета и веб-чата

Дата: 2026-10-22. Сервер: `tc.example.com`, `product.id = <SERVER_ID>`, клиенты сборки 5.5.5.10009.
Бандл кабинета: `user-area` 5.5.4.1019. Бандл веб-клиента: `webrtc` 5.5.4.12.
Нативный клиент для сравнения: TrueConf Client 8.3.2 (macOS, Qt).

Метод разбора: статический разбор JS. Вход не выполнялся. Публичные ответы сняты простым GET без токена.

## 0. Обозначения для ссылок

Все ссылки даны в форме `[ключ]:строка`. Файлы прогнаны через prettier, номера строк относятся к этим копиям.

| Ключ | Файл |
|---|---|
| `[UA]` | `/tmp/tcrecon/ua.pretty.js` (главный бандл кабинета `index.bundle-5.5.4.1019.js`) |
| `[UA:<имя>]` | `/tmp/tcrecon/user-area/pretty/<имя>.bundle-5.5.4.1019.js` (ленивые чанки, все 91 скачаны) |
| `[SDK]` | `/tmp/tcrecon/sdk.pretty.js` (`webrtc/chunks/web-sdk.bundle-5.5.4.12.js`) |
| `[CHAT]` | `/tmp/tcrecon/m66675.pretty.js` (модуль webpack 66675 из `vendors.bundle-5.5.4.12.js`: транспорт ChatV2) |
| `[CORE]` | `/tmp/tcrecon/chatcore.pretty.js` (модуль 36195: `ChatManager`, модели сообщений) |
| `[PUB]` | `/tmp/tcrecon/public/*.json` (публичные ответы сервера) |
| `[DB]` | `/tmp/tcrecon/schemas.txt` (только схемы SQLite нативного клиента) |

Сырые чанки лежат в `/tmp/tcrecon/user-area/chunks/`. Модули webpack извлекает `/tmp/tcrecon/extract.js` (`node extract.js <id> vendors.js web-sdk.js`).

## 1. Общая картина

```
                      +-----------------------------+
 Свой клиент -------->| HTTPS REST  /api/v4, v3.10  |  OAuth2 Bearer (access_token)
                      |             /api/client/v1  |
                      +-----------------------------+
          |  обмен токена  (POST /bridge/api/client/v1/auth/web_rest_api_token
          |                 -> /bridge/api/client/v1/auth/token)  => JWT
          v
 +-------------------------------+   +-------------------------------+
 | WSS /websocket/   (JSON)      |   | WSS /websocket/calendar/      |
 | loginUser(JWT), адресная      |   | subprotocol "json.v1"         |
 | книга, статусы, звонки,       |   | auth(JWT), getAppointments... |
 | method:"ChatV2" = чат         |   +-------------------------------+
 +-------------------------------+
 | HTTPS /bridge/api/client/v1/files  (загрузка вложений чата)       |
 +--------------------------------------------------------------------+
 Нативный клиент: свой бинарный транспорт (VS_TransportManager), порт 4307.
```

Главный вывод: **чат доступен без бинарного протокола 4307.** Веб-клиент ведёт чат через WebSocket `/websocket/` сообщениями `{"method":"ChatV2",...}` (раздел 4).

## 2. Вход зарегистрированного пользователя

### 2.1 Получение токена OAuth2

`POST /api/v4/oauth2/token`, тело JSON. Вызов: `authorization()` в `[UA]:37678-37762`.

| grant_type | client_id | Поля тела | Где | Назначение |
|---|---|---|---|---|
| `password` | `trueconf_server_users` | `username`, `password` | `[UA]:43634-43656`, `[UA]:40343` | обычный вход |
| `trusted_password` | (не задан) | `username`, `password` | `[UA]:43737-43742` | вход через внешнего провайдера (popup, `postMessage`) |
| `refresh_token` | `trueconf_server_users` (или сохранённый `client_id`) | `refresh_token` | `[UA]:78212-78216` | продление |
| `guest` | `trueconf_server_guests` | `display_name` | `[UA]:43776-43781` | гость |
| `client_secretkey` | `trueconf_server_users` | `call_id`, `k` | `[UA]:54266-54273` | автовход из нативного клиента по ссылке `?call_id=&k=` |
| `webtool` | из URL | `call_id`, `msg_id`, `display_name`, `s` | `[UA]:54300-54307` | вход веб-инструмента из чата |
| `authorization_code` | — | `code` | только для `/bridge/...` (2.3) | — |

Ответ (по коду): `access_token`, `refresh_token`, `expires_in` или `expires_at`, `user_id` (для `webtool`). Клиент сам дописывает `receipt_time` (из заголовка `Date`) и `client_id` (`[UA]:37688-37692`, `[UA]:37721-37724`).
Особый ответ «пользователь с другого сервера»: `{call_id, k, url}` вместо токена (`[UA]:37747-37748`). Ошибка: `{error:{code, errors:[{reason}]}}`.

Коды `reason` при входе (`[UA]:39000-39050`): `invalidLoginOrPassword`, `userIsBanned`, `userIsInactive`, `LDAPLoginNotFoundOrLDAPIsDisabled`, `LDAPLoginAmbiguous`, `missingRequiredField`, `2FactorAuthEnabled`.

**2FA.** При `reason = "2FactorAuthEnabled"` ответ содержит `email` (`[UA]:43645-43650`, `[UA]:40372`). Форма `OneOffCodeForm` (`[UA]:41231-41300`) в этой сборке запрос с кодом **не отправляет**. Формат ввода кода через API не виден.

**Транспорт токена.** Заголовок `Authorization: Bearer <access_token>` ставит интерцептор `Spe` (`[UA]:78260-78285`). Без токена идут `^/api/v4/oauth2/token`, `^/api/v4/server`, `/api/v3.x/conferences/.+/registrations`, `^/sai/.+`. Для картинок (`avatar`) токен идёт параметром `?access_token=` (`uc()` в `[UA]:37600-37610`, getter `getAccessTokenParam` в `[UA]:37653`).

**Продление.** Интерцептор продлевает токен, когда до конца жизни осталось не больше `N4 = 30` секунд (`[UA]:78087`, `[UA]:78176-78225`). Время сверяется с серверным `timestamp` из `GET /api/v4/server`. Межвкладочная блокировка: ключ localStorage `TrueconfUpdatingToken` (`[UA]:43522`). При неудаче: ошибка `SESSION_IS_EXPIRED` (`[UA]:43520`).

**Проверка и выход.**
- `GET /api/v4/me/token` → `{token:{...}}`: свежая информация о токене (`[UA]:37845-37880`).
- `GET /api/v4/me` → `{user | admin | guest | roaming_user}` (`[UA]:37800-37843`). Тип сессии выбирает ветка ответа.
- `POST /api/v4/oauth2/logout`, тело `{access_token}` (`[UA]:37905-37920`).
- `GET /api/v4/oauth/clients` → `{clients}` (`[UA]:37883-37893`).
- `GET /api/v4/auth/manifest?version=&lang=&os=web` (`[UA]:37894-37903`). Ответ tc.example.com: `{"password":true,"microsoft_outlook":false}` (`[PUB]`). Список `networks[]` с `features.login/logout` описывает внешних провайдеров (`[UA]:43745-43760`). На tc.example.com их нет.

**Хранение в браузере (localStorage).**

| Ключ | Содержимое | Ссылка |
|---|---|---|
| `trueconfServerUserAuthorization` | `{userInfo, tokenInfo}` | `[UA]:37646`, `[UA]:37694-37702` |
| `trueconfCalendarUserAuthorizationCode` | JWT от `/bridge` | `[UA]:48996`, `[UA]:49011-49015` |
| `trueconfSAIUserAuthorization` | токены Server AI | `[UA]:49680` |
| `trueconfServerUserName`, `trueconfServerGuestName` | логин, имя гостя | `[UA]:40350`, `[UA]:43663` |

### 2.2 LDAP / AD

`GET /api/v4/server` на tc.example.com отдаёт `config.storage_type = "LDAP"` (`[PUB] api_v4_server.json`). Значит, учётки берутся из AD. Отдельного LDAP-эндпоинта у пользователя нет. Вход идёт тем же `grant_type=password`. Ошибки LDAP описаны выше. Kerberos/SSO в бандле не найдено. Также `"integrations":{"calendar_enabled":false}`.

### 2.3 Обмен на JWT через bridge

Нужен для чата (раздел 4) и календарного WebSocket. Код: стор `calendarAuth` (`[UA]:48992-49026`), вызовы в `[UA]:53608-53624` (маршрут `user.chats`) и `[UA:calendarConnection]:10-27`.

1. `POST /bridge/api/client/v1/auth/web_rest_api_token`, тело `{client_id:"trueconf_server_users", token:<OAuth access_token>}` → `{authorization_code}`. Имя пути берётся из словаря `{trueconf_server_users:"web_rest_api_token"}` (`[UA]:49003`).
2. `POST /bridge/api/client/v1/auth/token`, тело `{client_id, grant_type:"authorization_code", code}` → `jwtTokenInfo` с полями `access_token`, `tokenType` (`[UA]:49008-49016`).
3. JWT кладётся в `trueconfCalendarUserAuthorizationCode`.

Продление JWT в коде не найдено. Кабинет повторяет шаги 1–2 при каждом входе на страницу чата.

### 2.4 Токены Server AI (SAI)

- Пользователь: `POST /sai/api/user/v1/auth/from-tcs`, тело `{token:<OAuth access_token>, domain:<external_url>}` (`[UA]:49750-49766`, вызов `[UA:ServerAIMixin]:29-32`).
- Продление: `POST /sai/api/user/v1/auth/refresh`, тело `{refresh_token}` (`[UA]:49767-49785`).
- Админ: `POST /api/v4/servers-ai/token` → `{token}` (`[UA]:49740-49745`).
- Права: поле `sai_rights` в `/api/v4/me` (`[UA]:78293-78300`).
- API: `/sai/api/v1/product`, `/sai/api/v1/product/config`, `/sai/api/user/v1/transcriptions[/<id>[/audio|/lines|/associated-users]]`, `/sai/api/user/v1/transcriptions/start` (`[UA]:49724-49990`).
- WebSocket: `wss://<host>/sai-ws/api/user/v1/transcriptions/ws`, подпротокол `["Bearer", <sai token>]` (`[UA]:22055-22070`, `[UA:index.bundle-5.5.4.101916]` строка 1838; файл `.../pretty/index.bundle-5.5.4.101916.js`).

## 3. REST для обычного пользователя

Все запросы ниже несут `Authorization: Bearer <OAuth access_token>`. Многие принимают `timezone` (IANA, функция `MF`/`NF`, `[UA]:48443`) и `url_type=fixed`.

### 3.1 Сервер и настройки (без токена или с ним)

| Метод, путь | Ответ / заметки | Ссылка |
|---|---|---|
| `GET /api/v4/server` | `product`, `config.storage_type`, `web_config.url/external_url`, `integrations` | `[UA]:37529`, `[PUB]` |
| `GET /api/v4/webrtc/public` | `{min_port:53000,max_port:55000}` | `[UA]:38698`, `[PUB]` |
| `GET /api/v4/configs/page/guest` | `ui.login_enabled` | `[UA]:38670`, `[PUB]` |
| `GET /api/v4/configs/page/conference-public` | `conference.prefix`, `*_join_options`, `calendar_scheduled_room_emulation_enabled` | `[UA]:38659`, `[PUB]` |
| `GET /api/v4/configs/page/user-general`, `.../user-account`, `.../conference-edit` | настройки страниц кабинета | `[UA]:38646-38710` |
| `GET /api/v4/software/clients` | ссылки на клиенты | `[UA:index.bundle-5.5.4.1019]`, `[PUB]` |
| `GET /api/ui/conference-editor/config` | конфиг редактора | `[UA]:38885` |

### 3.2 Профиль

| Метод, путь | Тело / ответ | Ссылка |
|---|---|---|
| `GET /api/v4/me` | `{user:{id, login_name, display_name, avatar, sai_rights, ...}}` | `[UA]:37811` |
| `GET /api/v4/users/{id}` | `{user}` | `[UA:index.bundle-5.5.4.10196]`:2348 |
| `PATCH /api/v4/users/{id}` | поля профиля (без `id`) | `...10196`:1520-1532 |
| `PUT /api/v4/users/{id}/avatar` | файл аватара | `...10196`:1547-1560 |
| `DELETE /api/v4/users/{id}/avatar` | — | `...10196`:1534-1545 |
| `POST /api/v4/users/validate-password` | `{password}` | `...10196`:1562-1573 |

### 3.3 Адресная книга, поиск, присутствие

Стор адресной книги: `[UA]:74700-74950`. Пагинация курсором: `page_size`, `page_id`; ответ `next_page_id`.

| Метод, путь | Параметры / тело | Ответ | Ссылка |
|---|---|---|---|
| `GET /api/v3.10/users/{me}/addressbook` | `page_size`, `page_id`; для поиска `login_name`, `display_name`, `first_name`, `last_name`, `email` | `{contacts:[...], next_page_id}` | `[UA]:74708-74750`, `[UA]:74822-74860` |
| `GET /api/v3.10/users/{me}/ab/{inherited|own}/groups` | `page_size`, `page_id` | `{groups:[{id, display_name}], next_page_id}` | `[UA]:74760-74815` |
| `GET /api/v3.10/users/{me}/ab/{ctx}/groups/{gid}/contacts` | `page_size`, `page_id` | `{contacts, next_page_id}` | `[UA]:74862-74930` |
| `POST /api/v3.10/users/{me}/addressbook` | контакт | — | `[UA:addressBookEditor]:63-80` |
| `PUT /api/v3.10/users/{me}/addressbook/{contact_id}` | контакт | — | `[UA:addressBookEditor]:81-97` |
| `DELETE /api/v3.10/users/{me}/addressbook/{contact_id}` | — | — | `[UA:addressBookEditor]:98-115` |
| `GET /api/v4/directory/servers` | — | `{servers:[{id, url, token, version, name}]}` | `[UA]:75430-75458` |
| `GET /api/v4/users` (или `/api/v3.10/users` для серверов < 5.5) | `page_size`, `filter_ids`, `filter_emails` | список пользователей каталога | `[UA]:75459-75480`, `[UA]:75725-75745` |

**Присутствие по REST.** Двухшаговая схема с JSONP (`[UA]:74931-74946`, `[UA]:75788-75900`):
1. `POST /api/v3.10/server/s4` (весь контакт-лист; вариант `?resolve=directory`) или `POST /api/v3.10/server/s2` с телом `{users:[...]}` → `{urls:[...]}`.
2. Каждый URL запрашивается как JSONP. Ответ: объект `{ "<call_id в нижнем регистре>": <int статус> }`.

Значения статуса (`[SDK]:4570-4578`): `-127` USER_STATUS_UNDEF, `-1` USER_INVALID, `0` USER_LOGOFF, `1` USER_AVAIL, `2` USER_BUSY, `3` USER_PUBLIC, `4` USER_VIPPUBLIC, `5` USER_MULTIHOST.
Живые статусы проще получать по WebSocket (раздел 4.2: `bulkSubscribeUserStatus`).

### 3.4 Конференции

Стор: `[UA]:48585-48990`. Создание и правка: `[UA:conferenceAppearance]:402-437`. Список: `[UA:conferenceList]:211-300`.

| Метод, путь | Параметры / тело | Ответ | Ссылка |
|---|---|---|---|
| `GET /api/v4/conferences` | `page`, `page_size` (50), `url_type=fixed`, `topic_cid_contains`, `owner`, `invitation`, `sort_field=topic`, `sort_order` (0/1), `schedule_type`, `before`, `after`, `timezone`, `origin_client_id`, `invitations_substring`, `state=running` (активные) | `{results:<count>, conferences:[...]}` | `[UA:conferenceList]`:93-112, 211-300 |
| `POST /api/v4/conferences?timezone=` | тело по маппингу `tve` | `{conference}` | `[UA:conferenceAppearance]`:402-418, `[UA]:48342-48440` |
| `PATCH /api/v4/conferences/{id}` | то же | `{conference}` | `[UA:conferenceAppearance]`:420-437 |
| `GET /api/v4/conferences/{id}` | `url_type`, `timezone` | `{conference}` | `[UA]:48601-48610` |
| `DELETE /api/v4/conferences/{id}` | — | — | `[UA]:48876-48888` |
| `POST /api/v4/conferences/{id}/run` | — | — | `[UA]:48801-48813` |
| `POST /api/v4/conferences/{id}/stop` | — | — | `[UA]:48815-48828` |
| `POST /api/v4/conferences/{id}/join` | — | — | `[UA]:48830-48843` |
| `POST /api/v4/conferences/{id}/invite` | `{participants:[...]}` | — | `[UA]:48845-48858` |
| `POST /api/v4/conferences/{id}/notify` | тело рассылки приглашений | — | `[UA]:48860-48873` |
| `GET /api/v4/conferences/{id}/owner` | — | `{owner}` | `[UA]:48612-48627` |
| `GET /api/v3.10/conferences/{id}/invitations` | `url_type` | `{invitations}` | `[UA]:48628-48660` |
| `GET /api/v4/conferences/{id}/participants` | `page_size=1000` | `{list, cnt}`; ошибка `conferenceNotRunning` | `[UA]:48662-48695` |
| `GET /api/v4/conferences/{id}/translations` | — | `{translations}` | `[UA]:48697-48720` |
| `GET /api/v4/conferences/{id}/calendars` | `lang`, `timezone` | `{calendars}` (ICS-ссылки) | `[UA]:48722-48745` |
| `GET /api/v3.10/conferences/{id}/shared` | — | `{embedded:{webrtc, cdn_video}, rtsp_url}` | `[UA]:48747-48772` |
| `GET/POST/DELETE /api/v3.10/conferences/{id}/reserved-operators[/{uid}]` | — | `{operators}` | `[UA]:48774-48799`, `[UA:conferenceAppearance]`:450-510 |
| `GET /api/v4/conferences/{id}/me` | — | `{conference}` (мои права) | `[UA]:48955-48968` |
| `GET /api/v4/conferences/{id}/deeplinks` | любые `parameters` | `{deeplinks:{android, ios, mac, windows, linux, default}}` | `[UA]:48969-48988` |
| `POST /api/v4/conferences/{id}/recordings/start` и `/stop` | — | — | `[UA]:48925-48954` |
| `PATCH /api/v4/sessions/{sid}` | правка идущей сессии | — | `[UA]:48889-48900` |
| `PATCH /api/v4/sessions/{sid}/participants/{pid}/instances/{inst}` | правка участника | — | `[UA]:48901-48924` |
| `GET /api/v3.11/templates/conferences[/{id}]`, `POST`, `PUT`, `DELETE` | шаблоны | `{template}` | `[UA:templateList]`:218-270, `[UA:conferenceAppearance]`:560-610 |
| `GET /api/v3.10/conference-meetings` | — | `{list}` (переговорные) | `[UA:conferenceAppearance]`:524 |
| `GET /api/v4/conferences/{id}/foregrounds`, `PUT/DELETE .../background/image` | оформление | — | `[UA:conferenceAppearance]`:610-730 |

**Тело создания (маппинг `tve`, `[UA]:48342-48440`).** Основные поля: `topic`, `description`, `owner`, `mode` (`"PxP"` симметричная, `"OxP"` асимметричная, `"S|L"` ролевая, `"S|L Auto"` smart meeting), `access` (`"public"`/`"private"`), `invitations`, `max_participants`, `max_podiums`, `pin`, `recording_enabled`, `auto_invite`, `allow_only_planned_participants`, `waiting_room_enabled`, `waiting_room_scope`, `on_join_mute_mic`, `on_join_mute_camera`, `reminders`, `reminders_enabled`, `tags`, `join_options`, `schedule`.
`schedule`: `{type:"none"}` или `{type:"once"|"week", start_time, duration, time, days, special_time_offset}`.

**Ответ `conference` (маппинг `Gue`, `[UA]:48218-48340`).** Кроме полей выше: `id`, `state`, `session{id, expiration_time, ...}`, `url`, `web_client_url`, `connect_urls`, `stream_recording_state`, `created_at`, `origin_type`, `origin_client_id`, `rights`.

### 3.5 Календарь

**REST.** Токен: OAuth Bearer (`accessToken: this.token`, `[UA:index.bundle-5.5.4.10197]`:733). Стор `appointment`: `[UA]:50040-50160`.

| Метод, путь | Тело | Ответ | Ссылка |
|---|---|---|---|
| `GET /api/client/v1/calendar` | — | информация о подключении календаря | `[UA:index.bundle-5.5.4.10195]`:777-786 |
| `GET /api/client/v1/calendar/appointments/{id}` | — | `{appointment}` | `[UA]:50048-50066` |
| `POST /api/client/v1/calendar/appointments/get-by-location` | `{location:"https://tc.example.com/c/<id>"}` | `{appointment}` | `[UA]:50067-50090` |
| `GET /api/client/v1/calendar/events/{id}/calendar-links` | — | ссылки на календари | `[UA]:50091-50103` |
| `POST /api/client/v1/calendar/appointments/` | appointment | `{appointment}` | `[UA]:50104-50119` |
| `PUT /api/client/v1/calendar/appointments/{id}` | appointment | `{appointment}` | `[UA]:50120-50140` |
| `DELETE /api/client/v1/calendar/appointments/{id}` | — | — | `[UA]:50141-50155` |

**WebSocket** `wss://<host>/websocket/calendar/`, подпротокол `json.v1` (`[UA]:21940-22045`). Подключается только при `server.calendarModeEnabled` (`[UA]:53345-53360`). На tc.example.com `calendar_enabled:false`.
Кадр запроса: JSON `{method, ...}`. Ответ сопоставляется по `method` (для `subscribe` по `method-calendarId`, для `getOccurrences` по `method-appointmentId`). Ошибка: `result:false`, `error` или `errorCode`. Событие: поле `event` (`[UA]:22003-22016`).

| method | Поля | Ответ | Ссылка |
|---|---|---|---|
| `auth` | `token` (JWT из 2.3), `tokenType` | `{userId}` | `[UA]:49022-49026` |
| `getCalendarList` | — | `{calendars}` | `[UA]:74208-74212` |
| `subscribe` | `calendarId` | `{subscriptionId}` | `[UA]:74213-74225` |
| `getAppointments` | `from`, `to`, `timezone`, `pagination` | `{appointments:[{id,start,end,recurrence,...}]}` | `[UA]:49178-49200` |
| `getOccurrences` | `from`, `to`, `timezone`, `appointmentId` | `{appointments}` | `[UA]:49201-49218` |
| `getAttendees` / `inviteAttendee` / `removeAttendee` | `appointmentId` / `email, role, displayName` / `email` | `{attendees}` | `[UA:index.bundle-5.5.4.10197]`:595-630 |

События: `createAppointment` и подобные (`[UA]:49300-49330`).

### 3.6 Записи конференций

Стор `logs`: `[UA:logs]`:1-70. Страница записей: `[UA:index.bundle-5.5.4.101910]`:27-75.

| Метод, путь | Параметры | Ответ |
|---|---|---|
| `GET /api/v4/conferences/{id}/recordings` | `page`, `page_size`, `filter_search`, `sort_field=started_at`, `sort_order`, `date_from`, `date_to` (unix), `show_deleted` | `{list:[{id, name, size, started_at, stopped_at, download_url}], cnt}` |
| `GET /api/v4/logs/recordings` | то же | все записи пользователя |

Скачивание: `window.open(download_url)` (`...101910`:27-33).
Админские журналы `/api/v4/logs/events|calls|messages|settings` тоже есть в чанке. Для обычного пользователя они, вероятно, закрыты (не проверено).

### 3.7 История звонков

`GET /api/v4/users/logs/calls` (`[UA:index.bundle-5.5.4.101913]`:20-95).
Параметры: `page`, `page_size` (20), `sort_field=start_time`, `sort_order`, `date_from`, `date_to`, `display_name`, `conference_type`, `direction`, `status`, `timezone`.
Фильтры: пропущенные `direction=0,status=1`; входящие `conference_type=0,direction=0,status=0`; исходящие `conference_type=0,direction=1`; конференции `conference_type=1,status=0`.
Ответ: `{list, cnt}`. Экспорт: `GET /api/v4/users/logs/calls/export`.

### 3.8 Файлы

- `POST /bridge/api/client/v1/files` (`multipart/form-data`: `file`, необязательный `preview`), заголовок `Upload-Task-Id: <uploadTaskId>` (`[SDK]:3336-3365`).
- `uploadTaskId` выдаёт WebSocket: запрос `{method:"createUploadTask", requestId, fileSize, fileName}` (`[SDK]:3300-3311`), ответ с `requestId`, `uploadTaskId`.
- Метаданные файла: `{method:"fileInfo", fileId}` → `{fileId, result, entries[], errorCode}` (`[SDK]:3385-3420`).
- Лимиты: событие `FileUploadLimits` (`extensions.block/list`, `upload`) (`[SDK]:3316-3332`).

## 4. Чат

### 4.1 Как чат устроен в вебе

Кабинет не реализует чат сам. Маршрут `user.chats` (`[UA]:53608-53624`):
1. Получает JWT через `/bridge` (раздел 2.3).
2. Открывает iframe `https://tc.example.com/webrtc/chat#login=<login_name>&token=<JWT>&tokenType=JWT&bearer=<OAuth access_token>` (`[UA:index.bundle-5.5.4.101919]`:17-22).

Веб-клиент `/webrtc/` принимает в hash поля `login, password, token, host, port, path, secure, tokenType, bearer, ...` (`webrtc/bundle-5.5.4.12.js`, смещение ~1299). Маршрут `/webrtc/outer-chat` включает режим «только чат».

**Ответ на вопрос 3:** чат есть в JSON-протоколе через WebSocket. Бинарный порт 4307 для него не нужен. Отдельного HTTP REST для сообщений нет. HTTP нужен только для загрузки вложений.

### 4.2 Сигнальный WebSocket `/websocket/`

URL: `ws[s]://<host>:<port>/<path>`, `path` по умолчанию `websocket/`, необязательный `?prevCID=` (`[SDK]:7233-7245`, `[SDK]:7359-7362`). Для tc.example.com ожидается `wss://tc.example.com:443/websocket/` (порт и хост берутся из страницы, точное место не найдено; это вывод).
Кадр: JSON-объект с полем `method` (сервер может прислать `Method`, клиент приводит первую букву к нижнему регистру) (`[SDK]:7262-7275`).

Порядок:
1. `{method:"ping"}` → `pong` с `version` (версия протокола) (`[SDK]:9046-9054`).
2. `loginUser` (`[SDK]:9024-9035`):
   ```json
   {"method":"loginUser","AppID":"...","login":"<login_name>","credentials":"<JWT>",
    "credentialsType":0,"chatV2Enabled":true,"browser":"<UA>","version":"...",
    "appLang":"ru","appVersion":"...","appName":"..."}
   ```
   `credentialsType` (`[SDK]:9962-9969`): `JWT=0`, `JWE=1`, `RAW=2` (пароль), `TOKEN=3`, `MD5=4`, `AUTOLOGIN=5`.
3. Ответ `loginResponse`: `CID`, `Key`, `trueconfId`, `displayName`, `Rights`, `Session`, `applicationSettings`, `webTools`, `messageEditDuration` (`[SDK]:9000-9013`). Выход: `{method:"logoutUser", CID}`.

Методы адресной книги и присутствия (`[SDK]:4960-5290`):

| Запрос | Поля | Ответ / событие |
|---|---|---|
| `addressBookInit` | `contactListHash`, `groupsHash`, `phoneListHash`, `banListHash` | `contactListUpdated`, `contactsAdded`, ... |
| `searchAddressBook` | `searchTerm:{callId,email,displayName}` | `searchAddressBook` |
| `getUserDetails` | `callId`, `hash` | `getUserDetails` |
| `bulkSubscribeUserStatus` / `bulkUnsubscribeUserStatus` | `callIds:[...]` | событие `contactsStatusUpdate {contacts:[...]}` |
| `setAdditionalStatus` | `description` | — |
| `addExternalContact` / `removeExternalContact` | `callId`, `displayName` | — |
| `blockContact`, `unblockContact`, `createGroup`, `renameGroup`, `deleteGroup`, `addUserToGroup {groupId, callId}`, `removeUserFromGroup` | — | — |
| `changeUserProfile`, `setProfilePicture`, `getProfilePicture`, `addPhoneNumber`, ... | — | — |

Звонки и конференции тоже идут через этот сокет: `createConference {topic, preset, audioMute, videoMute, useWaitingRoom, allowGuests, maxParticipants, maxCasters}` (`[SDK]:14129-14141`), `join`, `hangup`, `inviteUser`, `getIceConfig`, `connectMedia` и др.

### 4.3 Протокол ChatV2

Транспорт: класс `Ue` (`[CHAT]:3650-3735`). Кадры ChatV2 идут в том же сокете (`[SDK]:5583-5596`).

Запрос:
```json
{"method":"ChatV2","sn":<int, растёт>,"containerType":0,"messageType":<int>,"payload":{...}}
```
`containerType` (`[CHAT]:615-620`): `0` REQUEST, `1` SUCCESS_RESPONSE, `2` ERROR_RESPONSE, `3` EVENT.
Ответ сопоставляется по `sn`. Ошибка: поле `error.errorText`, либо `error`/`errorCode` внутри `payload` (`[CHAT]:3720-3727`, `[CHAT]:3388-3391`).
Событие: `{"method":"ChatV2","containerType":3,"eventType":<int>,"event":{chatId,...}}` (`[CHAT]:1385-1395`).

`messageType` (`[CHAT]:559-589`): 0 CHAT_LIST, 1 CHAT_INFO, 2 CHAT_PARTICIPANT_LIST, 3 CHAT_BAN_LIST, 4 CHAT_FILE_LIST, 5 CHAT_PERMISSION, 6 CHAT_HISTORY, 7 CREATE_GROUP_CHAT, 8 CREATE_P2P_CHAT, 9 EDIT_CHAT, 10 LEAVE_CHAT, 11 ADD_CHAT_PARTICIPANT, 12 KICK_CHAT_PARTICIPANT, 13 SEND_GROUP_MESSAGE, 14 SEND_P2P_MESSAGE, 15 REMOVE_MESSAGE, 16 EDIT_MESSAGE, 17 FORWARD_MESSAGE, 18 CLEAR_CHAT_HISTORY, 19 REMOVE_CHAT, 20 CHANGE_ROLE, 21 GRANT_PERMISSION, 22 REVOKE_PERMISSION, 23 CHAT_AVATAR, 24 MESSAGE_INFO, 25 ACTIVITY, 26 MESSAGE_DRAFT, 27 READ_MESSAGE, 28 PERMISSIONS_CONFIG.

`eventType` (`[CHAT]:1399-1407`): 0 RECEIVE_MESSAGE, 1 EDIT_MESSAGE, 2 CREATE_CHAT, 3 PERMISSIONS_CHANGED, 4 ACTIVITY, 5 DRAFT_MESSAGE, 6 MESSAGE_READ, 7 ROLE_CHANGED.

Основные запросы (payload):

| Операция | messageType | payload | Ссылка |
|---|---|---|---|
| Список чатов | 0 | `{pageSize:1024, pageNum:1}` → `{list:[chat]}` | `[CHAT]:2837-2855` |
| Инфо о чате | 1 | `{chatId}` | `[CHAT]:3764` |
| История | 6 | `{chatId, count:40, type:0 (BACKWARD)|1 (FORWARD), messageId}` → `{list:[message]}` | `[CHAT]:3318-3333` |
| Открыть P2P | 8 | `{callId:"user@server"}` → chat | `[CHAT]:2856-2878` |
| Создать группу | 7 | `{title, avatar, isChannel}` | `[CHAT]:2784-2812` |
| Отправить в P2P | 14 | `{chatId, to, type:200, replyMessageId, content:{text}}` | `[CHAT]:3448-3466` |
| Отправить в группу | 13 | `{chatId, type, replyMessageId, content}` | `[CHAT]:3502-3518` |
| Правка | 16 | `{chatId, messageId, type, replyMessageId, content}` | `[CHAT]:3393-3425` |
| Удаление | 15 | `{chatId, messageId, forAll}` | `[CHAT]:3305-3316` |
| Пересылка | 17 | `{chatId, forwardMessageId}` | `[CHAT]:3467-3476` |
| Прочитано | 27 | `{chatId, messageId}` | `[CHAT]:3001-3006` |
| Набор текста | 25 | `{chatId, activityType}` (0 TYPING … 4 UPLOADING_FILE) | `[CHAT]:2985-2991` |
| Черновик | 26 | `{chatId, content:{content, reply_msg_id, original_message_id}}` | `[CHAT]:2970-2983` |
| Файлы чата | 4 | `{chatId, pageSize, pageCount}` | `[CHAT]:3297-3303` |
| Участники | 11/12, 2 | `{chatId, callId[, clearChat]}` | `[CHAT]:2906-2945` |

Объект сообщения (`[CHAT]:2520-2660`): `messageId` (UUID), `chatId`, `type`, `sender` (call_id), `timestamp`, `content`, `parentMessageId`, `originalMessageId`, `replyMessageId`, `isRead`, `position`.
`content` по типу: TEXT `{content:"текст"}` (при отправке `{text}`); FILE `{file_name, file_size, file_type, hash, mgnt, url, description, preview}`; LOCATION `{latitude, longitude}`; WEB_APP `{tool_url, path, tool_version, title, content, text_btn, secret, alt}`.

Типы сообщений (`[CHAT]:1440-1465`): 100 CREATE_GROUP_CHAT, 101 CREATE_P2P_CHAT, 102 CREATE_SYSTEM_CHAT, 103 EDIT_CHAT_TITLE, 104 EDIT_CHAT_AVATAR, 106 CREATE_FAVORITES_CHAT, 110 ADD_PART, 111 REMOVE_PART, 112 LEAVE_CHAT, 140–142 роли и права, **200 TEXT**, **201 FILE**, 203 LOCATION, 204 WEB_APP, 221/222 DELETE_FOR_ME/ALL, 223/224 CLEAR_HISTORY_*, 300/301 P2P_CALL_OK/FAIL, 310–314 GROUP_CONF_*, 400–403 уведомления.

Объект чата (`[CHAT]:3073-3110`): `chatId`, тип (`jt`: 1 P2P, 2 GROUP, 3 SYSTEM, 4 MISSED_CALLS, 5 FAVORITES), `title`, `avatarUrl`, `notification`, `conferenceSessions`, `draftMessage`, `lastVisibleMessage`.

Вложение в чат по шагам: `createUploadTask` → `POST /bridge/api/client/v1/files` с `Upload-Task-Id` → сообщение type 201 (`[SDK]:3290-3365`).

### 4.4 Что не найдено

- REST-ручек вида `/bridge/api/client/v1/chats` в бандлах нет. Если они есть на сервере, веб их не использует.
- Чат в конференции веб-клиент шлёт как `{method:"chat", type:"room", ...}` и `dataTransfer` `{method:"message"}` (`[SDK]:3080-3130`, `[SDK]:12405-12417`). Это внутренняя шина, не ChatV2.

## 5. Ссылки на вход и deep links

- Веб-страница конференции: `https://tc.example.com/c/<conference_id>` (`[UA:InstructionForUnauthorizedUser]`:505-512, `[UA:conferenceMixin]`:388-390).
- Идентификатор для клиента: `\c\<id>@<server_name>#vcs` (`[UA:index.bundle-5.5.4.101922]`:171-175).
- Схема приложения из `index.html`: `trueconf:\c\&h=tc.example.com:4307&topic=` (meta `al:ios:url`, `apple-itunes-app`).
- Готовые ссылки по ОС: `GET /api/v4/conferences/{id}/deeplinks` → `{deeplinks:{android, ios, mac, windows, linux, default}}` (`[UA]:48969-48988`). В Firefox `login=` кодируется (`[UA:conferenceMixin]`:406-410).
- В ответе конференции: `url`, `web_client_url`, `connect_urls` (`[UA]:48218-48340`).
- Веб-клиент: маршруты `/webrtc/:id`, `/webrtc/:id/conference[/chat|/participants|/settings]`, `/webrtc/:id/pin`, `/webrtc/outer-chat`, hash-параметры как в 4.1.
- Автовход из нативного клиента в кабинет: `?call_id=<id>&k=<key>` → `grant_type=client_secretkey` (`[UA]:43625-43633`, `[UA]:54266`).
- Ссылка на профиль в чате нативного клиента: `trueconf:<call_id>&do=profile` (строки бинарника).
- Конференция в нативном клиенте: `peerId = "\\c\\" + id` (строки бинарника).

## 6. Нативный клиент macOS (TrueConf Client 8.3.2)

**Протокол.** Строки бинарника показывают свой транспорт: `VS_TransportManager`, `VS_TransportSession`, `VS_TransportLoginParam`, `VS_ChatV2Manager` (`InitChat`, `SyncChat`, `SyncMyChat`). REST-путей `/api/` и `/bridge/` в бинарнике нет. Есть строка `auth=Bearer %s`. Вывод: нативный клиент ходит на порт 4307 по бинарному протоколу. Логика ChatV2 та же (те же коды сообщений), но упакована в бинарный транспорт.

**Файлы данных.** Папка `~/Library/Containers/org.trueconf.client/Data/Library/Application Support/TrueConf`. На каждую учётку свой префикс-хеш (`<HASH>.*`). Общие: `settings.sqlite`, `global-settings.sqlite`, `serverlist.sqlite`. Ниже только схемы (`[DB]`). Содержимое не читалось, кроме счётчиков по типам.

`<HASH>.6.chatV2.sqlite` (схема ChatV2):

| Таблица | Ключевые столбцы |
|---|---|
| `chats` | `id varchar(40)`, `type` (1 P2P, 2 GROUP, 3 SYSTEM, 4 MISSED_CALLS), `version`, `creator`, `created_at`, `title`, `title_message_id`, `container blob`, `conference_id` |
| `messages` | `id uuid`, `bucket_number`, `client_timestamp`, `db_timestamp`, `type` (коды из 4.3: 100…403), `sender`, `sender_type` (1 клиент, 2 сервер), `parent_message_id`, `original_message_id`, `content jsonb`, `container blob` |
| `chains` | `message_id`, `chat_id`, `int_order`, `text_order`, `parent_message_id`, `client_timestamp` (порядок в ленте) |
| `current_participants`, `deleted_participants` | `chat_id`, `message_id`, `name`, `type` |
| `participants_roles`, `roles`, `permissions`, `granted_permissions`, `revoked_permissions`, `permissions_config_hash` | роли и битовые маски прав |
| `last_read_messages` (`unread_count`), `chat_last_read_messages`, `last_visible_messages`, `first_visible_messages` | прочитанность |
| `chat_titles`, `statuses` (`is_deleted`), `deleted_messages`, `undelivered_messages`, `personal_chat_settings`, `global_context_hash` | служебное |

Плюс файл `<HASH>.chatV2.personal_contexts.dump` (личные контексты, не открывался).

Остальные базы:

| Файл | Таблица и столбцы |
|---|---|
| `<HASH>.lastcalls.sqlite` | `lastCalls(Type, ConfType, Peer, ReadDone, StartTime, JoinTime, EndTime, ConfId, NamedConfId, ConfName, InitialState, State, LinkedChatId)` |
| `<HASH>.cache.sqlite` | `peers(PeerId, DisplayName, ContactList, BanList, LastUpdate)`, `hash(BookId, BookHash, BookCrc)` — кэш адресной книги и хеши для `addressBookInit` |
| `<HASH>.groups.sqlite` | `groups(GroupId, GroupName, GroupType)`, `id_list(GroupId, PeerId)` |
| `<HASH>.phones.sqlite` | `phones(PhoneId, PeerId, Phone, Type, Editable)` |
| `<HASH>.avatar.sqlite` | `avatars(PeerId, PicMime, Pic, PicHash, ...)`, `thumbnails(...)` |
| `<HASH>.uploads.sqlite` | `uploads(info_hash, magnet_link, file_path, file_size, direction, status, client_type, message_id, ...)` — вложения чата идут через magnet/BitTorrent-подобный обмен |
| `<HASH>.fileTransferDB.sqlite` | `files(confId, fullFileName, fileName, size, timestamp, direction, peerId, peerDn, requestId)` |
| `<HASH>.settings.sqlite`, `global-settings.sqlite` | `settings(Name, Value)`, `scope_properties(Scope, Name, Value)` |
| `settings.sqlite` | ещё `logins(Domain, Login, Key)` — сохранённый ключ автовхода (не читался) |
| `serverlist.sqlite` | `servers(Domain, ServerName, ..., ChatVersion)`, `hosts(ServerName, Host, Port, ...)`, `helpers` |

## 7. Рекомендации для своего клиента

1. Вход: `POST /api/v4/oauth2/token` с `grant_type=password`, `client_id=trueconf_server_users`. Продление: `grant_type=refresh_token` за 30 с до конца срока.
2. Конференции, профиль, адресная книга, история звонков, записи: REST из раздела 3 с `Bearer`.
3. Чат и живые статусы: JWT через `/bridge` (2.3), затем `wss://tc.example.com/websocket/` → `ping` → `loginUser` с `credentialsType:0` → кадры `ChatV2`.
4. Вложения: `createUploadTask` → `POST /bridge/api/client/v1/files`.
5. Медиа звонков: WebRTC-путь веб-клиента (`getIceConfig`, `connectMedia`, порты UDP 53000–55000). Это отдельная тема.

## 8. Что осталось непроверенным

- Точные ответы REST под настоящим токеном. Нужен один вход владельца с записью HAR.
- Где веб-клиент берёт `host`/`port` для `/websocket/` по умолчанию (код в незагруженных чанках `webrtc`).
- Отдаёт ли сервер `/websocket/` на `443` или на отдельном порту.
- Срок жизни и продление JWT от `/bridge`.
- Как отправить код 2FA через API.
- Доступ обычного пользователя к `/api/v4/logs/*`.
