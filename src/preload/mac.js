'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gcm', {
  state: () => ipcRenderer.invoke('gcm:state'),
  refresh: () => ipcRenderer.invoke('gcm:refresh'),
  open: (target) => ipcRenderer.send('gcm:open', target),
  genv: (args) => ipcRenderer.invoke('gcm:genv', args),
  setRunner: (on) => ipcRenderer.invoke('gcm:runner', on === true),
  onState: (cb) => ipcRenderer.on('gcm:state', (_e, s) => cb(s)),
});
