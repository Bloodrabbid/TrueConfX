# Нативный протокол TrueConf (порт 4307) в TrueConfX

Веб-протокол сервера (WSS `/websocket/`) не умеет P2P-звонки и не всегда отдаёт
вложения отправителя. Эти возможности есть только в закрытом бинарном протоколе
нативного клиента на порту 4307. Здесь — слой для работы с ним, построенный по
разбору официального клиента 8.3.2 (проект `~/Documents/TrueConf-RE`), а не по
догадкам: каждый готовый кусок сверен с живым захватом или эталоном.

## Платформы

- **Windows, Linux** — этот Electron-клиент (Node-слой ниже).
- **macOS** — отдельный нативный клиент на Swift (планируется). Node-модули здесь
  служат ему проверенным эталоном формата.

## Что готово и проверено

| Модуль | Что делает | Проверка |
|---|---|---|
| `vsvariant.cjs` | кодек контейнера VS_Variant (адаптивный range-кодер) + разбор/сборка полей | `vsvariant.test.cjs`: совпал с Python-эталоном байт-в-байт (7/7), round-trip |
| `vstransport.cjs` | преамбула `_VS_TRANSPORT_`, разбор ответа сервера, чтение кадров, декод VS_Variant | `vstransport.test.cjs`: сверено с живым захватом tc.t2.ru (декодирует сертификат сервера) |
| `vscrypto.cjs` | нонс v2rnd, вывод ключа `HASH(v1_buf‖v2rnd)`, AES-128-ECB (`VSSymmetricCrypt`), RSA из сертификата | `vscrypto.test.cjs`: порядок хэша, round-trip AES, RSA из реального серта (rsa-2048) |

Формат кадра: `[flen:u32 LE][dsize:u32 LE][range-coded: flen-4 байт]`.
Строковое поле преамбулы: `[len:1][bytes][0x00]`.
Поле VS_Variant: `[len_имени:1][имя][0x00][тип:1][значение]`
(тип 1=u32, 2/5=u64, 3=строка/4=байты с префиксом длины u32 LE).

## Полный стек рукопожатия (из разбора, см. SPEC-native-transport.md)

```
 1. TCP :4307
 2. Преамбула: клиент 26Б (_VS_TRANSPORT_+нонс), сервер 74Б (+realm+ID сессии)   ← готово
 3. Сервер шлёт сертификат X.509 открыто (range-кодер)                           ← декодируется
 4. Клиент шлёт сессионные ключи конвертом EVP_Seal на pubkey сервера            ← готово (sealKeyExchange, тест)
 5. Два AES-128-ECB контекста на key1/key2 (по направлению) — VSSymmetricCrypt   ← примитив готов
 6. VS-сессия под AES: прикладные сообщения VS_Variant {Method,params}            ← слой готов (vssession), стенд-сверка кадровки
 7. Вход аккаунтом (AUTH/LoginUser) и прикладной протокол (*_SRV)                 ← семантика ясна (мост TrueConfX), сборка/стенд

Готовы кирпичи (кодек, транспорт, крипто-примитивы). Осталась СБОРКА живого
рукопожатия: точная последовательность кадров и упаковка полей v1_buf/v2rnd/sign
в сообщения — её добавлять строго по сверке с реальным обменом на стенде.

### Что подтверждено на живом стенде (24.10.2026)

Живой прогон против tc.t2.ru:4307 проходит НАСКВОЗЬ до приёма ключей:
преамбула ✓ → серверная преамбула (realm tc.t2.ru#vcs) ✓ → сертификат rsa-2048 ✓
→ **EVP_Seal принят сервером** ✓ (соединение остаётся живым ≥10с после seal —
сервер ждёт второе, сессионное сообщение; будь seal неверным, был бы FIN).

ВАЖНАЯ ПОПРАВКА: «рейт-лимит/троттлинг» был ЛОЖНЫМ выводом. Настоящая причина
FIN — неверный 4-байтовый ЗАГОЛОВОК преамбулы (поле после MAGIC). Это НЕ нонс:
сервер его проверяет, случайное значение → мгновенный FIN, правильное
(0x002bef99 для минимальной преамбулы) → принимает. `buildClientPreamble` теперь
эмитит верный заголовок (константа PREAMBLE_HEADER).

### Обмен ключами клиента — конверт EVP_Seal (разобрано и реализовано)

После сертификата клиент шлёт сессионные ключи, запечатанные конвертом
**OpenSSL EVP_Seal** (RSA-PKCS1 + AES-256-CBC) на публичный ключ сервера.
Разобрано по `FUN_100963950`→`FUN_100960fe0` (`EVP_SealInit`), сверено с
захватом (кадр 332Б) до байта. Это НЕ «подписанный RSA(v2rnd)» и НЕ ГОСТ-подпись.

```
 off 0    flen u32 LE = 328
 off 4    type u32 LE = 1
 off 8    rsaLen u32 LE = 256
 off 12   ek[256]  = RSA-PKCS1(pubkey сервера, случайный 32-байтовый AES-256 ключ)
 off 268  IV[16]
 off 284  ct[48]   = AES-256-CBC(эфемерный ключ, IV, inner_blob) + PKCS7
          итого 332Б  ✔ совпало с захватом C332
```

- **Внутри RSA-блока — только случайный эфемерный AES-256 ключ** (его генерит сам
  EVP_SealInit), не v2rnd/v1_buf.
- **«Трейлер» 64Б = IV(16)+ct(48)**, а не подпись. Приёмка — зеркальный `EVP_Open`
  (`FUN_100961170`), проверки подписи рядом нет.
- `inner_blob` (44Б до PKCS7): `[family u32=1][ks u32=0x10][key1:16][ks u32=0x10][key2:16]`
  — два случайных сессионных ключа (по направлению), оба ставятся в
  `VSSymmetricCrypt` (AES-128-ECB). Генерация ключей — `RAND_bytes`.

Реализовано и проверено: `vscrypto.sealKeyExchange(pubKeyСервера)` → `{frame,key1,key2}`,
`sealKeyExchangeFromCert(certPem)`, `openKeyExchange(privKey,frame)` (для round-trip).
Тест `vscrypto.test.cjs`: seal→open на своей RSA-паре, кадр ровно 332Б, ключи
восстановлены.

### Крипто-стек (подтверждено)

OpenSSL + движок ГОСТ (ГОСТ Р 34.10/34.11-2012 Стрибог, ГОСТ 28147-89 `gost89`).
Шифр конверта — AES-256-CBC (NID 427); сессионный — AES-128-ECB (NID 418,
совпадает со спекой). Семейство шифра согласуется (`family`: 1=AES, 0xc=ГОСТ).
Прямого `EVP_PKEY_encrypt` в коде нет — RSA делается внутри `EVP_SealInit`.
Поправка: режим `key=HASH(v1_buf‖v2rnd)` + подпись — это ДРУГОЙ (симметричный)
режим рукопожатия, к живому tc.t2.ru (RSA-режим) не относится.
```

## Что осталось (строго с проверкой на живом стенде, не вслепую)

1. RSA-обмен: взять публичный ключ из полученного сертификата, зашифровать v2rnd.
2. Вывод ключа `HASH(v1_buf‖v2rnd)` и `VS_SymmetricCrypt` (OpenSSL AES-128-ECB/ГОСТ).
3. Вход аккаунтом поверх шифрованного транспорта (есть `account.cid/session/key`).
4. Применение:
   - докачка вложений отправителя: команда `TrackerAnnounce` → `PeersListParam` →
     готовый MSE+BitTorrent качатель (`p2p.cjs`);
   - P2P-звонки «пользователь → пользователь».

Каждый шаг добавлять только после сверки с реальным обменом (корп-VPN + свой аккаунт).

### Сессионный и прикладной слой (`vssession.cjs`)

После обмена ключами прикладное сообщение = контейнер VS_Variant
`{Method: <строка>, <параметры>}` → range-код → AES-128-ECB (сессионный ключ) →
кадр. Два ключа (key1/key2 из EVP_Seal) — по направлению. Семантика сообщений
совпадает с мостом TrueConfX (`src/tc/*`): отличается только сериализация
(VS_Variant вместо JSON) и транспорт (AES-4307 вместо websocket).

Пример входа (поля как в `client.ts` loginUser): `Method=LoginUser`,
`Login`, `Password`(credentials), `credentialsType`, `AppID`, `chatV2Enabled`…
Ответ `LoginResponse` с `result`, `CID`, `Session`, `Key`.

`VSSession(keyTx,keyRx).encodeBody(fields)` / `.decodeBody(body)` +
`appMessage(method, params)`. Тест `vssession.test.cjs`: round-trip прикладного
сообщения в обе стороны (клиент↔зеркало-сервер).

### Кадровка сессии — вскрыта декомпиляцией (24.10.2026)

Разобраны методы шифра и транспорта в бинаре 8.3.2:

- **`VS_SymmetricCrypt::encrypt` @0x100966910 / `decrypt` @0x1009669f0** —
  `EVP_EncryptUpdate`+`EVP_EncryptFinal` на ECB-контексте (enc@+0x18, dec@+0x20).
  Расчёт выходного буфера `(len/bs + 1)*bs` всегда добавляет целый блок ⇒
  **PKCS7 включён** (не ручной zero-pad!). `set_padding(0)` нигде нет.
- **Обёртки `VS_TransportSession` @0x100159870 (enc) / @0x1009599b0,0x100159920
  (dec)** шифруют/дешифруют буфер НА МЕСТЕ и возвращают новую длину — своей
  кадровки НЕ добавляют (виртуальные, слоты vtable 0x107cab730…).
- `setCipher` подтверждает: AES → **variant 2**, ГОСТ(0xc) → variant 4 (из
  `ServerProcPacket`/seal-строителя). `setKey`: один ключ на enc- и dec-контекст,
  IV=NULL (ECB).

ВЕРДИКТ (трасса пути отправки до сокета, FUN_1001c9e70 + encrypt-in-place):
```
wire_session = AES-128-ECB-PKCS7( VS_FixedPartMessage )
```
Открытый текст сессии — это конверт **VS_FixedPartMessage**, а НЕ `[flen][dsize][coded]`
(это формат ХЭНДШЕЙК-кадров). Конверт range-кодом НЕ сжимается (кодер зовётся
только внутри сериализатора VS_Variant), внешней `[flen]`-кадровки нет — длину
несёт сам заголовок конверта. Шифруется весь конверт целиком.

Раскладка конверта (FUN_1001c9e70):
```
 off 0   byte  0x81 | (flags&3)<<6          (flags=1 → 0xC1)
 off 2   u16   длина заголовка (смещение payload)
 off 5..7      payloadLen-1 (24 бита LE)
 off 8   u32   id
 off 0xc u32   timeout/seq
 off 0x10      9 pascal-строк [len:1][bytes][0x00]:
               from, connId, "54"(тег), "", service, "", to, "", extra
 off hdrLen    payload = [dsize:u32][range-coded VS_Variant контейнер]
```
Приёмник: ECB-расшифровка блока 0 → читает hdrLen@2 и payloadLen@5..7 → total =
hdrLen+payloadLen → снимает PKCS7.

`vssession`: `buildFixedPartMessage(payload, {service,from,connId,to,id,timeout})`,
`encodeBody(fields, opts) = AES-PKCS7(конверт(serialize(fields)))`, `decodeBody`
зеркально → `{service, from, connId, to, fields}`. Все 4 теста зелёные.

LIVE-PENDING (финальная байт-сверка на стенде, где key1/key2 генерю я сам, ответ
сервера РАСШИФРУЕМ): (а) значения runtime-полей заголовка (id@8, from, connId);
(б) какой из key1/key2 — на tx (клиент→сервер). Из захвата не взять (client-seal
на pubkey сервера, приватного ключа нет → C528 не расшифровать). Нужен живой заход
(собрать конверт → зашифровать → отправить → расшифровать ответ своим ключом).

### Прикладной слой — вскрыт декомпиляцией (24.10.2026)

Сообщение строится как контейнер VS_Variant и шлётся на ИМЕНОВАННЫЙ сервис:
`FUN_100224ed0(mgr, container, service, …, timeout)` → сериализует контейнер
(`FUN_100955e80` → `[dsize][coded]`) → конверт `VS_FixedPartMessage`
(`FUN_1001c8240`→`FUN_1001c9e70`) → очередь отправки `(*(mgr+0x18)+0x48)` у
`VSZTransport`; затем конверт шифруется сессионным AES (см. ВЕРДИКТ выше).

Поле VS_Variant пишет `FUN_100954950(cont, name, namelen, type, value, vlen)`
(совпадает с `vsvariant`: type 1=u32, 3=строка, 4=байты).

13 сервисов (константа = имя на проводе): `AUTH`, `CLIENT`, `ABOOK`, `CHAT`,
`CHATV2`, `CONFERENCE`, `NET_CONFIG`(configuration), `DS_CONTROL`, `LOG`,
`PRESENCE`, `Time`, `TORRENT`, `VAD_CONTROL`. Поля маршрутизации в протоколе:
`Method`, `From`, `To`, `Services`, `SeqID`.

Конверт `VS_FixedPartMessage` — раскладка вынесена выше (раздел «Кадровка сессии»,
ВЕРДИКТ). Реализован в `vssession.buildFixedPartMessage`.

**Вход `LoginUser`** (строитель `FUN_100315280`, поля сверены с длинами в коде):
сервис `AUTH`, контейнер:
```
 Method            (3) = "LoginUser"
 clientChatVersion (3)   если ещё не задан
 chatCapabilities  (3)
 Login             (3)
 Password          (3)   ПАРОЛЬ         ┐ взаимоисключающе:
 Key               (3)   ТОКЕН(=cred.3) ┘ пароль→Password+Key="", токен→только Key
 UserDefaultDomain (3)   опц.
 Hash              (4)   опц.
 ClientType        (1=u32)
 AppName           (3)
```
Тип auth (из моста): JWT 0 / RAW 2 / TOKEN 3 / MD5 4. Для `GetAppProps`
(сервис `NET_CONFIG`) поля: `Method`,`ClientVersion`,`SeqID`(u32),`Name`; ответ
несёт `server_protocol_version`,`chatVersion`,`call_history_as_one_list`,`SeqID`.

### Живой тест сессии (24.10.2026) — хэндшейк ✓, сессионное сообщение пока не принято

Прогон против tc.t2.ru:4307 (`~/Documents/TrueConf-RE/cap/live_session.cjs`,
`login_probe.cjs`): преамбула → cert → **EVP_Seal проходит** (сервер жив, не FIN).
Затем шлю сессионное сообщение конвертом `VS_FixedPartMessage` + AES-PKCS7:
- `GetAppProps`→NET_CONFIG и `LoginUser`→AUTH (с заведомо чужим логином);
- tx=key1 И tx=key2 (оба направления);
- → во ВСЕХ случаях сервер МОЛЧИТ и держит соединение живым (не отвечает, не рвёт).

Вывод: направление ключей и метод/сервис — НЕ причина (перебрал). Сервер получает
пакет, но не отвечает → остаётся одно из: (а) тонкая ошибка в байтах конверта
(поле `id@8`, флаги, или что-то, что сервер молча отвергает); (б) не хватает
обязательного поля контейнера (напр. `appId`/точный `ClientType`); (в) нужен ИМЕННО
тот первый пакет, что шлёт реальный клиент (C528, 528Б — крупнее моего). Отладка
вслепую без серверной стороны малоэффективна.

СЛЕДУЮЩИЙ грунтованный шаг (офлайн): разобрать ПРИЁМНЫЙ парсер сессионного пакета
(декодит `VS_FixedPartMessage`: читает byte0/hdrLen/строки/payload) — он byte-точно
подтвердит/опровергнет мою раскладку конверта и покажет, какие поля обязательны.
Приёмник и отправитель — виртуальные (vtable-диспетчеризация), статически не
добиты; зайти через observe на живом рантайме или через точки, где зовётся
decrypt-in-place (@0x1009599b0/@0x100159920).

---

## Сессия 2 (24.10.2026) — прозрачный релей + полная байтовая сверка

### Прорыв метода: прозрачный байт-релей
MITM упирался в проверку сертификата. Решение — **прозрачный релей** (не MITM):
`~/Documents/TrueConf-RE/cap/relay.cjs` слушает 127.0.0.1:4307, перегоняет байты
на реальный 193.138.148.39:4307. Клиент видит НАСТОЯЩИЙ серт → валидация проходит,
вход реально происходит. Редирект — через `/etc/hosts` (`127.0.0.1 tc.t2.ru`); ни
`ServerAddress`, ни hosts-кэш в serverlist.sqlite НЕ держат (клиент резолвит DNS
заново и переписывает ServerAddress). Захват — `cap/relaycap/connN.{c2s,s2c}.bin`.

### Что ПОДТВЕРЖДЕНО вживую захватом реального клиента (conn2)
- Клиент сперва пробует **TLS** (ClientHello `16 03 01…`), сервер закрывает →
  фолбэк на нативный `_VS_TRANSPORT_`.
- **Преамбула клиента байт-в-байт равна `buildClientPreamble()`**
  (`5f56535f5452414e53504f52545f000099ef2b00000000000001`).
- Серверный хэндшейк = ТОЛЬКО кадр сертификата (3 поля: `Certificate Chain`,
  `Parent Certificate`, `Certificate`). **Нет v1_buf/v2rnd** (это другой путь —
  FUN_100965490/FUN_100964580, здесь не задействован).
- Три серта: `Certificate`=лист сервера **CN=tc.t2.ru#vcs** (на него и делаем
  seal), `Certificate Chain`/`Parent Certificate`=промежуточный reg.trueconf.com#regs.
- **Seal реального клиента = 332Б, ekLen=256 (RSA-2048), ctLen=48 → ks=16 →
  family=1 (AES-128)** — ровно как у меня.

### Крипто-стек — ПОЛНОСТЬЮ грунтован по декомпилятору (байт-точно)
- Кадр seal (FUN_100963950): `[flen=ekLen+ctLen+0x18][type=1][rsaLen=ekLen][ek][IV:16][ct]`.
- inner-blob (FUN_100963950 стр.182-188): `[family u32][ks u32][key1 ks][ks u32][key2 ks]`.
- Шифр конверта seal = EVP_Seal, RSA-PKCS1 + **AES-256-CBC** (family 0xb v3,
  nid 427, прочитал структуру EVP_CIPHER по &DAT_107d6fc88).
- Сессия: setCipher(FUN_1009664a0) family=1 v2 → **AES-128-ECB** (nid 418, iv=0,
  &DAT_107d6f398); setKey(FUN_100966750) ставит ключ как есть (IV=NULL), ключ — сырой
  key1/key2 из blob (не деривируется); encrypt(FUN_100966910) **PKCS7**.
- Сессионный пакет на проводе = сырой AES-ECB(конверт), БЕЗ рамки/длины
  (самоописывается заголовком конверта). FUN_100159870 шифрует конверт как есть.

### Конверт VS_FixedPartMessage — ПОЛНОСТЬЮ грунтован
- Строитель FUN_1001c9e70: byte0=`0x81|(flags&3)<<6`, **bytes5-7=payloadLen-1**,
  bytes2-3=hdrLen, id@8, timeout@0xc, 9 pascal-строк `[len][data][0x00]`,
  затем payload@hdrLen, затем суммы.
- **Payload = `[dsize:u32][range-coded]`** (FUN_100955e80 пишет dsize первым) — мой
  `vv.serialize` верен.
- Обе суммы (FUN_1001c8570) сверены скалярно с моим `finalizeChecksums`:
  cs1→byte4 (off=hdrLen шаг16 пока ≤payloadLen-1, seed 0xee; если payloadLen-1<hdrLen
  → byte4=0xee), cs2→byte1 (off 2..hdrLen, seed `(byte0&0xdf)+0xac`, timeout обнулён).
- **Реальный порядок 9 строк** (FUN_100224ed0→FUN_1001c8240): `[connId-ish(uVar8),
  from(mgr+0x10), "54", "", service, "", to, "", extra]`. Для логина to/extra пусты.
  (У меня в builder pos0=from,pos1=connId — семантика сдвинута, но на пустых значениях
  байты те же; перебор пустых/sessionId не разблокировал.)
- Сервис логина = **"AUTH"** (не "AUTH_SRV"); имена полей сверены по длинам.

### Логин — грунтован (FUN_100315280 + лог клиента)
- Поля: `Method=LoginUser, [clientChatVersion], chatCapabilities, Login,
  {Key(токен) | Password+Key=""}, [UserDefaultDomain], [Hash], ClientType(u32), AppName`.
  **Нет поля credentialsType** (ветка по внутреннему типу).
- **`Hash` = AppEndpId** (FUN_1002a46c0): самоназначаемый ID эндпоинта
  (hwid+appname, иначе случайный `%x%x%x` из time/rand/pid) — НЕ auth-ответ, любой.
- Реальный вход — **токеном** (тип 2, автологин по cookie): из лога
  `LOGIN: <login>/<cid> <token> <AppEndpId> 2`; токен хранится в
  settings.sqlite `logins` и `SetCookie`.
- `TrSession ver 2`→(после входа)`ver 3`. Проверка `Check login declined by trs
  version (3/2)` (FUN_1003456f0) — КЛИЕНТ сверяет версию в ОТВЕТЕ сервера, не то, что шлём.

### Блокер (НЕ вскрыт): сервер молча роняет первый сессионный пакет
Перебрано вживую (все молчат): пароль-логин (валидный пароль) и токен-логин, оба
tx-ключа, pos0/pos1 ∈ {пусто, sessionId, login}, id ∈ {0,1}, с Hash и без,
транспортный HELLO (`HELLO VERSION MIN=3.0 MAX=3.0\n`) шифрованный и плейнтекстом
(HELLO — похоже UDP-концепт: рядом строки "udp test get invalid hello hdr").
Всё крипто/конверт/поля выверены байт-в-байт, но ответа нет и соединение не рвётся.
Причину НЕ вскрыть доступными методами: расшифровать реальную сессию нельзя (ключи
запечатаны RSA на сервер, приватного ключа нет); подцепить hardened+sandbox клиент
нельзя (lldb/frida — flags=0x10000 runtime, нет get-task-allow); сервер не даёт
обратной связи.

### Варианты продолжения (нужна новая возможность)
1. Снять **wss-JSON веб-клиента** (тот же логический протокол, читаемые имена/порядок
   методов) через mitmproxy на 443 — покажет точную последовательность первых сообщений.
2. Хук клиента при отключённом SIP (или не-hardened сборка) → снять сессионные ключи
   из памяти или brkpt на encrypt(FUN_100966910) → plaintext первого пакета.
3. Добить vtable-диспетчеризацию приёмного парсера сессии на живом рантайме (observe).

### Скрипты (cap/)
`relay.cjs` (прозрачный релей), `dump_handshake.cjs` (поля серверного хэндшейка),
`decode_capture.cjs` (декод plaintext-кадров захвата), `env_test.cjs`/`final_login.cjs`
/`hello_test.cjs` (перебор раскладок/логина/HELLO вживую). Декомпилят — `../TrueConf-RE/decomp/`.

## РЕШЕНО (25.10.2026): блокер снят, вход работает end-to-end

Сервер молчал из-за **бага сериализатора VS_Variant**: строки типа 3 на проводе
завершаются нулём, и u32-длина включает этот ноль (пустая `""` → len=1, один
`0x00`; типы 1 и 4 — без нуля). `serialize()` писал длину без нуля → каждая строка
на 1 байт короче → сервер молча ронял пакет. Исправлено: `serialize` добавляет
`0x00` (len+1), `parseContainer` его снимает (симметрично).

Доказательство (хук официального клиента, lldb на `VS_SymmetricCrypt::encrypt`,
копия переподписана ad-hoc с get-task-allow): собранные с нуля `CheckUserLoginStatus`
и `LoginUser` стали **байт-в-байт** равны захваченному plaintext оф. клиента.

**Последовательность входа** (grounded): `CheckUserLoginStatus`→AUTH (id=2, триггер
серверного Check) → сервер отвечает (Result=2) → `LoginUser`→AUTH (id=5) → сервер
`UserLoggedin Result=0` + полный аккаунт и Session-токен. **tx=key1**, rx=key2.
NET_CONFIG (UpdateConfiguration/GetAppProps) можно пропустить.

**Поля LoginUser:** Method, clientChatVersion="3", chatCapabilities=JSON(7),
Login="<login>/<cid>", Key=cookie, UserDefaultDomain="", Hash=<32hex AppEndpId>,
ClientType=тип1 u32 **0**, AppName="TrueConf OS X".
Конверт: from=service="AUTH", connId=sessionId(или AppEndpId). Коды Result: 2=ждёт, 0=успех, 4=ошибка.

**Формула `Hash` (`AppEndpId`, вскрыта по `FUN_1002a46c0` → `FUN_100355e50` @ `0x100355e50`):**
В `settings.sqlite` (таблица `logins`: `Domain, Login, Key`) `Hash` не хранится — клиент вычисляет его детерминированно при старте:
- `h1 = MD5_UPPER(IOPlatformSerialNumber + IOPlatformUUID)` (`0x101507920`)
- `h2 = MD5_UPPER(NSUserName)` (`0x1015078a0`)
- `h3 = ""` (пустая строка)
- `h4 = MD5_UPPER("TrueConf OS X")`
- `Hash = MD5_UPPER(h1 + h2 + h3 + h4)` (на маке стенда совпало байт-в-байт с логом официального клиента).

**Потоковая кадровка входящих конвертов (`SessionReader`):**
Каждый конверт `VS_FixedPartMessage` длиной `plainLen = hdrLen + payloadLen` шифруется отдельным вызовом `VS_SymmetricCrypt::encrypt` (@0x100966910) с PKCS7, поэтому на проводе занимает `wireLen = (Math.floor(plainLen / 16) + 1) * 16` байт. Приёмник чистит блок 0 ECB, читает `hdrLen@2` и `payloadLen@5..7`, дожидается `wireLen` байт в TCP-буфере и штатно снимает PKCS7.

**После входа (раскодировано из `cap/tc_hook_out.txt`, пакеты #5..#18):**
- `NET_CONFIG`: `UpdateConfiguration {IPConfig}`, `GetAppProps {ClientVersion:"8.3.2.154", Name:"TrueConf OS X"}`, `SetProps {Hash, Name, Property, ...}`
- `PRESENCE`: `UpdateStatus {UserPresStatus: u32(1), [ExtSt: вложенный VS_Variant контейнер]}`, `Subscribe {Cause: u32(1), CallId, CallId, ...}` (`from="ABOOK"`)
- `ABOOK`: `SearchAddressBook {Query:"", Hash:u32, AddressBook:u32(15|19|1|2), CallId, E-Mail, Name}`
- `Time`: `GetCurrentTime {Seq: u64(type=5)}` (`from="CHATV2"`).

**Сервис `TORRENT` и `TrackerAnnounce` (вскрыто по `FUN_102c1ee70` / `FUN_102c1ff60` и проверено на живом `tc.t2.ru:4307`):**
- Конверт `VS_FixedPartMessage`: `from="TORRENT"`, `service="TORRENT"`, `to=""`, `extra="<host>#vcs"` (из параметра `&tctr=` magnet-ссылки или `tc_trackers` в `SetProps`, например `"tc.t2.ru#vcs"`, `"tc3.t2.ru#vcs"`).
- Поля исходящего запроса (`FUN_102c1ee70`, строго по порядку):
  1. `Method` (тип 3) = `"TrackerAnnounce"`
  2. `TorrentInfoHash` (тип 3) = 40-символьный **lowercase** hex (`FUN_102c83a60`)
  3. `TorrentPeerId` (тип 3) = 20-байтовый ASCII `peer_id` (`-LT1270-` + 12 hex символов; обязательно тот же самый `peer_id`, который затем шлётся в BitTorrent handshake внутри MSE!)
  4. `TorrentPeerEndpoints` (тип 3) = список своих `ip:port;` через точку с запятой (`"192.168.1.114:55111;"`)
  5. `AnnounceEvent` (тип 1 `u32`) = `1` (`started`), `2` (`completed`), `3` (`stopped`), `4` (`none`)
  6. `AnnounceRequestId` (тип 5 `u64`) = `BigInt` ID запроса.
- Поля ответа сервера (`FUN_102c1ff60`):
  - `Method` = `"TrackerAnnounce"`
  - `TorrentInfoHash` = 40-символьный hex
  - `AnnounceInterval` (тип 5 `u64`) = интервал в секундах (`60n`)
  - `PeersListParam` (тип 3) = строка пиров `"ip:port;ip:port;..."`
  - `BCPeersListParam` (тип 3) = строка BC-пиров
  - `AnnounceRequestId` (тип 5 `u64`)
  - `NotificationReason` (тип 1 `u32`).
- Встроено в `vssession.cjs` (`buildTrackerAnnounceMessage`, `parseTrackerAnnounceResponse`, `trackerAnnounce`, `ensureNativeSession`), `p2p.cjs` (`peersFromTracker` через нативный `TrackerAnnounce` + единый 20-байтовый `peerId` в `download`) и `main.cjs` / `preload.cjs`.

Пробники (в `../TrueConf-RE/cap/`): `tc_fresh_real.cjs` (сборка с нуля, Result=0),
`tc_replay.cjs` (реплей), `tc_hook.py`+`tc_hook_out.txt` (хук+захват).
