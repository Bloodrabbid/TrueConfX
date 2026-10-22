// Главный процесс: окно, обход CORS к серверу TrueConf, доступ к камере и экрану.
const { app, BrowserWindow, session, desktopCapturer, shell, Notification, ipcMain, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

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
  ipcMain.handle('notify', (_e, { title, body, chatId, silent }) => {
    const n = new Notification({ title, body, silent: !!silent })
    // Клик по уведомлению — открываем окно и нужный чат.
    n.on('click', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); if (chatId) win.webContents.send('open-chat', chatId) })
    n.show()
  })
  // Счётчик непрочитанного на значке: в доке macOS и в Linux (Unity), на Windows — в заголовке окна.
  ipcMain.handle('badge', (_e, count) => {
    app.setBadgeCount(count)
    if (process.platform === 'win32' && win) win.setTitle(count ? `(${count}) TrueConfX` : 'TrueConfX')
  })
  // Новое сообщение, пока окно не в фокусе: значок подпрыгивает, окно мигает на панели задач.
  ipcMain.handle('attention', () => {
    if (!win || win.isFocused()) return
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    else win.flashFrame(true)
  })
  // Логин и пароль храним зашифрованными системным хранилищем ключей (Keychain/DPAPI/libsecret).
  const credFile = path.join(app.getPath('userData'), 'credentials.bin')
  ipcMain.handle('save-credentials', (_e, server, login, password) => {
    if (!login) { fs.rmSync(credFile, { force: true }); return }
    if (!safeStorage.isEncryptionAvailable()) return
    fs.writeFileSync(credFile, safeStorage.encryptString(JSON.stringify({ server, login, password })))
  })
  ipcMain.handle('load-credentials', () => {
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(credFile))) } catch { return null }
  })
  ipcMain.handle('take-link', () => { const l = pendingLink; pendingLink = undefined; return l })
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
