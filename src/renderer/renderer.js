const form = document.querySelector('#loginForm');
const serverUrlInput = document.querySelector('#serverUrl');
const displayNameInput = document.querySelector('#displayName');
const usernameInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');
const playerPathInput = document.querySelector('#playerPath');
const settingsOverlay = document.querySelector('#settingsOverlay');
const homeView = document.querySelector('#homeView');
const itemsEl = document.querySelector('#items');
const detailView = document.querySelector('#detailView');
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

document.body.dataset.platform = window.qplayer.platform;

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
  detailView.hidden = true;
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
  detailView.hidden = true;
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

function personImageUrl(person, maxHeight = 360) {
  if (!person?.Id || !person.PrimaryImageTag) return '';
  const serverUrl = serverUrlInput.value.replace(/\/+$/, '');
  const params = new URLSearchParams({
    maxHeight: String(maxHeight),
    tag: person.PrimaryImageTag
  });
  const token = window.qplayerToken;
  if (token) params.set('api_key', token);
  return `${serverUrl}/Items/${person.Id}/Images/Primary?${params}`;
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
  await showDetail(item, pushHistory);
}

async function playItem(item) {
  setStatus(`正在打开播放窗口：${item.Name}`);
  const result = await window.qplayer.play(item);
  if (result.mode === 'system') {
    setStatus(result.message ? `${result.message}，已用系统打开视频流` : 'mpv 启动失败，已用系统打开视频流');
    return;
  }
  setStatus('已打开 mpv 播放窗口');
}

function pushCurrentView() {
  navigationStack.push(currentLibraryId ? { id: currentLibraryId, name: titleEl.textContent } : { home: true });
}

function showDetailView(title) {
  titleEl.textContent = title || '详情';
  homeView.hidden = true;
  itemsEl.hidden = true;
  detailView.hidden = false;
  updateNavigationControls();
}

function addText(parent, tagName, text, className = '') {
  if (!text) return null;
  const node = document.createElement(tagName);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function detailMeta(item) {
  const date = item.PremiereDate || item.DateCreated;
  const year = item.ProductionYear || (date ? new Date(date).getFullYear() : '');
  const rating = item.CommunityRating ? `★ ${Number(item.CommunityRating).toFixed(1)}` : '';
  return [
    rating,
    year,
    item.OfficialRating,
    formatRuntime(item.RunTimeTicks),
    item.Genres?.slice(0, 3).join(' / ')
  ].filter(Boolean).join(' · ');
}

function mediaSourceTitle(source) {
  const video = source.MediaStreams?.find((stream) => stream.Type === 'Video');
  const audio = source.MediaStreams?.find((stream) => stream.Type === 'Audio');
  const resolution = video?.Width && video?.Height ? `${video.Width}x${video.Height}` : source.Name;
  return [resolution, video?.DisplayTitle, audio?.DisplayTitle].filter(Boolean).join(' · ');
}

function createInfoBlock(title, lines) {
  const block = document.createElement('article');
  block.className = 'info-block';
  addText(block, 'h4', title);
  for (const line of lines.filter(Boolean)) {
    addText(block, 'p', line);
  }
  return block;
}

function renderExternalLinks(container, item) {
  const links = [];
  const ids = item.ProviderIds || {};
  if (ids.Imdb) links.push(['IMDb', `https://www.imdb.com/title/${ids.Imdb}`]);
  if (ids.Tmdb) links.push(['TheMovieDb', `https://www.themoviedb.org/${item.Type === 'Series' ? 'tv' : 'movie'}/${ids.Tmdb}`]);
  if (ids.Tvdb) links.push(['TVDb', `https://thetvdb.com/dereferrer/series/${ids.Tvdb}`]);
  for (const link of item.ExternalUrls || []) {
    if (link.Name && link.Url) links.push([link.Name, link.Url]);
  }
  if (!links.length) return;

  const section = document.createElement('section');
  section.className = 'detail-section';
  addText(section, 'h3', '外部链接');
  const list = document.createElement('div');
  list.className = 'external-links';
  for (const [label, url] of links) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = label;
    list.append(anchor);
  }
  section.append(list);
  container.append(section);
}

function renderPeople(container, people = []) {
  const actors = people.filter((person) => person.Type === 'Actor').slice(0, 12);
  if (!actors.length) return;

  const section = document.createElement('section');
  section.className = 'detail-section';
  addText(section, 'h3', '演职人员');
  const grid = document.createElement('div');
  grid.className = 'people-grid';

  for (const person of actors) {
    const card = document.createElement('article');
    card.className = 'person-card';
    const photo = document.createElement('div');
    photo.className = 'person-photo';
    const url = personImageUrl(person);
    if (url) photo.style.backgroundImage = `url("${url}")`;
    else photo.textContent = person.Name?.slice(0, 1) || '?';
    const name = addText(card, 'strong', person.Name);
    const role = addText(card, 'span', person.Role);
    card.prepend(photo);
    if (!name && !role) addText(card, 'strong', '未知演员');
    grid.append(card);
  }

  section.append(grid);
  container.append(section);
}

function renderMediaInfo(container, item) {
  const sources = item.MediaSources || [];
  if (!sources.length) return;

  const section = document.createElement('section');
  section.className = 'detail-section';
  addText(section, 'h3', '媒体信息');
  const summary = sources[0];
  addText(section, 'p', [
    mediaSourceTitle(summary),
    summary.Container?.toUpperCase(),
    summary.Size ? `${(summary.Size / 1024 / 1024 / 1024).toFixed(2)} GB` : '',
    summary.Bitrate ? `${(summary.Bitrate / 1000000).toFixed(1)} Mbps` : ''
  ].filter(Boolean).join(' · '), 'detail-muted');

  const rail = document.createElement('div');
  rail.className = 'stream-rail';
  for (const source of sources) {
    for (const stream of source.MediaStreams || []) {
      const lines = [
        `类型：${stream.Type}`,
        stream.DisplayTitle && `显示标题：${stream.DisplayTitle}`,
        stream.Codec && `编码器：${stream.Codec}`,
        stream.Language && `语言：${stream.Language}`,
        stream.Width && stream.Height && `尺寸：${stream.Width}x${stream.Height}`,
        stream.BitRate && `码率：${(stream.BitRate / 1000).toFixed(0)} Kbps`,
        stream.ColorSpace && `色彩空间：${stream.ColorSpace}`,
        stream.VideoRange && `动态范围：${stream.VideoRange}`,
        stream.IsDefault !== undefined && `默认：${stream.IsDefault}`,
        stream.IsExternal !== undefined && `外部：${stream.IsExternal}`
      ];
      rail.append(createInfoBlock(stream.DisplayTitle || stream.Type, lines));
    }
  }
  section.append(rail);
  container.append(section);
}

async function showDetail(item, pushHistory = true) {
  if (pushHistory) pushCurrentView();
  updateNavigationControls();
  showDetailView(item.Name);
  detailView.replaceChildren();
  renderError(detailView, '正在读取详情...');
  setStatus('正在读取详情...');

  try {
    const detail = await window.qplayer.getItem(item.Id);
    detailView.replaceChildren();
    showDetailView(detail.Name || item.Name);

    const header = document.createElement('section');
    header.className = 'detail-hero';
    const backdrop = imageUrl(detail, 'Backdrop', 1200) || imageUrl(detail, 'Thumb', 1200) || imageUrl(detail, 'Primary', 1200);
    if (backdrop) header.style.backgroundImage = `url("${backdrop}")`;

    const body = document.createElement('div');
    body.className = 'detail-hero-body';
    addText(body, 'h2', detail.Name || item.Name);
    addText(body, 'p', detailMeta(detail), 'detail-meta');
    addText(body, 'p', detail.Overview, 'detail-overview');
    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.textContent = playbackPercent(detail) ? '继续播放' : '播放';
    playButton.addEventListener('click', () => playItem(detail));
    body.append(playButton);
    header.append(body);
    detailView.append(header);

    const studios = detail.Studios?.map((studio) => studio.Name).filter(Boolean).join('，');
    if (studios) {
      const section = document.createElement('section');
      section.className = 'detail-section';
      addText(section, 'h3', '工作室');
      addText(section, 'p', studios, 'detail-muted');
      detailView.append(section);
    }

    renderExternalLinks(detailView, detail);
    renderPeople(detailView, detail.People || []);
    renderMediaInfo(detailView, detail);
    setStatus('详情已加载');
  } catch (error) {
    renderError(detailView, cleanErrorMessage(error, '详情读取失败。'));
    setStatus('详情读取失败');
  }
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
  button.textContent = isContainer ? '打开' : '详情';
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
  button.addEventListener('click', () => PLAYABLE_TYPES.has(item.Type) ? playItem(item) : openItem(item));

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
