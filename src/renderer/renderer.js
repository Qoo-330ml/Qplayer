const form = document.querySelector('#loginForm');
const serverUrlInput = document.querySelector('#serverUrl');
const displayNameInput = document.querySelector('#displayName');
const usernameInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');
const playerPathInput = document.querySelector('#playerPath');
const settingsOverlay = document.querySelector('#settingsOverlay');
const homeView = document.querySelector('#homeView');
const itemsEl = document.querySelector('#items');
const statusEl = document.querySelector('#status');
const titleEl = document.querySelector('#currentTitle');
const backButton = document.querySelector('#backButton');
const refreshButton = document.querySelector('#refreshButton');
const settingsButton = document.querySelector('#settingsButton');
const addServerButton = document.querySelector('#addServerButton');
const footerSettingsButton = document.querySelector('#footerSettingsButton');
const cancelSettingsButton = document.querySelector('#cancelSettingsButton');
const serverCard = document.querySelector('#serverCard');
const serverName = document.querySelector('#serverName');
const serverMeta = document.querySelector('#serverMeta');
const searchInput = document.querySelector('#searchInput');
const itemTemplate = document.querySelector('#itemTemplate');
const sectionTemplate = document.querySelector('#sectionTemplate');

let currentLibraryId = '';
let navigationStack = [];
let homeLoadId = 0;

const CONTAINER_TYPES = new Set(['Series', 'Season', 'Folder', 'BoxSet', 'CollectionFolder']);
const PLAYABLE_TYPES = new Set(['Movie', 'Episode', 'Video']);

function setStatus(message) {
  statusEl.textContent = message;
}

function cleanErrorMessage(error, fallback) {
  const raw = error?.message || fallback;
  return String(raw)
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
}

function renderError(container, message) {
  container.replaceChildren();
  const paragraph = document.createElement('p');
  paragraph.className = 'empty';
  paragraph.textContent = message;
  container.append(paragraph);
}

function setSettingsVisible(visible) {
  settingsOverlay.hidden = !visible;
  if (visible) serverUrlInput.focus();
}

function updateServerSummary() {
  const name = displayNameInput.value || usernameInput.value || 'Emby 服务器';
  const url = serverUrlInput.value || '点击添加服务器';
  serverName.textContent = window.qplayerToken ? name : '未连接服务器';
  serverMeta.textContent = window.qplayerToken ? url.replace(/^https?:\/\//, '') : url;
}

function updateNavigationControls() {
  backButton.disabled = navigationStack.length === 0;
}

function showHome() {
  currentLibraryId = '';
  titleEl.textContent = '首页';
  homeView.hidden = false;
  itemsEl.hidden = true;
  updateNavigationControls();
}

function applySearchFilter() {
  const query = searchInput.value.trim().toLowerCase();
  const cards = document.querySelectorAll('.media-card');
  for (const card of cards) {
    const haystack = card.dataset.search || '';
    card.hidden = query && !haystack.includes(query);
  }
}

function showLibrary(name) {
  titleEl.textContent = name;
  homeView.hidden = true;
  itemsEl.hidden = false;
  updateNavigationControls();
}

function formatRuntime(ticks) {
  if (!ticks) return '';
  const minutes = Math.round(ticks / 600000000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} 小时 ${rest} 分钟` : `${rest} 分钟`;
}

function episodeLabel(item) {
  const season = item.ParentIndexNumber ? `S${String(item.ParentIndexNumber).padStart(2, '0')}` : '';
  const episode = item.IndexNumber ? `E${String(item.IndexNumber).padStart(2, '0')}` : '';
  return season || episode ? `${season}:${episode}` : '';
}

function imageUrl(item, imageType = 'Primary', maxHeight = 480) {
  const serverUrl = serverUrlInput.value.replace(/\/+$/, '');
  const params = new URLSearchParams({ maxHeight: String(maxHeight) });
  const token = window.qplayerToken;
  if (token) params.set('api_key', token);

  if (imageType === 'Backdrop' && item.BackdropImageTags?.length) {
    params.set('tag', item.BackdropImageTags[0]);
    return `${serverUrl}/Items/${item.Id}/Images/Backdrop/0?${params}`;
  }

  if (imageType === 'Thumb' && item.ImageTags?.Thumb) {
    params.set('tag', item.ImageTags.Thumb);
    return `${serverUrl}/Items/${item.Id}/Images/Thumb?${params}`;
  }

  if (!item.ImageTags?.Primary) return '';
  params.set('tag', item.ImageTags.Primary);
  return `${serverUrl}/Items/${item.Id}/Images/Primary?${params}`;
}

function bestImageUrl(item, variant) {
  if (variant === 'poster') return imageUrl(item, 'Primary', 560);
  return imageUrl(item, 'Thumb', 360) || imageUrl(item, 'Backdrop', 360) || imageUrl(item, 'Primary', 360);
}

function itemMeta(item) {
  if (item.Type === 'Episode') {
    return [episodeLabel(item), item.SeriesName].filter(Boolean).join(' · ');
  }
  return [item.ProductionYear, formatRuntime(item.RunTimeTicks), item.Type].filter(Boolean).join(' · ');
}

function playbackPercent(item) {
  const runtime = item.RunTimeTicks || 0;
  const position = item.UserData?.PlaybackPositionTicks || 0;
  if (!runtime || !position) return 0;
  return Math.min(100, Math.round((position / runtime) * 100));
}

async function openItem(item, pushHistory = true) {
  const isContainer = CONTAINER_TYPES.has(item.Type);
  const isPlayable = PLAYABLE_TYPES.has(item.Type);

  if (isContainer) {
    await loadItems(item.Id, item.Name, pushHistory);
    return;
  }

  if (!isPlayable) return;
  setStatus(`正在调用 mpv：${item.Name}`);
  await window.qplayer.play(item);
  setStatus('已发送到播放器');
}

function createCard(item, variant = 'poster') {
  const node = itemTemplate.content.cloneNode(true);
  const card = node.querySelector('.media-card');
  const poster = node.querySelector('.poster');
  const heading = node.querySelector('h3');
  const meta = node.querySelector('p');
  const button = node.querySelector('button');
  const isContainer = CONTAINER_TYPES.has(item.Type);
  const isPlayable = PLAYABLE_TYPES.has(item.Type);
  const posterUrl = bestImageUrl(item, variant);
  const progress = playbackPercent(item);

  card.classList.add(`media-card-${variant}`);
  card.dataset.search = [item.Name, item.SeriesName, item.Type, item.ProductionYear].filter(Boolean).join(' ').toLowerCase();
  if (posterUrl) {
    poster.style.backgroundImage = `url("${posterUrl}")`;
  } else {
    poster.textContent = item.Name || item.Type || 'Media';
  }

  if (progress) {
    const bar = document.createElement('span');
    bar.className = 'progress-bar';
    bar.style.width = `${progress}%`;
    poster.append(bar);
  }

  heading.textContent = item.Name;
  meta.textContent = itemMeta(item);
  button.textContent = isContainer ? '打开' : '播放';
  button.disabled = !isContainer && !isPlayable;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    openItem(item);
  });
  card.tabIndex = 0;
  card.addEventListener('click', () => openItem(item));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openItem(item);
  });

  return node;
}

function createHero(item) {
  const hero = document.createElement('section');
  hero.className = 'hero';
  hero.dataset.search = [item.Name, item.SeriesName, item.Type, item.ProductionYear].filter(Boolean).join(' ').toLowerCase();

  const heroUrl = imageUrl(item, 'Backdrop', 900) || imageUrl(item, 'Thumb', 900) || imageUrl(item, 'Primary', 900);
  if (heroUrl) hero.style.backgroundImage = `url("${heroUrl}")`;

  const body = document.createElement('div');
  body.className = 'hero-body';

  const eyebrow = document.createElement('p');
  eyebrow.textContent = item.Type === 'Episode' ? '继续观看' : '推荐播放';

  const heading = document.createElement('h3');
  heading.textContent = item.Name || '媒体库';

  const meta = document.createElement('p');
  meta.textContent = itemMeta(item) || '准备开始播放';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = PLAYABLE_TYPES.has(item.Type) ? '继续播放' : '打开';
  button.addEventListener('click', () => openItem(item));

  body.append(eyebrow, heading, meta, button);
  hero.append(body);
  return hero;
}

function appendSection(title, items, variant) {
  if (!items.length) return;

  const node = sectionTemplate.content.cloneNode(true);
  const section = node.querySelector('.media-section');
  const heading = node.querySelector('h3');
  const rail = node.querySelector('.rail');

  section.classList.add(`media-section-${variant}`);
  heading.textContent = title;
  for (const item of items) {
    rail.append(createCard(item, variant));
  }
  homeView.append(node);
}

function renderHome(data) {
  homeView.replaceChildren();
  appendSection('我的媒体', data.libraries || [], 'library');
  updateServerSummary();
}

async function loadHomeSections(libraries, loadId) {
  window.qplayer.getResume()
    .then((items) => {
      if (loadId !== homeLoadId) return;
      if (items?.length) homeView.prepend(createHero(items[0]));
      appendSection('继续观看', items || [], 'landscape');
      applySearchFilter();
    })
    .catch(() => undefined);

  await Promise.allSettled((libraries || []).map(async (library) => {
    const section = await window.qplayer.getLatest(library);
    if (loadId !== homeLoadId || !section.items?.length) return;
    appendSection(`最新${section.library.Name}`, section.items, 'poster');
    applySearchFilter();
  }));

  if (loadId === homeLoadId) setStatus(`已连接：${usernameInput.value || 'Emby'}`);
}

function renderItems(items) {
  itemsEl.replaceChildren();

  if (!items.length) {
    renderError(itemsEl, '这个媒体库里还没有可播放项目。');
    return;
  }

  for (const item of items) {
    itemsEl.append(createCard(item, 'poster'));
  }
}

async function loadHome() {
  const loadId = ++homeLoadId;
  navigationStack = [];
  showHome();
  setStatus('正在读取首页...');
  try {
    const data = await window.qplayer.getHome();
    if (loadId !== homeLoadId) return;
    renderHome(data);
    setStatus('首页已加载，正在读取推荐内容...');
    loadHomeSections(data.libraries || [], loadId);
  } catch (error) {
    renderError(homeView, cleanErrorMessage(error, '首页读取失败，请检查 Emby 连接。'));
    setStatus('首页读取失败');
    setSettingsVisible(true);
  }
}

async function loadItems(parentId, name, pushHistory = false) {
  homeLoadId += 1;

  if (pushHistory) {
    navigationStack.push(currentLibraryId ? { id: currentLibraryId, name: titleEl.textContent } : { home: true });
  }

  currentLibraryId = parentId;
  showLibrary(name);
  setStatus('正在读取媒体...');
  try {
    const data = await window.qplayer.getItems(parentId);
    renderItems(data.Items || []);
    setStatus(`已加载 ${data.Items?.length || 0} 个项目`);
  } catch (error) {
    renderError(itemsEl, cleanErrorMessage(error, '媒体读取失败。'));
    setStatus('媒体读取失败');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('正在登录...');

  try {
    const result = await window.qplayer.login({
      serverUrl: serverUrlInput.value,
      username: usernameInput.value,
      password: passwordInput.value,
      playerPath: playerPathInput.value || 'mpv'
    });

    window.qplayerToken = result.config.accessToken || '';
    displayNameInput.value = displayNameInput.value || result.user?.Name || usernameInput.value;
    passwordInput.value = '';
    setSettingsVisible(false);
    updateServerSummary();
    await loadHome();
  } catch (error) {
    renderError(homeView, cleanErrorMessage(error, '登录失败，请检查 Emby 配置。'));
    setStatus('登录失败');
    setSettingsVisible(true);
  }
});

refreshButton.addEventListener('click', async () => {
  if (currentLibraryId) {
    await loadItems(currentLibraryId, titleEl.textContent);
  } else {
    await loadHome();
  }
});

backButton.addEventListener('click', async () => {
  const previous = navigationStack.pop();
  if (!previous) return;
  if (previous.home) {
    await loadHome();
    return;
  }
  await loadItems(previous.id, previous.name);
});

settingsButton.addEventListener('click', () => {
  setSettingsVisible(settingsOverlay.hidden);
});

addServerButton.addEventListener('click', () => setSettingsVisible(true));
footerSettingsButton.addEventListener('click', () => setSettingsVisible(true));
serverCard.addEventListener('click', () => setSettingsVisible(true));
cancelSettingsButton.addEventListener('click', () => setSettingsVisible(false));
settingsOverlay.addEventListener('click', (event) => {
  if (event.target === settingsOverlay) setSettingsVisible(false);
});
searchInput.addEventListener('input', applySearchFilter);

window.addEventListener('DOMContentLoaded', async () => {
  const config = await window.qplayer.getConfig();
  serverUrlInput.value = config.serverUrl || '';
  usernameInput.value = config.username || '';
  displayNameInput.value = config.username || '';
  playerPathInput.value = config.playerPath || 'mpv';
  window.qplayerToken = config.accessToken || '';
  updateServerSummary();

  if (config.accessToken && config.userId) {
    setSettingsVisible(false);
    await loadHome();
  } else {
    setSettingsVisible(true);
  }
});
