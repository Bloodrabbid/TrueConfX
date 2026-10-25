'use strict'
// Автообновление TrueConfX напрямую из релизов GitHub (Bloodrabbid/TrueConfX).
// Работает без платного сертификата Apple Developer ID (Squirrel.Mac требует подпись):
// на macOS скачивает .dmg своей архитектуры, тихо монтирует через hdiutil, обновляет
// TrueConfX.app через ditto, снимает карантин xattr и перезапускает приложение.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')

const REPO_API_LATEST = 'https://api.github.com/repos/Bloodrabbid/TrueConfX/releases/latest'

function parseSemver (v) {
  const clean = String(v || '').trim().replace(/^v/i, '').split('-')[0]
  const parts = clean.split('.').map(n => Number(n))
  if (parts.length < 3 || parts.some(n => !Number.isInteger(n) || n < 0)) return null
  return parts.slice(0, 3)
}

// 1 если a > b, -1 если a < b, 0 если равны.
function compareSemver (a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

// Выбрать подходящий установочный файл из списка assets GitHub Release.
function pickReleaseAsset (assets = [], { platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE } = {}) {
  if (!Array.isArray(assets) || !assets.length) return null
  const byName = re => assets.find(a => a && typeof a.name === 'string' && re.test(a.name) && a.browser_download_url)
  if (platform === 'darwin') {
    const macArch = arch === 'arm64' ? 'arm64' : 'x64'
    return byName(new RegExp(`mac-${macArch}\\.dmg$`, 'i')) || byName(/\.dmg$/i) || null
  }
  if (platform === 'win32') {
    return byName(/win-.*\.exe$/i) || byName(/\.exe$/i) || null
  }
  if (platform === 'linux') {
    if (appImage) return byName(/\.AppImage$/i) || byName(/\.deb$/i) || null
    return byName(/\.deb$/i) || byName(/\.AppImage$/i) || null
  }
  return null
}

// Разобрать JSON ответа GitHub Releases API относительно текущей версии.
function parseReleasePayload (releaseJson, currentVersion, envOpts = {}) {
  if (!releaseJson || typeof releaseJson !== 'object') {
    return { available: false, currentVersion, version: currentVersion }
  }
  const latestVersion = String(releaseJson.tag_name || releaseJson.name || '').trim().replace(/^v/i, '')
  const isNewer = compareSemver(latestVersion, currentVersion) > 0
  const asset = pickReleaseAsset(releaseJson.assets || [], envOpts)
  return {
    available: Boolean(isNewer && asset),
    currentVersion,
    version: latestVersion || currentVersion,
    notes: String(releaseJson.body || ''),
    htmlUrl: String(releaseJson.html_url || 'https://github.com/Bloodrabbid/TrueConfX/releases/latest'),
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 } : null
  }
}

// Определить путь к .app-бандлу на macOS по пути исполняемого файла.
function resolveMacAppBundle (exePath = process.execPath, defaultAppPath = '/Applications/TrueConfX.app') {
  const m = String(exePath || '').match(/^(.+\.app)\/Contents\/MacOS\//)
  if (m && !m[1].endsWith('/Electron.app')) return m[1]
  return defaultAppPath
}

async function downloadWithProgress (url, destPath, onProgress) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TrueConfX-Updater' },
    redirect: 'follow'
  })
  if (!res.ok || !res.body) throw new Error(`Ошибка загрузки обновления: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const file = fs.createWriteStream(destPath)
  const reader = res.body.getReader()
  let got = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      got += chunk.length
      if (!file.write(chunk)) await new Promise(r => file.once('drain', r))
      const percent = total > 0 ? Math.min(99, Math.floor((got * 100) / total)) : 0
      onProgress?.({ percent, got, total })
    }
    await new Promise((resolve, reject) => {
      file.end(err => (err ? reject(err) : resolve()))
    })
  } catch (e) {
    try { file.destroy() } catch {}
    try { fs.rmSync(destPath, { force: true }) } catch {}
    throw e
  }
}

// Установить новый .app из .dmg поверх targetAppPath (macOS).
function installMacDmg (dmgPath, targetAppPath) {
  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcx-mnt-'))
  let attached = false
  try {
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-noautoopen', '-mountpoint', mountDir, dmgPath], { stdio: 'ignore' })
    attached = true
    const entries = fs.readdirSync(mountDir)
    const appName = entries.find(e => e.endsWith('.app'))
    if (!appName) throw new Error('В образе DMG не найден бандл .app')
    const srcApp = path.join(mountDir, appName)
    execFileSync('/usr/bin/ditto', [srcApp, targetAppPath])
    try {
      execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetAppPath], { stdio: 'ignore' })
    } catch {}
  } finally {
    if (attached) {
      try { execFileSync('/usr/bin/hdiutil', ['detach', mountDir, '-force'], { stdio: 'ignore' }) } catch {}
    }
    try { fs.rmSync(mountDir, { recursive: true, force: true }) } catch {}
  }
}

function createUpdater ({ currentVersion, onStateChange, relaunchAndExit } = {}) {
  let state = {
    state: 'idle',
    currentVersion,
    version: currentVersion,
    percent: 0,
    htmlUrl: 'https://github.com/Bloodrabbid/TrueConfX/releases/latest',
    asset: null,
    error: undefined
  }

  const updateState = patch => {
    state = { ...state, ...patch }
    onStateChange?.(state)
    return state
  }

  async function check () {
    if (state.state === 'downloading' || state.state === 'installing') return state
    updateState({ state: 'checking', error: undefined })
    try {
      const res = await fetch(REPO_API_LATEST, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'TrueConfX-Updater'
        },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) throw new Error(`GitHub API ответил HTTP ${res.status}`)
      const json = await res.json()
      const parsed = parseReleasePayload(json, currentVersion)
      if (parsed.available) {
        return updateState({
          state: 'available',
          version: parsed.version,
          notes: parsed.notes,
          htmlUrl: parsed.htmlUrl,
          asset: parsed.asset,
          percent: 0,
          error: undefined
        })
      }
      return updateState({
        state: 'up-to-date',
        version: parsed.version || currentVersion,
        htmlUrl: parsed.htmlUrl,
        asset: null,
        percent: 0,
        error: undefined
      })
    } catch (e) {
      return updateState({ state: 'error', error: e.message || 'Не удалось проверить обновления' })
    }
  }

  async function install () {
    if (state.state === 'downloading' || state.state === 'installing') return state
    if (!state.asset?.url) {
      const checked = await check()
      if (checked.state !== 'available' || !checked.asset?.url) return checked
    }
    const asset = state.asset
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcx-upd-'))
    const destFile = path.join(tmpDir, asset.name || 'update.bin')
    try {
      updateState({ state: 'downloading', percent: 0, error: undefined })
      await downloadWithProgress(asset.url, destFile, ({ percent }) => {
        if (percent !== state.percent) updateState({ state: 'downloading', percent })
      })
      updateState({ state: 'installing', percent: 100 })

      if (process.platform === 'darwin') {
        const targetApp = resolveMacAppBundle(process.execPath)
        installMacDmg(destFile, targetApp)
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
        relaunchAndExit?.(targetApp)
        return state
      }

      if (process.platform === 'win32') {
        spawn(destFile, [], { detached: true, stdio: 'ignore' }).unref()
        relaunchAndExit?.(null)
        return state
      }

      if (process.platform === 'linux' && process.env.APPIMAGE && destFile.endsWith('.AppImage')) {
        fs.chmodSync(destFile, 0o755)
        fs.copyFileSync(destFile, process.env.APPIMAGE)
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
        relaunchAndExit?.(process.env.APPIMAGE)
        return state
      }

      // На Linux без AppImage (.deb) — открываем скачанный пакет/папку
      relaunchAndExit?.(destFile, { showOnly: true })
      return updateState({ state: 'up-to-date' })
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
      return updateState({ state: 'error', error: e.message || 'Ошибка установки обновления' })
    }
  }

  return {
    getState: () => state,
    check,
    install
  }
}

module.exports = {
  parseSemver,
  compareSemver,
  pickReleaseAsset,
  parseReleasePayload,
  resolveMacAppBundle,
  installMacDmg,
  createUpdater
}
