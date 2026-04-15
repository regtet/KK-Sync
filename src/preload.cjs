const { contextBridge, ipcRenderer } = require('electron');

const buildRemoveListener = (channel, listener) => () => {
  ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('electronAPI', {
  selectRepository: () => ipcRenderer.invoke('repo:select'),
  selectRepository2: () => ipcRenderer.invoke('repo:select2'),
  clearRepository2: () => ipcRenderer.invoke('repo:clear2'),
  hasRepository: (repoIndex = 1) => ipcRenderer.invoke('repo:has', repoIndex),
  getRepositoryInfo: (repoIndex = 1) => ipcRenderer.invoke('repo:info', repoIndex),
  listBranches: (repoIndex = 1) => ipcRenderer.invoke('repo:list-branches', repoIndex),
  checkRemoteBranches: (branchNames, repoIndex = 1) =>
    ipcRenderer.invoke('repo:check-remote-branches', { branchNames, repoIndex }),
  listStashes: (repoIndex = 1) => ipcRenderer.invoke('repo:list-stash', repoIndex),
  selectPatchFile: () => ipcRenderer.invoke('patch:select'),
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
  }
});
