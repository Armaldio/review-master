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
  checkStorage: () => ipcRenderer.invoke('check-storage-encryption'),
  runSem: (payload: any) => ipcRenderer.invoke('run-sem', payload),
  runDifftastic: (payload: any) => ipcRenderer.invoke('run-difftastic', payload),
  checkBinaries: () => ipcRenderer.invoke('check-binaries'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  parseCodeowners: (content: string) => ipcRenderer.invoke('parse-codeowners', content),
  matchCodeowners: (filePath: string, rules: any[]) => ipcRenderer.invoke('match-codeowners', { filePath, rules }),
  matchCodeownersBulk: (filePaths: string[], rules: any[]) => ipcRenderer.invoke('match-codeowners-bulk', { filePaths, rules }),
});
