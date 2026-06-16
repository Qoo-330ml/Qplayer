const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
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

async function validBundledMpv(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.size > 1024 * 1024;
  } catch {
    return false;
  }
}

async function bundledMpvPath() {
  const platformPaths = {
    darwin: {
      dir: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64',
      executable: path.join('mpv.app', 'Contents', 'MacOS', 'mpv')
    },
    win32: {
      dir: process.arch === 'arm64' ? 'win-arm64' : 'win-x64',
      executable: 'mpv.exe'
    }
  };
  const current = platformPaths[process.platform];
  if (!current) return '';

  const packagedPath = path.join(process.resourcesPath, 'mpv', current.dir, current.executable);
  const devPath = path.join(__dirname, '..', 'vendor', 'mpv', current.dir, current.executable);

  if (app.isPackaged && await validBundledMpv(packagedPath)) return packagedPath;
  if (await validBundledMpv(devPath)) return devPath;
  return '';
}

function bundledQplayerIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'qplayer-icon.icns');
  return path.join(__dirname, '..', 'build', 'icon.icns');
}

async function validFile(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

function appBundleFromMpvPath(playerPath) {
  const marker = `${path.sep}mpv.app${path.sep}Contents${path.sep}MacOS${path.sep}mpv`;
  if (!playerPath.endsWith(marker)) return '';
  return playerPath.slice(0, -marker.length) + `${path.sep}mpv.app`;
}

async function brandedMpvPath(playerPath) {
  if (process.platform !== 'darwin') return playerPath;

  const sourceBundle = appBundleFromMpvPath(playerPath);
  if (!sourceBundle) return playerPath;

  const iconPath = bundledQplayerIconPath();
  if (!await validFile(iconPath)) return playerPath;

  const brandedRoot = path.join(app.getPath('userData'), 'branded-mpv');
  const brandedBundle = path.join(brandedRoot, 'Qplayer mpv.app');
  const brandedExecutable = path.join(brandedBundle, 'Contents', 'MacOS', 'mpv');
  const stampPath = path.join(brandedRoot, 'source.txt');
  const nextStamp = `${sourceBundle}\n${iconPath}\n`;

  let currentStamp = '';
  try {
    currentStamp = await fs.readFile(stampPath, 'utf8');
  } catch {
  }

  if (currentStamp !== nextStamp || !await validBundledMpv(brandedExecutable)) {
    await fs.rm(brandedBundle, { recursive: true, force: true });
    await fs.mkdir(brandedRoot, { recursive: true });
    await fs.cp(sourceBundle, brandedBundle, { recursive: true });
    await fs.copyFile(iconPath, path.join(brandedBundle, 'Contents', 'Resources', 'icon.icns'));
    await fs.writeFile(stampPath, nextStamp);
  }

  return brandedExecutable;
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
  const windowOptions = {
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'Qplayer',
    icon: path.join(__dirname, 'renderer', 'icons.png'),
    backgroundColor: '#f6f9fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 18, y: 18 };
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
  }

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function createStreamUrl(config, item) {
  const serverUrl = normalizeServerUrl(config.serverUrl);
  return `${serverUrl}/Videos/${item.Id}/stream?Static=true&api_key=${encodeURIComponent(config.accessToken)}`;
}

async function ensureMpvProfile() {
  const profileDir = path.join(app.getPath('userData'), 'mpv-profile');
  const scriptOptionsDir = path.join(profileDir, 'script-opts');

  await fs.mkdir(scriptOptionsDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'mpv.conf'), [
    'osc=yes',
    'osd-bar=no',
    'osd-on-seek=msg-bar',
    'osd-font-size=28',
    'osd-color=#FFFFFFFF',
    'osd-outline-color=#A0000000',
    'osd-outline-size=1.2',
    'osd-shadow-offset=0',
    'osd-margin-x=24',
    'osd-margin-y=22',
    'force-window=immediate',
    'keep-open=no',
    'border=yes',
    'title-bar=yes',
    'save-position-on-quit=yes',
    'watch-later-options=fullscreen,speed,volume,mute',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(scriptOptionsDir, 'osc.conf'), [
    'layout=bottombar',
    'seekbarstyle=knob',
    'seekbarhandlesize=0.85',
    'seekrangestyle=bar',
    'seekrangealpha=55',
    'deadzonesize=0',
    'minmousemove=3',
    'barmargin=0',
    'boxalpha=105',
    'hidetimeout=1400',
    'fadeduration=160',
    'fadein=yes',
    'scalewindowed=1.08',
    'scalefullscreen=1.0',
    'vidscale=no',
    'timetotal=yes',
    'tcspace=110',
    'visibility=auto',
    'boxvideo=no',
    'dynamic_margins=yes',
    'sub_margins=yes',
    'windowcontrols=auto',
    'windowcontrols_alignment=right',
    'tracknumberswidth=0',
    'icon_style=fluent',
    'background_color=#000000',
    'timecode_color=#B994FF',
    'title_color=#FFFFFF',
    'time_pos_color=#FFFFFF',
    'time_pos_outline_color=#000000',
    'buttons_color=#FFFFFF',
    'top_buttons_color=#FFFFFF',
    'small_buttonsL_color=#FFFFFF',
    'small_buttonsR_color=#FFFFFF',
    'held_element_color=#B994FF',
    'custom_button_1_content=1.0x',
    'custom_button_1_mbtn_left_command=cycle-values speed 1 1.25 1.5 2 0.75',
    'custom_button_1_mbtn_right_command=set speed 1',
    'custom_button_1_wheel_up_command=add speed 0.25',
    'custom_button_1_wheel_down_command=add speed -0.25',
    ''
  ].join('\n'));

  await fs.writeFile(path.join(profileDir, 'input.conf'), [
    'SPACE cycle pause',
    'LEFT seek -10',
    'RIGHT seek 10',
    'UP add volume 5',
    'DOWN add volume -5',
    'm cycle mute',
    'f cycle fullscreen',
    's cycle sub',
    'a cycle audio',
    'p script-message osc-visibility cycle',
    ''
  ].join('\n'));

  return profileDir;
}

async function launchMpv(item, streamUrl) {
  const config = await readConfig();
  const profileDir = await ensureMpvProfile();
  const resolvedPlayerPath = await bundledMpvPath() || config.playerPath || 'mpv';
  const playerPath = await brandedMpvPath(resolvedPlayerPath);
  const args = [
    `--config-dir=${profileDir}`,
    '--hwdec=auto-safe',
    '--force-window=yes',
    `--force-media-title=${item.Name || 'Qplayer'}`,
    `--title=${item.Name || 'Qplayer'}`,
    streamUrl
  ];

  if (process.platform === 'darwin') {
    args.splice(args.length - 1, 0,
      '--macos-title-bar-appearance=darkAqua',
      '--macos-title-bar-material=hudWindow',
      '--macos-title-bar-color=#00000000'
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    let launchTimer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(launchTimer);
      resolve(result);
    };
    const fallbackToSystem = async (message) => {
      if (settled) return;
      try {
        await Promise.race([
          shell.openExternal(streamUrl),
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2000))
        ]);
      } catch {
      }
      settle({ mode: 'system', streamUrl, playerPath, message });
    };
    const player = spawn(playerPath, args, {
      detached: true,
      stdio: 'ignore'
    });

    player.once('spawn', () => {
      launchTimer = setTimeout(() => {
        player.unref();
        settle({ mode: 'mpv', streamUrl, playerPath });
      }, 1500);
    });

    player.once('exit', (code) => {
      fallbackToSystem(`mpv 过早退出：${code ?? 'unknown'}`);
    });

    player.once('error', (error) => {
      fallbackToSystem(error?.message || 'mpv 启动失败');
    });
  });
}

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  createWindow();
});

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

ipcMain.handle('emby:item', async (_event, itemId) => {
  const config = await readConfig();
  const params = new URLSearchParams({
    Fields: 'Overview,ProductionYear,RunTimeTicks,CommunityRating,OfficialRating,Genres,Studios,People,MediaSources,ProviderIds,ExternalUrls,Taglines,PremiereDate,DateCreated,SeriesName,ParentIndexNumber,IndexNumber',
    ImageTypeLimit: '1',
    EnableImageTypes: 'Primary,Backdrop,Thumb'
  });

  return embyFetch(config, `/Users/${config.userId}/Items/${itemId}?${params}`, { timeoutMs: 10000 });
});

ipcMain.handle('player:play', async (_event, item) => {
  const config = await readConfig();
  const streamUrl = createStreamUrl(config, item);
  return launchMpv(item, streamUrl);
});
