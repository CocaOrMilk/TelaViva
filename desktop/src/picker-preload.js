'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('picker', {
  onSources: (cb) => ipcRenderer.on('picker:sources', (_e, sources) => cb(sources)),
  choose: (id) => ipcRenderer.send('picker:choose', id),
  saveUrl: (value) => ipcRenderer.send('url:save', value)
});
