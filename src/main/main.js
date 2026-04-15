import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gitService } from './gitService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 以 app.isPackaged 为准，避免打包后误判为开发环境
const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;
let isQuitting = false;
const repoPathStoreFile = path.join(app.getPath('userData'), 'last-repo-paths.json');
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const readLastRepoPaths = () => {
    try {
        if (!existsSync(repoPathStoreFile)) return {};
        const text = readFileSync(repoPathStoreFile, 'utf-8');
        const data = JSON.parse(text);
        return typeof data === 'object' && data ? data : {};
    } catch {
        return {};
    }
};

const writeLastRepoPath = (key, value) => {
    try {
        const curr = readLastRepoPaths();
        curr[key] = value;
        writeFileSync(repoPathStoreFile, JSON.stringify(curr, null, 2), 'utf-8');
    } catch {
        // ignore persistence failure
    }
};

const resolveTrayIcon = () => {
    const iconCandidates = [
        path.join(__dirname, '../assets/img/logo.ico'),
        path.join(__dirname, '../assets/img/logo_ico_256x256.ico'),
        path.join(__dirname, '../assets/img/logo.png'),
        path.join(process.cwd(), 'src/assets/img/logo.ico'),
        path.join(process.cwd(), 'src/assets/img/logo_ico_256x256.ico'),
        path.join(process.cwd(), 'src/assets/img/logo.png')
    ];
    const iconPath = iconCandidates.find((p) => existsSync(p));
    if (iconPath) {
        return nativeImage.createFromPath(iconPath);
    }
    return nativeImage.createEmpty();
};

const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();
};

const createTray = () => {
    if (tray) return;
    tray = new Tray(resolveTrayIcon());
    tray.setToolTip('KK Sync');
    const trayMenu = Menu.buildFromTemplate([
        {
            label: '显示窗口',
            click: () => showMainWindow()
        },
        {
            type: 'separator'
        },
        {
            label: '退出程序',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]);
    tray.setContextMenu(trayMenu);
    tray.on('double-click', () => showMainWindow());
};

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
        autoHideMenuBar: true,
        icon: resolveTrayIcon(),
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
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMenu(null);

    mainWindow.once('ready-to-show', () => {
        showMainWindow();
    });
    // 某些环境可能不会稳定触发 ready-to-show，这里增加兜底确保首启可见
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => showMainWindow(), 120);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.on('close', (event) => {
        // 点击右上角关闭时默认隐藏到托盘，不直接退出
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        showMainWindow();
    });

    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);
        createTray();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            } else {
                showMainWindow();
            }
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && isQuitting) {
        app.quit();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
});

const relayLog = withLogRelay('sync:log');

gitService.on('log', relayLog);

ipcMain.handle('repo:select', async () => {
    const lastPaths = readLastRepoPaths();
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: lastPaths.repo1
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
    }

    const repoPath = result.filePaths[0];
    try {
        const info = await gitService.setRepository(repoPath);
        const branches = await gitService.getBranches(1);
        writeLastRepoPath('repo1', repoPath);
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

ipcMain.handle('repo:select2', async () => {
    const lastPaths = readLastRepoPaths();
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        defaultPath: lastPaths.repo2
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
    }

    const repoPath = result.filePaths[0];
    try {
        const info = await gitService.setRepository2(repoPath);
        const branches = await gitService.getBranches(2);
        writeLastRepoPath('repo2', repoPath);
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

ipcMain.handle('repo:clear2', async () => {
    try {
        await gitService.setRepository2(null);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:has', async (_, repoIndex = 1) => {
    return { ok: true, hasRepo: gitService.hasRepository(repoIndex) };
});

ipcMain.handle('repo:info', async (_, repoIndex = 1) => {
    try {
        const info = await gitService.getRepositoryInfo(repoIndex);
        return { ok: true, data: info };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:list-branches', async (_, repoIndex = 1) => {
    try {
        const branches = await gitService.getBranches(repoIndex);
        return { ok: true, data: branches };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:list-stash', async (_, repoIndex = 1) => {
    try {
        const stash = await gitService.getStashList(repoIndex);
        return { ok: true, data: stash };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:check-remote-branches', async (_, payload) => {
    try {
        const branchNames = Array.isArray(payload) ? payload : payload?.branchNames;
        const repoIndex =
            typeof payload === 'object' && payload && !Array.isArray(payload)
                ? payload.repoIndex ?? 1
                : 1;
        const result = await gitService.checkRemoteBranches(branchNames ?? [], repoIndex);
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
    const { mode = 'commit', repoIndex = 1 } = payload ?? {};
    try {
    withLogRelay('sync:status')({ status: 'running', mode, repoIndex });
    const { results, cancelled } = await gitService.syncBranches(payload, relayLog, repoIndex);
    withLogRelay('sync:status')({
      status: cancelled ? 'cancelled' : 'completed',
      mode,
      repoIndex,
      results
    });
    return { ok: true, results, cancelled };
    } catch (error) {
        const message = error?.message ?? String(error);
        relayLog({ message, level: 'error', timestamp: new Date().toISOString() });
        withLogRelay('sync:status')({ status: 'failed', mode, repoIndex, message });
        return { ok: false, error: message };
    }
});

ipcMain.handle('sync:cancel', async (_, repoIndex = 1) => {
  try {
    const cancelled = gitService.cancelSync(repoIndex);
    if (!cancelled) {
      return { ok: false, error: `仓库${repoIndex} 当前没有正在进行的同步任务` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});
