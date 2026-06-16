const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const CLIENT_NAME = 'Qplayer';
const CLIENT_VERSION = '0.1.0';

let mainWindow;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeConfig(nextConfig) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(nextConfig, null, 2));
  return nextConfig;
}

function normalizeServerUrl(serverUrl) {
  return String(serverUrl || '').trim().replace(/\/+$/, '');
}

function networkErrorMessage(error, serverUrl) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;

  if (error?.name === 'AbortError') {
    return `连接 Emby 超时：${serverUrl}`;
  }

  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED') {
    return `Emby 的 HTTPS 证书无法验证：${serverUrl}。请改用 http 地址，或在系统里信任该证书。`;
  }

  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return `无法连接到 Emby：${serverUrl}。请检查服务器地址、端口、协议 http/https 是否正确。`;
  }

  return error?.message || `Emby 请求失败：${serverUrl}`;
}

async function responseError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return data.Message || data.error || text;
  } catch {
    return text;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function bundledMpvPath() {
  if (process.platform !== 'darwin') return '';

  const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  const packagedPath = path.join(process.resourcesPath, 'mpv', arch, 'mpv.app', 'Contents', 'MacOS', 'mpv');
  const devPath = path.join(__dirname, '..', 'vendor', 'mpv', arch, 'mpv.app', 'Contents', 'MacOS', 'mpv');

  if (app.isPackaged && await fileExists(packagedPath)) return packagedPath;
  if (await fileExists(devPath)) return devPath;
  return '';
}

function authHeader() {
  return [
    `MediaBrowser Client="${CLIENT_NAME}"`,
    `Device="${process.platform}"`,
    `DeviceId="${app.getPath('userData')}"`,
    `Version="${CLIENT_VERSION}"`
  ].join(', ');
}

async function embyFetch(config, endpoint, options = {}) {
  const serverUrl = normalizeServerUrl(config.serverUrl);
  if (!serverUrl) {
    throw new Error('请先填写 Emby 服务器地址。');
  }
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    Accept: 'application/json',
    Authorization: authHeader(),
    ...(fetchOptions.headers || {})
  };

  if (config.accessToken) {
    headers['X-Emby-Token'] = config.accessToken;
  }

  try {
    const response = await fetch(`${serverUrl}${endpoint}`, {
      ...fetchOptions,
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await responseError(response);
      throw new Error(text || `Emby 请求失败：${response.status}`);
    }

    return response.json();
  } catch (error) {
    if (error?.message && !/fetch failed/i.test(error.message) && error.name !== 'AbortError') {
      throw error;
    }
    throw new Error(networkErrorMessage(error, serverUrl));
  } finally {
    clearTimeout(timeout);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'Qplayer',
    backgroundColor: '#f6f9fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('config:get', readConfig);

ipcMain.handle('config:save', async (_event, patch) => {
  const current = await readConfig();
  return writeConfig({ ...current, ...patch });
});

ipcMain.handle('emby:login', async (_event, credentials) => {
  const serverUrl = normalizeServerUrl(credentials.serverUrl);
  const data = await embyFetch({ serverUrl }, '/Users/AuthenticateByName', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      Username: credentials.username,
      Pw: credentials.password
    }),
    timeoutMs: 10000
  });
  const nextConfig = await writeConfig({
    serverUrl,
    username: credentials.username,
    userId: data.User.Id,
    accessToken: data.AccessToken,
    playerPath: credentials.playerPath || 'mpv'
  });

  return {
    config: nextConfig,
    user: data.User
  };
});

ipcMain.handle('emby:libraries', async () => {
  const config = await readConfig();
  return embyFetch(config, `/Users/${config.userId}/Views`);
});

ipcMain.handle('emby:home', async () => {
  const config = await readConfig();
  const libraries = await embyFetch(config, `/Users/${config.userId}/Views`, { timeoutMs: 10000 });
  return {
    libraries: libraries.Items || []
  };
});

ipcMain.handle('emby:resume', async () => {
  const config = await readConfig();
  const resumeParams = new URLSearchParams({
    Limit: '20',
    MediaTypes: 'Video',
    Fields: 'Overview,ProductionYear,RunTimeTicks,CommunityRating,SeriesName,ParentIndexNumber,IndexNumber',
    ImageTypeLimit: '1',
    EnableImageTypes: 'Primary,Backdrop,Thumb'
  });
  const resume = await embyFetch(config, `/Users/${config.userId}/Items/Resume?${resumeParams}`, { timeoutMs: 8000 });
  return resume.Items || [];
});

ipcMain.handle('emby:latest', async (_event, library) => {
  const config = await readConfig();
  const latestParams = new URLSearchParams({
    ParentId: library.Id,
    Recursive: 'false',
    SortBy: 'DateCreated,SortName',
    SortOrder: 'Descending',
    Fields: 'Overview,ProductionYear,RunTimeTicks,CommunityRating,ChildCount',
    ImageTypeLimit: '1',
    EnableImageTypes: 'Primary,Backdrop,Thumb',
    Limit: '20'
  });
  const items = await embyFetch(config, `/Users/${config.userId}/Items?${latestParams}`, { timeoutMs: 8000 });
  return {
    library,
    items: items.Items || []
  };
});

ipcMain.handle('emby:items', async (_event, parentId) => {
  const config = await readConfig();
  const params = new URLSearchParams({
    ParentId: parentId,
    Recursive: 'false',
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    Fields: 'Overview,ProductionYear,RunTimeTicks,CommunityRating,ChildCount',
    ImageTypeLimit: '1',
    EnableImageTypes: 'Primary,Backdrop,Thumb',
    Limit: '200'
  });

  return embyFetch(config, `/Users/${config.userId}/Items?${params}`);
});

ipcMain.handle('player:play', async (_event, item) => {
  const config = await readConfig();
  const serverUrl = normalizeServerUrl(config.serverUrl);
  const streamUrl = `${serverUrl}/Videos/${item.Id}/stream?Static=true&api_key=${encodeURIComponent(config.accessToken)}`;
  const playerPath = await bundledMpvPath() || config.playerPath || 'mpv';
  const args = [
    '--hwdec=auto-safe',
    '--force-window=yes',
    `--title=${item.Name || 'Qplayer'}`,
    streamUrl
  ];

  return new Promise((resolve) => {
    const player = spawn(playerPath, args, {
      detached: true,
      stdio: 'ignore'
    });

    player.once('spawn', () => {
      player.unref();
      resolve({ mode: 'mpv', streamUrl });
    });

    player.once('error', async () => {
      await shell.openExternal(streamUrl);
      resolve({ mode: 'system', streamUrl });
    });
  });
});
