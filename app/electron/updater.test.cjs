'use strict'
const assert = require('assert')
const {
  compareSemver,
  pickReleaseAsset,
  parseReleasePayload,
  resolveMacAppBundle
} = require('./updater.cjs')

// 1) Сравнение версий
assert.strictEqual(compareSemver('0.2.10', '0.2.9'), 1, '0.2.10 > 0.2.9')
assert.strictEqual(compareSemver('v0.3.0', '0.2.9'), 1, 'v0.3.0 > 0.2.9')
assert.strictEqual(compareSemver('0.2.9', '0.2.9'), 0, '0.2.9 == 0.2.9')
assert.strictEqual(compareSemver('0.2.8', '0.2.9'), -1, '0.2.8 < 0.2.9')

// 2) Выбор ассета под платформу и архитектуру
const sampleAssets = [
  { name: 'TrueConfX-0.3.0-mac-arm64.dmg', browser_download_url: 'https://example.com/arm64.dmg', size: 100 },
  { name: 'TrueConfX-0.3.0-mac-x64.dmg', browser_download_url: 'https://example.com/x64.dmg', size: 101 },
  { name: 'TrueConfX-0.3.0-win-x64.exe', browser_download_url: 'https://example.com/win.exe', size: 102 },
  { name: 'TrueConfX-0.3.0-linux-x86_64.AppImage', browser_download_url: 'https://example.com/linux.AppImage', size: 103 },
  { name: 'TrueConfX-0.3.0-linux-amd64.deb', browser_download_url: 'https://example.com/linux.deb', size: 104 }
]

assert.strictEqual(
  pickReleaseAsset(sampleAssets, { platform: 'darwin', arch: 'arm64' }).name,
  'TrueConfX-0.3.0-mac-arm64.dmg'
)
assert.strictEqual(
  pickReleaseAsset(sampleAssets, { platform: 'darwin', arch: 'x64' }).name,
  'TrueConfX-0.3.0-mac-x64.dmg'
)
assert.strictEqual(
  pickReleaseAsset(sampleAssets, { platform: 'win32', arch: 'x64' }).name,
  'TrueConfX-0.3.0-win-x64.exe'
)
assert.strictEqual(
  pickReleaseAsset(sampleAssets, { platform: 'linux', arch: 'x64', appImage: '/tmp/TrueConfX.AppImage' }).name,
  'TrueConfX-0.3.0-linux-x86_64.AppImage'
)
assert.strictEqual(
  pickReleaseAsset(sampleAssets, { platform: 'linux', arch: 'x64', appImage: '' }).name,
  'TrueConfX-0.3.0-linux-amd64.deb'
)

// 3) Разбор ответа релиза GitHub
const relNewer = parseReleasePayload(
  { tag_name: 'v0.3.0', body: 'New features', html_url: 'https://github.com/Bloodrabbid/TrueConfX/releases/tag/v0.3.0', assets: sampleAssets },
  '0.2.9',
  { platform: 'darwin', arch: 'arm64' }
)
assert.strictEqual(relNewer.available, true)
assert.strictEqual(relNewer.version, '0.3.0')
assert.strictEqual(relNewer.asset.name, 'TrueConfX-0.3.0-mac-arm64.dmg')

const relSame = parseReleasePayload(
  { tag_name: 'v0.2.9', assets: sampleAssets },
  '0.2.9',
  { platform: 'darwin', arch: 'arm64' }
)
assert.strictEqual(relSame.available, false)

// 4) Определение пути .app бандла на macOS
assert.strictEqual(
  resolveMacAppBundle('/Applications/TrueConfX.app/Contents/MacOS/TrueConfX'),
  '/Applications/TrueConfX.app'
)
assert.strictEqual(
  resolveMacAppBundle('/Users/test/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', '/Applications/TrueConfX.app'),
  '/Applications/TrueConfX.app'
)

console.log('OK: updater — semver, выбор ассета под ОС/архитектуру, парсинг GitHub Release, путь .app бандла')
