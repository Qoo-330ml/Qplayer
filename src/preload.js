const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qplayer', {
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  login: (credentials) => ipcRenderer.invoke('emby:login', credentials),
  getHome: () => ipcRenderer.invoke('emby:home'),
  getResume: () => ipcRenderer.invoke('emby:resume'),
  getLatest: (library) => ipcRenderer.invoke('emby:latest', library),
  getLibraries: () => ipcRenderer.invoke('emby:libraries'),
  getItems: (parentId) => ipcRenderer.invoke('emby:items', parentId),
  getItem: (itemId) => ipcRenderer.invoke('emby:item', itemId),
  play: (item) => ipcRenderer.invoke('player:play', item)
});
