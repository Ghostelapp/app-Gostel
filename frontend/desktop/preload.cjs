const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ghostelMLSVault', Object.freeze({
  load: user => ipcRenderer.invoke('mls-vault:load', user),
  save: (user, revision, state) => ipcRenderer.invoke('mls-vault:save', user, revision, state),
}));
