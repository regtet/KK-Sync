const { contextBridge, ipcRenderer } = require('electron');

const buildRemoveListener = (channel, listener) => () => {
  ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('electronAPI', {
  selectRepository: () => ipcRenderer.invoke('repo:select'),
  selectRepository2: () => ipcRenderer.invoke('repo:select2'),
  clearRepository2: () => ipcRenderer.invoke('repo:clear2'),
  restoreRepository: (repoIndex = 1) => ipcRenderer.invoke('repo:restore', repoIndex),
  saveRepoSession: (payload) => ipcRenderer.invoke('repo:save-session', payload),
  hasRepository: (repoIndex = 1) => ipcRenderer.invoke('repo:has', repoIndex),
  getRepositoryInfo: (repoIndex = 1) => ipcRenderer.invoke('repo:info', repoIndex),
  listRemotes: (repoIndex = 1) => ipcRenderer.invoke('repo:list-remotes', repoIndex),
  listBranches: (repoIndex = 1, remoteName = null) =>
    ipcRenderer.invoke('repo:list-branches', { repoIndex, remoteName }),
  checkRemoteBranches: (branchNames, repoIndex = 1, remoteName = null) =>
    ipcRenderer.invoke('repo:check-remote-branches', { branchNames, repoIndex, remoteName }),
  listStashes: (repoIndex = 1) => ipcRenderer.invoke('repo:list-stash', repoIndex),
  selectPatchFile: () => ipcRenderer.invoke('patch:select'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  startSync: (payload) => ipcRenderer.invoke('sync:start', payload),
  cancelSync: (repoIndex = 1) => ipcRenderer.invoke('sync:cancel', repoIndex),
  onSyncLog: (callback) => {
    const listener = (_event, data) => {
      callback?.(data);
    };
    ipcRenderer.on('sync:log', listener);
    return buildRemoveListener('sync:log', listener);
  },
  onSyncStatus: (callback) => {
    const listener = (_event, data) => {
      callback?.(data);
    };
    ipcRenderer.on('sync:status', listener);
    return buildRemoveListener('sync:status', listener);
  },
  googleSheetsAuthStatus: () => ipcRenderer.invoke('google-sheets-auth-status'),
  googleSheetsLogin: () => ipcRenderer.invoke('google-sheets-login'),
  googleSheetsLogout: () => ipcRenderer.invoke('google-sheets-logout'),
  googleSheetsFetchRows: (options) => ipcRenderer.invoke('google-sheets-fetch-rows', options)
});
