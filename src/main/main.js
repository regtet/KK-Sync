import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitService } from './gitService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 以 app.isPackaged 为准，避免打包后误判为开发环境
const isDev = !app.isPackaged;

let mainWindow = null;

const withLogRelay = (channel) => (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
};

async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 2000,
        height: 1200,
        minWidth: 2000,
        minHeight: 900,
        backgroundColor: '#1f1f1f',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });

    if (isDev) {
        const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
        await mainWindow.loadURL(devServerUrl);
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        const rendererIndex = path.join(__dirname, '../../dist/renderer/index.html');
        await mainWindow.loadFile(rendererIndex);
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

const relayLog = withLogRelay('sync:log');

gitService.on('log', relayLog);

ipcMain.handle('repo:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
    }

    const repoPath = result.filePaths[0];
    try {
        const info = await gitService.setRepository(repoPath);
        const branches = await gitService.getBranches();
        return {
            canceled: false,
            repo: info,
            branches
        };
    } catch (error) {
        return {
            canceled: false,
            error: error?.message ?? String(error)
        };
    }
});

ipcMain.handle('repo:info', async () => {
    try {
        const info = await gitService.getRepositoryInfo();
        return { ok: true, data: info };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:list-branches', async () => {
    try {
        const branches = await gitService.getBranches();
        return { ok: true, data: branches };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:list-stash', async () => {
    try {
        const stash = await gitService.getStashList();
        return { ok: true, data: stash };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:check-remote-branches', async (_, branchNames) => {
    try {
        const result = await gitService.checkRemoteBranches(branchNames);
        return { ok: true, data: result };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('patch:select', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'Patch files', extensions: ['patch', 'diff'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || !result.filePaths?.length) {
            return { ok: false, canceled: true };
        }

        return { ok: true, data: { path: result.filePaths[0] } };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('sync:start', async (_, payload) => {
    const { mode = 'branch' } = payload ?? {};
    try {
    withLogRelay('sync:status')({ status: 'running', mode });
    const { results, cancelled } = await gitService.syncBranches(payload, relayLog);
    withLogRelay('sync:status')({
      status: cancelled ? 'cancelled' : 'completed',
      mode,
      results
    });
    return { ok: true, results, cancelled };
    } catch (error) {
        const message = error?.message ?? String(error);
        relayLog({ message, level: 'error', timestamp: new Date().toISOString() });
        withLogRelay('sync:status')({ status: 'failed', mode, message });
        return { ok: false, error: message };
    }
});

ipcMain.handle('sync:cancel', async () => {
  try {
    const cancelled = gitService.cancelSync();
    if (!cancelled) {
      return { ok: false, error: '当前没有正在进行的同步任务' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});
