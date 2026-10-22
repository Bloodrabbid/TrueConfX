# TrueConfX

Свой клиент к TrueConf Server. Проверен на TrueConf Server 5.5.5.
Работает на macOS, Windows и Linux: Electron + React + TypeScript.

> Неофициальный проект, с TrueConf LLC не связан. Клиент говорит с сервером
> тем же открытым веб-протоколом (WSS `/websocket/`), что и штатный веб-клиент
> сервера `/webrtc`. Нужна своя учётная запись на сервере TrueConf.

## Как устроено

```
 React UI (src/ui) ──► store.ts (zustand) ──► src/tc/*  ──WSS /websocket/──► TrueConf Server
                                               │                              (тот же протокол,
                                               └─ WebRTC (MCU, 1 PeerConnection)  что у веб-клиента /webrtc)
 electron/main.cjs: CORS-мост, камера/микрофон, выбор экрана, Keychain для пароля, ссылки trueconfx://
```

- `src/tc/socket.ts` — сигнальный WebSocket (кадр = JSON с полем `method`).
- `src/tc/client.ts` — вход `loginUser`, чаты ChatV2, адресная книга, статусы.
- `src/tc/conference.ts` — вход в конференцию, SDP/ICE, микрофон, камера, экран, участники, реакции.
- `src/tc/turn.ts` — расшифровка пароля TURN (AES-GCM + HKDF).
- `docs/PROTOCOL-*.md` — восстановленный протокол со ссылками на код веб-клиента.

## Скачать

Готовые установщики — на странице [Releases](https://github.com/Bloodrabbid/TrueConfX/releases):
`.dmg` (macOS, Apple Silicon и Intel), `.exe` (Windows), `.AppImage` и `.deb` (Linux).

Пакеты не подписаны. На macOS при первом запуске: правый клик по приложению → «Открыть»,
или `xattr -dr com.apple.quarantine /Applications/TrueConfX.app`.
На Windows SmartScreen: «Подробнее» → «Выполнить в любом случае».

## Запуск из исходников

```bash
cd app
npm install
npm run build && npx electron .   # или npm run dev
npm run dist                      # установщик под текущую ОС
```

## Ограничения

- P2P-звонков «пользователь → пользователь» нет в веб-протоколе сервера 5.5.
  Они есть только в закрытом бинарном протоколе нативного клиента (порт 4307).
  Вместо звонка: конференция + `inviteUser`.
- Видео приходит одной сведённой картинкой (сервер — MCU). Подписи плиток рисуются по `layout`.
