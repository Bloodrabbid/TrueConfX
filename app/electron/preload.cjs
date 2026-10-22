const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  saveCredentials: (server, login, password) => ipcRenderer.invoke('save-credentials', server, login, password),
  loadCredentials: () => ipcRenderer.invoke('load-credentials'),
  download: (url, name) => ipcRenderer.invoke('download', url, name),
  takeLink: () => ipcRenderer.invoke('take-link'),
  onDeepLink: cb => ipcRenderer.on('deep-link', (_e, u) => cb(u)),
  onPickScreen: cb => ipcRenderer.on('pick-screen', (_e, list) => cb(list)),
  pickScreen: id => ipcRenderer.send('screen-picked', id),
})
