'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gcm', {
  state: () => ipcRenderer.invoke('gcm:state'),
  refresh: () => ipcRenderer.invoke('gcm:refresh'),
  open: (target) => ipcRenderer.send('gcm:open', target),
  onState: (cb) => ipcRenderer.on('gcm:state', (_e, s) => cb(s)),
});
