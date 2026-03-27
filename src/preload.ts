// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  cloneRepo: (repoUrl: string, targetPath: string) => ipcRenderer.invoke('clone-repo', repoUrl, targetPath),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  setSecret: (account: string, value: string) => ipcRenderer.invoke('set-secret', account, value),
  getSecret: (account: string) => ipcRenderer.invoke('get-secret', account),
  deleteSecret: (account: string) => ipcRenderer.invoke('delete-secret', account),
  checkKeyring: () => ipcRenderer.invoke('check-keyring'),
});
