const { contextBridge, ipcRenderer } = require('electron')
// Подписка на событие из main-процесса; возвращает функцию отписки (её вызывает React при размонтировании).
const listen = (channel, cb) => { const h = (_e, v) => cb(v); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h) }
contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  notify: (title, body, opts = {}) => ipcRenderer.invoke('notify', { title, body, ...opts }),
  setBadge: (count, image) => ipcRenderer.invoke('badge', count, image),
  attention: () => ipcRenderer.invoke('attention'),
  onOpenChat: cb => listen('open-chat', cb),
  saveCredentials: (server, login, password) => ipcRenderer.invoke('save-credentials', server, login, password),
  loadCredentials: () => ipcRenderer.invoke('load-credentials'),
  download: (url, name) => ipcRenderer.invoke('download', url, name),
  p2pFetch: (hosts, hash) => ipcRenderer.invoke('p2p-fetch', hosts, hash),
  onP2PProgress: cb => listen('p2p-progress', cb),
  takeLink: () => ipcRenderer.invoke('take-link'),
  onDeepLink: cb => listen('deep-link', cb),
  onPickScreen: cb => listen('pick-screen', cb),
  pickScreen: id => ipcRenderer.send('screen-picked', id),
  nativeConnect: opts => ipcRenderer.invoke('native-connect', opts),
  nativeStatus: () => ipcRenderer.invoke('native-status'),
  onNativeEvent: cb => listen('native-event', cb),
  getUpdateState: () => ipcRenderer.invoke('update-get'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateState: cb => listen('update-state', cb),
})
