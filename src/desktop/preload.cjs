'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only capabilities exposed to the local dashboard. The remote ChatGPT
// sign-in window deliberately has no preload and no IPC bridge.
contextBridge.exposeInMainWorld('chatgptExporter', Object.freeze({
  state: () => ipcRenderer.invoke('app:state'),
  signIn: () => ipcRenderer.invoke('app:sign-in'),
  checkSession: () => ipcRenderer.invoke('app:check-session'),
  chooseOutput: () => ipcRenderer.invoke('app:choose-output'),
  start: limit => ipcRenderer.invoke('app:start', limit),
  recover: () => ipcRenderer.invoke('app:recover'),
  copyDiagnostics: () => ipcRenderer.invoke('app:copy-diagnostics'),
  observeFile: () => ipcRenderer.invoke('app:observe-file'),
  verify: () => ipcRenderer.invoke('app:verify'),
  stop: () => ipcRenderer.invoke('app:stop'),
  openOutput: () => ipcRenderer.invoke('app:open-output'),
  closeSignIn: () => ipcRenderer.invoke('app:close-sign-in'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('export:state', listener);
    return () => ipcRenderer.removeListener('export:state', listener);
  },
}));
