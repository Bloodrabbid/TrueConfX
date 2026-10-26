// Главный процесс: окно, обход CORS к серверу TrueConf, доступ к камере и экрану.
const { app, BrowserWindow, session, desktopCapturer, shell, Notification, ipcMain, safeStorage, nativeImage, systemPreferences, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const p2p = require('./p2p.cjs')
const vs = require('./vssession.cjs')
const vscall = require('./vscall.cjs')
const { createUpdater } = require('./updater.cjs')

const DEV_URL = process.env.VITE_DEV_SERVER_URL
// Отладка через Chrome DevTools Protocol: TCX_DEBUG=9229 npx electron .
// Звонок не должен замирать, когда окно перекрыто или свёрнуто.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
// Linux: аппаратное кодирование и декодирование видео через VA-API.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,VaapiVideoDecodeLinuxGL')
if (process.env.TCX_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', process.env.TCX_DEBUG)
let win

// Сервер TrueConf не отдаёт CORS-заголовки для чужого origin.
// Подставляем Origin сервера в запрос и разрешаем ответ для нашего окна.
function installCorsBridge(ses) {
  const filter = { urls: ['https://*/*', 'wss://*/*'] }
  ses.webRequest.onBeforeSendHeaders(filter, (d, cb) => {
    const h = d.requestHeaders
    const target = new URL(d.url)
    if (!target.host.startsWith('localhost')) {
      h['Origin'] = `https://${target.host}`
      h['Referer'] = `https://${target.host}/`
    }
    cb({ requestHeaders: h })
  })
  ses.webRequest.onHeadersReceived(filter, (d, cb) => {
    const h = d.responseHeaders || {}
    for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('access-control-')) delete h[k]
    h['Access-Control-Allow-Origin'] = [DEV_URL ? new URL(DEV_URL).origin : 'null']
    h['Access-Control-Allow-Credentials'] = ['true']
    h['Access-Control-Allow-Headers'] = ['*, Authorization, Content-Type']
    h['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS']
    const status = d.method === 'OPTIONS' ? 'HTTP/1.1 204 No Content' : d.statusLine
    cb({ responseHeaders: h, statusLine: status })
  })
}

// Доступ к камере и микрофону на macOS. Не спрашивали — системный запрос.
// Отказано — предлагаем открыть настройки и сами перезапускаемся, когда доступ включат.
const MEDIA_LABEL = { camera: 'камере', microphone: 'микрофону' }
const MEDIA_PANE = { camera: 'Privacy_Camera', microphone: 'Privacy_Microphone' }
let mediaWatch
// Последний список STUN/TURN из SetTurnConfiguration.
let lastIceServers = []
async function ensureMediaAccess () {
  if (process.platform !== 'darwin') return { camera: true, microphone: true }
  const res = {}
  for (const kind of ['microphone', 'camera']) {
    const st = systemPreferences.getMediaAccessStatus(kind)
    if (st === 'granted') { res[kind] = true; continue }
    if (st === 'not-determined') { res[kind] = await systemPreferences.askForMediaAccess(kind); continue }
    res[kind] = false
    if (mediaWatch) continue
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Открыть настройки', 'Позже'], defaultId: 0, cancelId: 1,
      message: `Нет доступа к ${MEDIA_LABEL[kind]}`,
      detail: 'Включите приложение в «Конфиденциальность и безопасность». Как только доступ появится, приложение перезапустится само.'
    })
    if (r.response !== 0) continue
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${MEDIA_PANE[kind]}`)
    mediaWatch = setInterval(() => {
      if (['microphone', 'camera'].every(k => systemPreferences.getMediaAccessStatus(k) === 'granted')) {
        clearInterval(mediaWatch); app.relaunch(); app.exit(0)
      }
    }, 1500)
  }
  return res
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(__dirname, '../build/icon.png'),
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1115',
    // backgroundThrottling: false — свёрнутое окно не тормозит звонок (таймеры, видео, статистика).
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, backgroundThrottling: false },
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '../dist/index.html'))
  win.on('focus', () => win.flashFrame(false))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

// Ссылки trueconf:// открывают наше приложение.
app.setAsDefaultProtocolClient('trueconfx')
let pendingLink = process.argv.find(a => a.startsWith('trueconf'))
app.on('open-url', (e, url) => { e.preventDefault(); pendingLink = url; win?.webContents.send('deep-link', url) })

app.whenReady().then(() => {
  // В dev-режиме у Electron своя иконка в доке — подменяем на нашу.
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, '../build/icon.png'))
  const ses = session.defaultSession
  installCorsBridge(ses)
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)))
  // Демонстрация экрана: отдаём список источников в окно, окно выбирает.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } })
    const list = sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }))
    const chosen = await new Promise(res => { ipcMain.once('screen-picked', (_e, id) => res(id)); win.webContents.send('pick-screen', list) })
    const src = sources.find(s => s.id === chosen)
    cb(src ? { video: src, audio: process.platform === 'win32' ? 'loopback' : undefined } : {})
  })
  // Скачивание вложений в «Загрузки» без диалога; по окончании показываем файл в Finder.
  ipcMain.handle('download', (_e, url, name) => {
    win.webContents.session.once('will-download', (_ev, item) => {
      const base = path.join(app.getPath('downloads'), name || item.getFilename())
      let target = base, n = 1
      while (fs.existsSync(target)) target = base.replace(/(\.[^.]*)?$/, ` (${n++})$1`)
      item.setSavePath(target)
      item.once('done', (_d, state) => {
        if (state === 'completed') { new Notification({ title: 'Файл скачан', body: path.basename(target) }).show(); shell.showItemInFolder(target) }
      })
    })
    win.webContents.downloadURL(url)
  })
  // Файл, который лежит у отправителя: качаем сами по порту 4307 (см. p2p.cjs).
  // Один файл — одна активная загрузка: опрос вложения каждые 5с не должен плодить
  // параллельные скачивания одного и того же (иначе сид захлёбывается и загрузка срывается).
  const p2pInflight = new Map()
  ipcMain.handle('p2p-fetch', (e, hosts, hash) => {
    if (p2pInflight.has(hash)) return p2pInflight.get(hash)
    const task = p2p.fetchFile(hosts, hash, (got, total) => e.sender.send('p2p-progress', { hash, got, total }))
      .then(data => ({ ok: true, data }), err => ({ ok: false, error: err.message }))
      .finally(() => p2pInflight.delete(hash))
    p2pInflight.set(hash, task)
    return task
  })
  ipcMain.handle('notify', (_e, { title, body, chatId, silent }) => {
    const n = new Notification({ title, body, silent: !!silent })
    // Клик по уведомлению — открываем окно и нужный чат.
    n.on('click', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); if (chatId) win.webContents.send('open-chat', chatId) })
    n.show()
  })
  // Счётчик непрочитанного на значке: в доке macOS и в Linux (Unity), на Windows — в заголовке окна.
  // На Windows системного счётчика нет: кружок с числом рисует окно и кладём его поверх значка на панели задач.
  ipcMain.handle('badge', (_e, count, image) => {
    app.setBadgeCount(count)
    if (process.platform === 'win32' && win) {
      win.setTitle(count ? `(${count}) TrueConfX` : 'TrueConfX')
      win.setOverlayIcon(count && image ? nativeImage.createFromDataURL(image) : null, count ? `Непрочитанных: ${count}` : '')
    }
  })
  // Новое сообщение, пока окно не в фокусе: значок подпрыгивает, окно мигает на панели задач.
  ipcMain.handle('attention', () => {
    if (!win || win.isFocused()) return
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    else win.flashFrame(true)
  })
  // Логин и пароль храним зашифрованными системным хранилищем ключей (Keychain/DPAPI/libsecret).
  const credFile = path.join(app.getPath('userData'), 'credentials.bin')
  const readStoredCredentials = () => {
    try {
      if (!fs.existsSync(credFile)) return null
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(credFile)))
    } catch {
      return null
    }
  }
  // reuse: true — для IPC-вызовов: живую сессию не трогаем и сохранённые настройки не перечитываем.
  // Иначе первый же Ringing мог открыть новую сессию с новым экземпляром (журнал 26.10.2026).
  const startBackgroundNativeSession = (opts = {}, { reuse = false } = {}) => {
    const explicit = opts.server || opts.login || opts.password || opts.key
    const eff = explicit ? opts : (reuse && vs.hasNativeSession() ? {} : (readStoredCredentials() || opts))
    if (eff.server || eff.login || eff.password || eff.key) {
      const fallbackHost = eff.login && String(eff.login).includes('@')
        ? String(eff.login).split('@')[1].split('/')[0]
        : ''
      const host = String(eff.server || fallbackHost || '').split(':')[0]
      vs.configureNativeSession({
        host: host || undefined,
        login: eff.login ? (eff.login.includes('@') || !host ? eff.login : `${eff.login}@${host}`) : undefined,
        cid: eff.cid,
        key: eff.key,
        password: eff.password,
        forcePassword: eff.forcePassword
      })
    }
    return vs.ensureNativeSession().then(conn => {
      if (!conn._tcxBound) {
        conn._tcxBound = true
        wireLog('SES', { service: 'SESSION', to: conn.account && conn.account.UserName, data: { reason: vs.getLastSessionReason(), explicit: !!explicit, reuse } })
        // Журнал нативной сессии (обе стороны) для разбора звонков: ~/Library/Logs/TrueConfX/native-wire.jsonl
        const origSend = conn.sendApp.bind(conn)
        conn.sendApp = (fields, opts) => { wireLog('TX', { service: opts && opts.service, to: opts && opts.to, data: vs.fieldsToObject(fields) }); return origSend(fields, opts) }
        conn.onMessage(m => {
          wireLog('RX', { service: m.service, from: m.from, to: m.to, data: m.data })
          win?.webContents.send('native-event', {
            id: m.id,
            from: m.from,
            service: m.service,
            to: m.to,
            extra: m.extra,
            data: m.data
          })
          // Сигналинг звонка — отдельным разобранным каналом для renderer.
          try {
            const call = vscall.parseIncoming(m)
            if (call) win?.webContents.send('call-event', call)
            if (m.data && (m.data.TurnConfiguration || m.data.IceConfiguration || m.data.iceConfiguration)) {
              const ice = vscall.parseIceConfiguration(m.data)
              if (ice.length) { lastIceServers = ice; win?.webContents.send('call-ice-servers', ice) }
            }
          } catch {}
        })
        try { conn.updateStatus(1) } catch {}
        // Как оф. клиент после входа: запрос свойств у NET_CONFIG. Проверяем, пришлёт ли сервер
        // за ним SetTurnConfiguration (без TURN медиа между домашней сетью и сетью t2 не сходится).
        try { conn.updateConfiguration() } catch {}
        try { conn.getAppProps().catch(() => {}) } catch {}
      }
      return conn
    }).catch(() => null)
  }

  ipcMain.handle('save-credentials', (_e, server, login, password) => {
    if (!login) { fs.rmSync(credFile, { force: true }); return }
    startBackgroundNativeSession({ server, login, password })
    if (!safeStorage.isEncryptionAvailable()) return
    fs.writeFileSync(credFile, safeStorage.encryptString(JSON.stringify({ server, login, password })))
  })
  ipcMain.handle('load-credentials', () => {
    const creds = readStoredCredentials()
    startBackgroundNativeSession(creds || {})
    return creds
  })
  ipcMain.handle('native-connect', async (_e, opts = {}) => {
    const conn = await startBackgroundNativeSession(opts)
    if (!conn) return { ok: false }
    return { ok: true, realm: conn.realm, sessionId: conn.sessionId, account: conn.account }
  })
  ipcMain.handle('ensure-media-access', () => ensureMediaAccess())
  // SetTurnConfiguration приходит сразу после входа — раньше, чем renderer создаёт звонок; отдаём сохранённый.
  ipcMain.handle('get-ice-servers', () => lastIceServers)
  // Диагностика звонка из renderer (состояния RTCPeerConnection, ошибки) — в тот же журнал.
  ipcMain.on('call-log', (_e, data) => wireLog('PC', { service: 'PC', data }))
  ipcMain.handle('native-status', async () => {
    const conn = await startBackgroundNativeSession({}, { reuse: true })
    return conn ? { connected: conn.isAlive(), realm: conn.realm, sessionId: conn.sessionId, account: conn.account } : { connected: false }
  })
  // Исходящий сигналинг звонка: renderer присылает { kind, args }, main строит
  // сообщение (vscall) и шлёт его по живой нативной сессии.
  ipcMain.handle('native-call', async (_e, kind, args = {}) => {
    const conn = await startBackgroundNativeSession({}, { reuse: true })
    if (!conn || !conn.isAlive()) return { ok: false, error: 'нет нативной сессии' }
    try {
      // SendWebrtcMsg: id = экземпляр ОТПРАВИТЕЛЯ (живой кадр 26.10.2026). Это экземпляр
      // нативной сессии (UserName из ответа LoginUser), а не веб-сессии renderer'а.
      const native = conn.account && conn.account.UserName
      if ((kind === 'sdp' || kind === 'candidate') && native) args = { ...args, id: String(native) }
      // Наш адрес в сигналинге конференции — тоже экземпляр нативной сессии (как UserName у оф. клиента).
      if (['ringing', 'accept', 'reject', 'hangup'].includes(kind) && native) args = { ...args, me: String(native) }
      const { fields, opts } = vscall.build(kind, args)
      conn.sendApp(fields, opts)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) }
    }
  })

  // Автообновление из релизов GitHub (работает без сертификата Apple Developer ID).
  const updater = createUpdater({
    currentVersion: app.getVersion(),
    onStateChange: st => win?.webContents.send('update-state', st),
    relaunchAndExit: (targetPath, opts = {}) => {
      if (opts.showOnly && targetPath) {
        shell.showItemInFolder(targetPath)
        return
      }
      if (process.platform === 'darwin' && targetPath) {
        spawn('/usr/bin/open', ['-n', '-a', targetPath], { detached: true, stdio: 'ignore' }).unref()
        app.exit(0)
        return
      }
      if (targetPath) app.relaunch({ execPath: targetPath })
      else app.relaunch()
      app.exit(0)
    }
  })
  ipcMain.handle('update-get', () => updater.getState())
  ipcMain.handle('update-check', () => updater.check())
  ipcMain.handle('update-install', () => updater.install())
  setTimeout(() => updater.check(), 4000)
  setInterval(() => updater.check(), 30 * 60_000)

  ipcMain.handle('take-link', () => { const l = pendingLink; pendingLink = undefined; return l })
  startBackgroundNativeSession()
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })

// Пишет сообщение нативной сессии в JSONL; секреты маскирует, длинные буферы укорачивает.
const WIRE_SECRET = /^(Key|Password|Hash|Cookie|Credentials|SecureKey|Token|AuthKey)$/i
function wireLog (dir, msg) {
  try {
    const dirPath = path.join(app.getPath('logs'))
    fs.mkdirSync(dirPath, { recursive: true })
    const data = {}
    for (const [k, v] of Object.entries(msg.data || {})) {
      if (WIRE_SECRET.test(k)) data[k] = '<скрыто>'
      else if (/^(TurnConfiguration|IceConfiguration)$/.test(k)) data[k] = String(Buffer.isBuffer(v) ? v.toString('utf8') : v).replace(/("(?:password|credential|username|user|login|pass)"\s*:\s*)"[^"]*"/gi, '$1"<скрыто>"')
      else if (Buffer.isBuffer(v)) data[k] = { bytes: v.length, hex: v.slice(0, 4096).toString('hex') }
      else data[k] = v
    }
    fs.appendFileSync(path.join(dirPath, 'native-wire.jsonl'), JSON.stringify({ t: new Date().toISOString(), dir, ...msg, data }, (_k, v) => typeof v === 'bigint' ? String(v) : v) + '\n')
  } catch {}
}
