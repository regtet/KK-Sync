import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gitService } from './gitService.js';
import {
  clearStoredTokens,
  fetchSpreadsheetRows,
  findOAuthClientSecretPath,
  getGoogleAuthStatus,
  loginWithGoogle,
  writeSpreadsheetBranchNames,
} from './googleSheets.js';

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

const writeRepoSession = (repoIndex, session = {}) => {
    try {
        const curr = readLastRepoPaths();
        if (!curr.session || typeof curr.session !== 'object') {
            curr.session = {};
        }
        curr.session[String(repoIndex)] = {
            remote: session.remote ?? '',
            commitHash: session.commitHash ?? '',
            commitHashes:
                session.commitHashes && typeof session.commitHashes === 'object'
                    ? session.commitHashes
                    : {},
            targetBranches: Array.isArray(session.targetBranches) ? session.targetBranches : []
        };
        writeFileSync(repoPathStoreFile, JSON.stringify(curr, null, 2), 'utf-8');
    } catch {
        // ignore persistence failure
    }
};

const readRepoSession = (repoIndex) => {
    const data = readLastRepoPaths();
    const session = data?.session?.[String(repoIndex)];
    if (!session || typeof session !== 'object') return null;
    return {
        remote: session.remote ?? '',
        commitHash: session.commitHash ?? '',
        commitHashes:
            session.commitHashes && typeof session.commitHashes === 'object'
                ? session.commitHashes
                : {},
        targetBranches: Array.isArray(session.targetBranches) ? session.targetBranches : []
    };
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

const restoreRepositoryByIndex = async (repoIndex = 1) => {
    const key = repoIndex === 2 ? 'repo2' : 'repo1';
    const repoPath = readLastRepoPaths()[key];
    if (!repoPath || !existsSync(repoPath)) {
        return { ok: false, reason: 'no_saved_path' };
    }
    if (!existsSync(path.join(repoPath, '.git'))) {
        return { ok: false, reason: 'invalid_repo' };
    }

    const info = repoIndex === 2
        ? await gitService.setRepository2(repoPath)
        : await gitService.setRepository(repoPath);
    const remotes = await gitService.getRemotes(repoIndex);
    const session = readRepoSession(repoIndex);
    const branches = await gitService.getBranchGroups(repoIndex);
    return {
        ok: true,
        repo: info,
        remotes,
        branches,
        session
    };
};

ipcMain.handle('repo:restore', async (_, repoIndex = 1) => {
    try {
        return await restoreRepositoryByIndex(repoIndex);
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:save-session', async (_, payload = {}) => {
    try {
        const repoIndex = payload?.repoIndex ?? 1;
        writeRepoSession(repoIndex, payload);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

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
        const remotes = await gitService.getRemotes(1);
        const branches = await gitService.getBranchGroups(1);
        writeLastRepoPath('repo1', repoPath);
        return {
            canceled: false,
            repo: info,
            branches,
            remotes
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
        const remotes = await gitService.getRemotes(2);
        const branches = await gitService.getBranchGroups(2);
        writeLastRepoPath('repo2', repoPath);
        return {
            canceled: false,
            repo: info,
            branches,
            remotes
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
        writeLastRepoPath('repo2', '');
        writeRepoSession(2, { remote: '', commitHash: '', commitHashes: {}, targetBranches: [] });
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

ipcMain.handle('repo:list-remotes', async (_, repoIndex = 1) => {
    try {
        const remotes = await gitService.getRemotes(repoIndex);
        return { ok: true, data: remotes };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:list-branches', async (_, payload) => {
    try {
        const repoIndex =
            typeof payload === 'number' ? payload : payload?.repoIndex ?? 1;
        const allRemotes =
            typeof payload === 'object' && payload ? payload.allRemotes === true : false;
        const remoteName =
            typeof payload === 'object' && payload ? payload.remoteName ?? null : null;
        const branches = allRemotes || !remoteName
            ? await gitService.getBranchGroups(repoIndex)
            : await gitService.getBranches(repoIndex, remoteName);
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
        const remoteName =
            typeof payload === 'object' && payload && !Array.isArray(payload)
                ? payload.remoteName ?? null
                : null;
        const result = await gitService.checkRemoteBranches(
            branchNames ?? [],
            repoIndex,
            remoteName
        );
        return { ok: true, data: result };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:plan-stale-duplicates', async (_, repoIndex = 1) => {
    try {
        const data = await gitService.planStaleDuplicateDeletions(repoIndex);
        return { ok: true, data };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('repo:delete-stale-duplicates', async (_, repoIndex = 1) => {
    try {
        withLogRelay('sync:status')({ status: 'running', mode: 'cleanup-duplicates', repoIndex });
        const { deleted, failed, cancelled } = await gitService.deleteStaleDuplicateRemoteBranches(
            repoIndex,
            relayLog
        );
        const results = [
            ...deleted.map((item) => ({ branch: item.key, success: true, error: null })),
            ...failed.map((item) => ({ branch: item.key, success: false, error: item.error }))
        ];
        withLogRelay('sync:status')({
            status: cancelled ? 'cancelled' : 'completed',
            mode: 'cleanup-duplicates',
            repoIndex,
            results
        });
        return { ok: true, data: { deleted, failed, cancelled } };
    } catch (error) {
        const message = error?.message ?? String(error);
        relayLog({ message, level: 'error', timestamp: new Date().toISOString(), repoIndex });
        withLogRelay('sync:status')({
            status: 'failed',
            mode: 'cleanup-duplicates',
            repoIndex,
            message
        });
        return { ok: false, error: message };
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

ipcMain.handle('app:open-external', async (_, url) => {
    try {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            return { ok: false, error: '无效的链接地址' };
        }
        await shell.openExternal(url);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('app:copy-text', async (_, text) => {
    try {
        if (typeof text !== 'string') {
            return { ok: false, error: '无效的复制内容' };
        }
        clipboard.writeText(text);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
});

ipcMain.handle('sync:start', async (_, payload) => {
    const { mode = 'commit', repoIndex = 1 } = payload ?? {};
    try {
    withLogRelay('sync:status')({
        status: 'running',
        mode,
        repoIndex,
        total: Array.isArray(payload?.targetBranches) ? payload.targetBranches.length : 0
    });
    const onProgress = (progress) => {
        withLogRelay('sync:status')({
            status: 'progress',
            mode,
            repoIndex,
            ...progress
        });
    };
    const { results, cancelled } = await gitService.syncBranches(
        payload,
        relayLog,
        repoIndex,
        onProgress
    );
    withLogRelay('sync:status')({
      status: cancelled ? 'cancelled' : 'completed',
      mode,
      repoIndex,
      results
    });
    return { ok: true, results, cancelled };
    } catch (error) {
        const message = error?.message ?? String(error);
        relayLog({ message, level: 'error', timestamp: new Date().toISOString(), repoIndex });
        withLogRelay('sync:status')({ status: 'failed', mode, repoIndex, message });
        return { ok: false, error: message };
    }
});

ipcMain.handle('sync:cancel', async (_, repoIndex = 1) => {
  try {
    const cancelled = gitService.cancelSync(repoIndex);
    if (!cancelled) {
      return { ok: false, error: `仓库${repoIndex} 当前没有正在进行的任务` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

function getGoogleCredentialSearchDirs() {
  const dirs = [];
  const seen = new Set();
  const push = (...candidates) => {
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'string') continue;
      const normalized = path.normalize(raw);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      dirs.push(normalized);
    }
  };

  const appPath = app.getAppPath();

  push(__dirname);
  push(path.dirname(__dirname));
  push(path.dirname(path.dirname(__dirname)));
  push(appPath);
  push(path.join(appPath, 'src', 'main'));
  push(app.getPath('userData'));
  push(process.cwd());

  if (process.resourcesPath) {
    push(process.resourcesPath);
    push(path.join(process.resourcesPath, 'app'));
    push(path.join(process.resourcesPath, 'app', 'src', 'main'));
  }

  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    push(execDir);
    push(path.join(execDir, 'resources'));
    push(path.join(execDir, 'resources', 'app'));
    push(path.join(execDir, 'resources', 'app', 'src', 'main'));
    push(path.join(execDir, 'resources', 'credentials'));
  }

  if (process.resourcesPath) {
    push(path.join(process.resourcesPath, 'credentials'));
  }

  return dirs;
}

ipcMain.handle('google-sheets-auth-status', async () => {
  try {
    const userDataDir = app.getPath('userData');
    const status = getGoogleAuthStatus(userDataDir);
    const secretPath = findOAuthClientSecretPath(getGoogleCredentialSearchDirs());
    return {
      ok: true,
      ...status,
      hasClientSecret: Boolean(secretPath),
      clientSecretPath: secretPath || '',
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('google-sheets-login', async () => {
  try {
    const userDataDir = app.getPath('userData');
    const result = await loginWithGoogle(userDataDir, getGoogleCredentialSearchDirs());
    return result;
  } catch (e) {
    return { ok: false, message: e.message || 'Google 授权失败' };
  }
});

ipcMain.handle('google-sheets-logout', async () => {
  try {
    clearStoredTokens(app.getPath('userData'));
    return { ok: true, message: '已退出本工具的 Google 登录（不影响 KK SkinLab）' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('google-sheets-fetch-rows', async (_event, options = {}) => {
  try {
    const result = await fetchSpreadsheetRows(
      app.getPath('userData'),
      getGoogleCredentialSearchDirs(),
      options
    );
    return result;
  } catch (e) {
    return { ok: false, message: e.message || '读取 Google 表格失败' };
  }
});

ipcMain.handle('repo:resolve-best-branches', async (_event, payload = {}) => {
  try {
    const repoIndex = payload?.repoIndex ?? 1;
    const branchNames = Array.isArray(payload?.branchNames) ? payload.branchNames : [];
    const result = await gitService.resolveBestRemoteBranches(branchNames, repoIndex);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, message: e.message || '智能匹配分支失败' };
  }
});

ipcMain.handle('google-sheets-write-branches', async (_event, options = {}) => {
  try {
    const result = await writeSpreadsheetBranchNames(
      app.getPath('userData'),
      getGoogleCredentialSearchDirs(),
      options
    );
    return result;
  } catch (e) {
    return { ok: false, message: e.message || '回填 Google 表格失败' };
  }
});
