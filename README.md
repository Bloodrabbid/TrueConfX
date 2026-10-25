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
 electron/vssession.cjs + p2p.cjs: нативный протокол :4307 (AUTH, TORRENT/TrackerAnnounce, MSE + BitTorrent)
 electron/updater.cjs: автообновление из интерфейса по релизам GitHub (macOS / Windows / Linux)
```

- `src/tc/socket.ts` — сигнальный WebSocket (кадр = JSON с полем `method`).
- `src/tc/client.ts` — вход `loginUser`, чаты ChatV2, адресная книга, статусы.
- `src/tc/conference.ts` — вход в конференцию, SDP/ICE, микрофон, камера, экран, участники, реакции.
- `src/tc/turn.ts` — расшифровка пароля TURN (AES-GCM + HKDF).
- `electron/vstransport.cjs`, `vscrypto.cjs`, `vsvariant.cjs`, `vssession.cjs` — нативный бинарный протокол `:4307` (`_VS_TRANSPORT_`, `EVP_Seal`, `VS_FixedPartMessage`, `AUTH`, `TORRENT/TrackerAnnounce`, см. [`app/electron/NATIVE.md`](app/electron/NATIVE.md)).
- `electron/p2p.cjs` — скачивание вложений и картинок по `:4307` (`TC_FILETRANSFER_____` MSE + BitTorrent + `ut_metadata`).
- `electron/updater.cjs` — проверка новых релизов на GitHub и обновление в один клик прямо из интерфейса.
- `docs/PROTOCOL-*.md` — восстановленный протокол со ссылками на код веб-клиента.

## Скачать

Готовые установщики — на странице [Releases](https://github.com/Bloodrabbid/TrueConfX/releases):
`.dmg` (macOS, Apple Silicon и Intel), `.exe` (Windows), `.AppImage`, `.deb` и `.pkg.tar.zst` для Arch (Linux).

**macOS через Homebrew:**

```sh
brew tap bloodrabbid/trueconfx https://github.com/Bloodrabbid/TrueConfX
brew install --cask trueconfx
```

**Arch Linux:** свой репозиторий pacman в релизах GitHub. Добавьте в `/etc/pacman.conf`:

```ini
[trueconfx]
SigLevel = Optional TrustAll
Server = https://github.com/Bloodrabbid/TrueConfX/releases/latest/download
```

и поставьте пакет — дальше он обновляется обычным `pacman -Syu`:

```sh
sudo pacman -Sy trueconfx-bin
```

Можно и без репозитория: скачать `trueconfx-bin-*.pkg.tar.zst` из релиза и `sudo pacman -U` его.

Или собрать самому по [`packaging/arch/PKGBUILD`](packaging/arch/PKGBUILD): `makepkg -si` в папке с ним.

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
