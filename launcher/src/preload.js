'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function subscribe (channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('launcher', {
  init: () => ipcRenderer.invoke('launcher:init'),
  checkPack: () => ipcRenderer.invoke('pack:check'),
  updatePack: () => ipcRenderer.invoke('pack:update'),
  repairPack: () => ipcRenderer.invoke('pack:repair'),
  launch: () => ipcRenderer.invoke('game:launch'),
  login: () => ipcRenderer.invoke('account:login'),
  logout: () => ipcRenderer.invoke('account:logout'),
  saveSettings: s => ipcRenderer.invoke('settings:save', s),
  open: what => ipcRenderer.invoke('shell:open', what),
  onProgress: cb => subscribe('progress', cb),
  onGameExit: cb => subscribe('game:exit', cb),
  onAccount: cb => subscribe('account', cb)
})
