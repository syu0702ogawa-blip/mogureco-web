'use strict';

const DB_NAME = 'gaishoku-reco-db';
const DB_VERSION = 1;
const STORE_NAME = 'records';
const DEFAULT_CENTER = [43.0618, 141.3545];
const MAX_PHOTOS = 10;
const GOOGLE_API_KEY_STORAGE = 'gaishoku-reco-google-api-key';
const GOOGLE_PHOTOS_ENABLED_STORAGE = 'gaishoku-reco-google-photos-enabled';
const GEOLONIA_GEOCODER_URL = 'https://cdn.geolonia.com/community-geocoder.js';
const {
  coordinatesFromValues,
  recordCoordinates,
  googleMapsUrl,
  normalizeRecordCoordinates,
} = window.LocationUtils;

const state = {
  db: null,
  records: [],
  currentView: 'timeline',
  filter: 'all',
  query: '',
  tagFilter: '',
  selectedPhotos: [],
  editingId: null,
  map: null,
  mapLayer: null,
  detailMap: null,
  deferredInstallPrompt: null,
  galleryIndex: 0,
  googleMapsPromise: null,
  googlePhotoRequests: new Map(),
  googlePlaceRequests: new Map(),
  googlePhotoObserver: null,
  googlePhotoErrorShown: false,
  communityGeocoderPromise: null,
  geocodingInProgress: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function uid() {
  return (crypto.randomUUID?.() || `rec-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

function normalizeText(value = '') {
  return String(value).normalize('NFKC').toLowerCase().trim();
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value || '').split(/[,、，\n]/).map(v => v.trim()).filter(Boolean);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(dateString) {
  if (!dateString) return '日付なし';
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateString;
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

function monthKey(dateString) {
  if (!dateString) return '日付なし';
  const d = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '日付なし';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  if (key === '日付なし') return key;
  const [y, m] = key.split('-');
  return `${y}年${Number(m)}月`;
}

function statusLabel(status) {
  return status === 'wishlist' ? '行きたい' : '行った';
}

function formatPrice(value) {
  if (!value) return '未登録';
  const number = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) && number > 0 ? `${Math.round(number).toLocaleString('ja-JP')}円` : String(value);
}

function starText(rating) {
  const n = Math.max(0, Math.min(5, Number(rating) || 0));
  return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '評価なし';
}

function showToast(message, duration = 2600) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function getGoogleApiKey() {
  return localStorage.getItem(GOOGLE_API_KEY_STORAGE)?.trim() || '';
}

function googleMapsConfigured() {
  return Boolean(getGoogleApiKey());
}

function googlePhotosEnabled() {
  return localStorage.getItem(GOOGLE_PHOTOS_ENABLED_STORAGE) === '1' && googleMapsConfigured();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

async function updateStorageStatus() {
  const box = $('#storageStatus');
  const button = $('#requestPersistenceButton');
  if (!box) return;
  const origin = location.protocol === 'file:' ? 'ローカルファイル（非推奨）' : location.origin;
  if (!navigator.storage) {
    box.textContent = `保存先：IndexedDB / URL：${origin} / 保存状態の詳細取得には未対応です。`;
    button?.classList.add('hidden');
    return;
  }
  try {
    const [persisted, estimate] = await Promise.all([
      navigator.storage.persisted?.() ?? Promise.resolve(false),
      navigator.storage.estimate?.() ?? Promise.resolve({}),
    ]);
    const usage = Number(estimate.usage) || 0;
    const quota = Number(estimate.quota) || 0;
    box.innerHTML = `<strong>${persisted ? '固定保存済み' : '通常保存'}</strong><span>使用量：${formatBytes(usage)}${quota ? ` / 上限目安：${formatBytes(quota)}` : ''}</span><span>URL：${escapeHtml(origin)}</span>`;
    if (button) {
      button.textContent = persisted ? '保存領域は固定済みです' : '保存領域を固定する';
      button.disabled = Boolean(persisted);
    }
  } catch (error) {
    console.error(error);
    box.textContent = `保存先：IndexedDB / URL：${origin}`;
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    showToast('このブラウザーは固定保存に対応していません');
    return;
  }
  try {
    const granted = await navigator.storage.persist();
    await updateStorageStatus();
    showToast(granted ? '保存領域を固定しました' : '固定保存は許可されませんでした。通常保存は継続されます', 4200);
  } catch (error) {
    console.error(error);
    showToast('保存状態を変更できませんでした');
  }
}

function updateGoogleSettingsUi() {
  const keyInput = $('#googleApiKeyInput');
  const enabledInput = $('#googlePhotosEnabledInput');
  const status = $('#googlePhotoStatus');
  if (!keyInput || !enabledInput || !status) return;
  const key = getGoogleApiKey();
  keyInput.value = key;
  enabledInput.checked = googlePhotosEnabled();
  status.textContent = key
    ? (enabledInput.checked
      ? '有効です。店舗画像の表示と、住所・店名からの位置取得にGoogle Placesを使用します。'
      : 'APIキーは保存済みです。画像表示は無効ですが、位置取得にはGoogle Placesを使用します。')
    : '未設定です。位置取得は無料の日本住所ジオコーダーへ切り替わり、町丁目付近の概算位置になる場合があります。';
}

function saveGoogleSettings() {
  const key = $('#googleApiKeyInput').value.trim();
  const enabled = $('#googlePhotosEnabledInput').checked;
  if (enabled && !key) {
    showToast('Google Maps APIキーを入力してください');
    return;
  }
  if (key) localStorage.setItem(GOOGLE_API_KEY_STORAGE, key);
  else localStorage.removeItem(GOOGLE_API_KEY_STORAGE);
  localStorage.setItem(GOOGLE_PHOTOS_ENABLED_STORAGE, enabled && key ? '1' : '0');
  showToast('Google Mapsの設定を保存しました');
  setTimeout(() => location.reload(), 450);
}

function clearGoogleSettings() {
  localStorage.removeItem(GOOGLE_API_KEY_STORAGE);
  localStorage.removeItem(GOOGLE_PHOTOS_ENABLED_STORAGE);
  showToast('Google Mapsの設定を削除しました');
  setTimeout(() => location.reload(), 450);
}

function loadGoogleMapsApi() {
  if (!googleMapsConfigured()) return Promise.reject(new Error('Google Maps APIキーが未設定です'));
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  if (state.googleMapsPromise) return state.googleMapsPromise;
  const key = getGoogleApiKey();
  state.googleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = '__gaishokuRecoGoogleMapsReady';
    const timeout = setTimeout(() => reject(new Error('Google Maps APIの読み込みがタイムアウトしました')), 15000);
    window[callbackName] = () => {
      clearTimeout(timeout);
      delete window[callbackName];
      resolve(window.google.maps);
    };
    const script = document.createElement('script');
    script.id = 'googleMapsApiScript';
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&libraries=places&language=ja&region=JP&v=weekly&callback=${callbackName}`;
    script.onerror = () => {
      clearTimeout(timeout);
      delete window[callbackName];
      reject(new Error('Google Maps APIを読み込めませんでした'));
    };
    document.head.appendChild(script);
  }).catch(error => {
    // A temporary loading failure must not poison every later geocoding request.
    state.googleMapsPromise = null;
    document.querySelector('#googleMapsApiScript')?.remove();
    throw error;
  });
  return state.googleMapsPromise;
}

function coordinatesFromGoogleLocation(location) {
  if (!location) return null;
  const lat = typeof location.lat === 'function' ? location.lat() : location.lat;
  const lng = typeof location.lng === 'function' ? location.lng() : location.lng;
  return coordinatesFromValues(lat, lng);
}

async function fetchGooglePlace(record) {
  if (!googleMapsConfigured()) return null;
  const textQuery = [record?.name, record?.address].filter(Boolean).join(' ').trim();
  if (!textQuery) return null;
  const cacheKey = [record?.id || '', record?.updatedAt || '', textQuery].join('|');
  if (state.googlePlaceRequests.has(cacheKey)) return state.googlePlaceRequests.get(cacheKey);

  const promise = (async () => {
    await loadGoogleMapsApi();
    const { Place } = await google.maps.importLibrary('places');
    const request = {
      textQuery,
      fields: ['id', 'displayName', 'formattedAddress', 'location', 'photos', 'googleMapsURI'],
      language: 'ja',
      region: 'jp',
      maxResultCount: 1,
    };
    const coords = recordCoordinates(record);
    if (coords) request.locationBias = coords;
    const { places = [] } = await Place.searchByText(request);
    return places[0] || null;
  })().catch(error => {
    console.error('Google place search error:', error);
    return null;
  });

  state.googlePlaceRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    // Deduplicate concurrent calls only; later attempts must recover from transient failures.
    state.googlePlaceRequests.delete(cacheKey);
  }
}

function googlePhotoAttribution(photo, place) {
  const authors = (photo.authorAttributions || []).map(author => ({
    name: author.displayName || '投稿者',
    uri: author.uri || '',
  }));
  return {
    authors,
    googleMapsUri: photo.googleMapsURI || place.googleMapsURI || '',
  };
}

function googlePhotoCreditHtml(data) {
  const authorParts = data.authors.map(author => author.uri
    ? `<a href="${escapeHtml(author.uri)}" target="_blank" rel="noopener" title="写真提供者をGoogleマップで開く">写真：${escapeHtml(author.name)}</a>`
    : `<span>写真：${escapeHtml(author.name)}</span>`);
  const googlePart = data.googleMapsUri
    ? `<a href="${escapeHtml(data.googleMapsUri)}" target="_blank" rel="noopener">Google</a>`
    : '<span>Google</span>';
  return `<div class="google-photo-credit">${authorParts.length ? `${authorParts.join('、')} · ` : ''}${googlePart}</div>`;
}

async function fetchGooglePhoto(record) {
  if (!googlePhotosEnabled() || record.photos?.length) return null;
  if (state.googlePhotoRequests.has(record.id)) return state.googlePhotoRequests.get(record.id);
  const promise = (async () => {
    const place = await fetchGooglePlace(record);
    const photo = place?.photos?.[0];
    if (!photo) return null;
    return {
      url: photo.getURI({ maxWidth: 1000, maxHeight: 750 }),
      alt: `${record.name}のGoogle店舗画像`,
      ...googlePhotoAttribution(photo, place),
    };
  })().catch(error => {
    console.error('Google photo error:', error);
    if (!state.googlePhotoErrorShown) {
      state.googlePhotoErrorShown = true;
      showToast('Google画像を取得できませんでした。APIキーの設定と利用制限を確認してください', 5000);
    }
    return null;
  });
  state.googlePhotoRequests.set(record.id, promise);
  try {
    return await promise;
  } finally {
    state.googlePhotoRequests.delete(record.id);
  }
}

async function hydrateGooglePhotoTarget(target) {
  if (!target || target.dataset.googlePhotoState) return;
  const record = state.records.find(item => item.id === target.dataset.googlePhotoRecord);
  if (!record || record.photos?.length) return;
  target.dataset.googlePhotoState = 'loading';
  const media = target.querySelector('.card-media, .detail-media');
  media?.classList.add('is-loading');
  const data = await fetchGooglePhoto(record);
  media?.classList.remove('is-loading');
  if (!data || !media || !target.isConnected) {
    target.dataset.googlePhotoState = 'empty';
    return;
  }
  media.innerHTML = `<img src="${escapeHtml(data.url)}" alt="${escapeHtml(data.alt)}" loading="lazy">${googlePhotoCreditHtml(data)}`;
  target.dataset.googlePhotoState = 'loaded';
}

function observeGooglePhotoTargets(root = document) {
  if (!googlePhotosEnabled()) return;
  const targets = $$('[data-google-photo-record]', root).filter(target => !target.dataset.googlePhotoState);
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    targets.forEach(target => void hydrateGooglePhotoTarget(target));
    return;
  }
  if (!state.googlePhotoObserver) {
    state.googlePhotoObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        state.googlePhotoObserver.unobserve(entry.target);
        void hydrateGooglePhotoTarget(entry.target);
      });
    }, { rootMargin: '240px 0px' });
  }
  targets.forEach(target => state.googlePhotoObserver.observe(target));
}

function confirmAction(title, message, okLabel = '実行') {
  return new Promise(resolve => {
    const dialog = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    $('#confirmOk').textContent = okLabel;
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const dbGetAll = () => dbRequest('readonly', store => store.getAll());
const dbPut = record => dbRequest('readwrite', store => store.put(record));
const dbDelete = id => dbRequest('readwrite', store => store.delete(id));
const dbClear = () => dbRequest('readwrite', store => store.clear());

async function refreshRecords() {
  state.records = await dbGetAll();
  state.records.sort((a, b) => {
    const dateA = a.date || '0000-00-00';
    const dateB = b.date || '0000-00-00';
    return dateB.localeCompare(dateA) || (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  renderTimeline();
  updateStats();
  if (state.currentView === 'map') renderMapMarkers();
}

function updateStats() {
  $('#statAll').textContent = state.records.length;
  $('#statVisited').textContent = state.records.filter(r => r.status !== 'wishlist').length;
  $('#statWishlist').textContent = state.records.filter(r => r.status === 'wishlist').length;
}

function filteredRecords() {
  const query = normalizeText(state.query);
  return state.records.filter(record => {
    if (state.filter !== 'all' && record.status !== state.filter) return false;
    if (state.tagFilter && !(record.tags || []).some(tag => normalizeText(tag) === normalizeText(state.tagFilter))) return false;
    if (!query) return true;
    const haystack = normalizeText([
      record.name, record.address, record.memo, record.category, record.price,
      ...(record.tags || [])
    ].filter(Boolean).join(' '));
    return haystack.includes(query);
  });
}

function renderTimeline() {
  const container = $('#timelineContainer');
  const records = filteredRecords();
  const active = $('#activeTagFilter');
  if (state.tagFilter) {
    active.classList.remove('hidden');
    active.innerHTML = `<span>タグ：${escapeHtml(state.tagFilter)}</span><button type="button" aria-label="タグ絞り込みを解除">×</button>`;
    active.querySelector('button').addEventListener('click', () => { state.tagFilter = ''; renderTimeline(); });
  } else {
    active.classList.add('hidden');
  }

  if (!records.length) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM8 3v4M16 3v4M4 9h16"/></svg>
        <h3>${state.records.length ? '該当する記録がありません' : '最初の店を登録してください'}</h3>
        <p>${state.records.length ? '検索条件や区分を変更してください。' : '店名、写真、評価、タグ、メモを残し、あとから検索できます。'}</p>
        ${state.records.length ? '' : '<button class="primary-button empty-add" type="button">店を登録</button>'}
      </div>`;
    $('.empty-add')?.addEventListener('click', () => openRecordDialog());
    return;
  }

  const groups = new Map();
  records.forEach(record => {
    const key = monthKey(record.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });

  container.innerHTML = [...groups.entries()].map(([key, group]) => `
    <section class="month-group">
      <div class="month-heading"><h3>${monthLabel(key)}</h3><span>${group.length}件</span></div>
      <div class="record-grid">
        ${group.map(recordCardHtml).join('')}
      </div>
    </section>
  `).join('');

  $$('.record-card', container).forEach(card => {
    card.addEventListener('click', event => {
      if (event.target.closest('a, .tag-chip')) return;
      openDetail(card.dataset.id);
    });
    card.addEventListener('keydown', event => {
      if (event.target.closest('a, .tag-chip')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail(card.dataset.id);
      }
    });
  });
  $$('.tag-chip', container).forEach(chip => chip.addEventListener('click', event => {
    event.stopPropagation();
    state.tagFilter = chip.dataset.tag;
    renderTimeline();
  }));
  observeGooglePhotoTargets(container);
}

function recordCardHtml(record) {
  const photo = record.photos?.[0]?.dataUrl;
  const photoCount = record.photos?.length || 0;
  const googleAttr = !photo && googlePhotosEnabled() ? ` data-google-photo-record="${escapeHtml(record.id)}"` : '';
  return `
    <article class="record-card" data-id="${escapeHtml(record.id)}" role="button" tabindex="0">
      <div class="card-image"${googleAttr}>
        <div class="card-media">${photo ? `<img src="${photo}" alt="${escapeHtml(record.name)}の写真" loading="lazy">` : `<div class="placeholder"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 14l3-3 3 3 2-2 4 4M8.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>${googlePhotosEnabled() ? '<span>店舗画像を取得</span>' : ''}</div>`}</div>
        <span class="status-badge ${record.status === 'wishlist' ? 'wishlist' : 'visited'}">${statusLabel(record.status)}</span>
        ${photoCount > 1 ? `<span class="photo-count">${photoCount}枚</span>` : ''}
      </div>
      <div class="card-body">
        <h4 class="card-title">${escapeHtml(record.name)}</h4>
        <div class="card-meta"><span>${escapeHtml(record.category || formatDate(record.date))}</span><span class="rating">${Number(record.rating) ? '★'.repeat(Number(record.rating)) : '—'}</span></div>
        ${(record.tags || []).length ? `<div class="tag-row">${record.tags.slice(0, 3).map(tag => `<span class="tag-chip" role="button" tabindex="0" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      </div>
    </article>`;
}

function setView(view) {
  state.currentView = view;
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `${view}View`));
  $$('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $('#addButton').classList.toggle('hidden', view === 'settings');
  if (view === 'map') {
    setTimeout(() => {
      initMap();
      state.map.invalidateSize();
      renderMapMarkers();
    }, 30);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initMap() {
  if (state.map) return;
  state.map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);
  state.mapLayer = L.layerGroup().addTo(state.map);
}

function markerIcon(status) {
  return L.divIcon({
    className: '',
    html: `<div class="custom-marker ${status === 'wishlist' ? 'wishlist' : ''}"><div class="marker-inner">${status === 'wishlist' ? '行' : '済'}</div></div>`,
    iconSize: [32, 32], iconAnchor: [16, 31], popupAnchor: [0, -30]
  });
}

function renderMapMarkers() {
  if (!state.map || !state.mapLayer) return;
  state.mapLayer.clearLayers();
  const plotted = state.records
    .map(record => ({ record, coords: recordCoordinates(record) }))
    .filter(item => item.coords);

  plotted.forEach(({ record, coords }) => {
    const marker = L.marker([coords.lat, coords.lng], { icon: markerIcon(record.status) });
    marker.bindPopup(`<div class="map-popup"><h4>${escapeHtml(record.name)}</h4><p>${escapeHtml(record.address || statusLabel(record.status))}</p><button type="button" data-map-record="${escapeHtml(record.id)}">詳細を見る</button></div>`);
    marker.on('popupopen', event => {
      const button = event.popup.getElement()?.querySelector('[data-map-record]');
      button?.addEventListener('click', () => openDetail(record.id), { once: true });
    });
    marker.addTo(state.mapLayer);
  });

  const notice = $('#mapNotice');
  const repairButton = $('#repairLocationsButton');
  const missing = state.records.filter(record => !recordCoordinates(record));
  const repairable = missing.filter(record => record.address);
  const locationProvider = googleMapsConfigured() ? 'Google Places' : '無料住所検索（町丁目の概算位置）';
  if (missing.length > 0) {
    notice.textContent = repairable.length
      ? `位置を取得できていない記録が${missing.length}件あります。住所がある${repairable.length}件は「位置を取得」で補完できます。使用：${locationProvider}`
      : `位置を取得できていない記録が${missing.length}件あります。住所を登録してください。`;
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }
  if (repairButton) {
    repairButton.classList.toggle('hidden', repairable.length === 0);
    repairButton.disabled = state.geocodingInProgress;
  }

  if (plotted.length) {
    const bounds = L.latLngBounds(plotted.map(item => [item.coords.lat, item.coords.lng]));
    state.map.fitBounds(bounds, { padding: [45, 45], maxZoom: 15 });
  } else {
    state.map.setView(DEFAULT_CENTER, 12);
  }
}

async function repairMissingCoordinates() {
  if (state.geocodingInProgress) return;
  const targets = state.records.filter(record => !recordCoordinates(record) && record.address);
  if (!targets.length) {
    showToast('位置を取得できる記録はありません');
    return;
  }

  state.geocodingInProgress = true;
  const button = $('#repairLocationsButton');
  const notice = $('#mapNotice');
  if (button) button.disabled = true;
  let repaired = 0;
  let exact = 0;
  let approximate = 0;
  let failed = 0;

  try {
    for (let index = 0; index < targets.length; index++) {
      const record = targets[index];
      if (notice) {
        notice.textContent = `住所から位置を取得しています（${index + 1}/${targets.length}）：${record.name}`;
        notice.classList.remove('hidden');
      }
      const coords = await geocodeAddress(record.address, record.name);
      if (coords) {
        await dbPut({
          ...record,
          lat: coords.lat,
          lng: coords.lng,
          locationSource: coords.source || record.locationSource || '',
          locationAccuracy: coords.accuracy || record.locationAccuracy || '',
        });
        repaired++;
        if (coords.source === 'google') exact++;
        else approximate++;
      } else {
        failed++;
      }
      if (index < targets.length - 1) await wait(150);
    }
    await refreshRecords();
    const breakdown = [exact ? `Google：${exact}件` : '', approximate ? `概算：${approximate}件` : ''].filter(Boolean).join('、');
    showToast(`位置を${repaired}件取得しました${breakdown ? `（${breakdown}）` : ''}${failed ? `／取得不可：${failed}件` : ''}`, 6500);
  } finally {
    state.geocodingInProgress = false;
    if (button) button.disabled = false;
    renderMapMarkers();
  }
}

function resetRecordForm() {
  $('#recordForm').reset();
  $('#recordId').value = '';
  $('#ratingInput').value = '0';
  $('#latInput').value = '';
  $('#lngInput').value = '';
  $('#dateInput').value = new Date().toISOString().slice(0, 10);
  state.selectedPhotos = [];
  state.editingId = null;
  updateRatingButtons();
  renderPhotoPreview();
  $('#placeSearchResults').classList.add('hidden');
  $('#placeSearchResults').innerHTML = '';
}

function openRecordDialog(record = null) {
  resetRecordForm();
  if (record) {
    state.editingId = record.id;
    $('#recordDialogTitle').textContent = '記録を編集';
    $('#recordId').value = record.id;
    $('#nameInput').value = record.name || '';
    $('#addressInput').value = record.address || '';
    $('#statusInput').value = record.status || 'visited';
    $('#dateInput').value = record.date || '';
    $('#categoryInput').value = record.category || '';
    $('#priceInput').value = record.price || '';
    $('#tagsInput').value = (record.tags || []).join(', ');
    $('#memoInput').value = record.memo || '';
    $('#ratingInput').value = record.rating || 0;
    $('#latInput').value = record.lat ?? '';
    $('#lngInput').value = record.lng ?? '';
    state.selectedPhotos = structuredClone(record.photos || []);
    updateRatingButtons();
    renderPhotoPreview();
  } else {
    $('#recordDialogTitle').textContent = '店を登録';
  }
  $('#recordDialog').showModal();
  setTimeout(() => $('#nameInput').focus(), 50);
}

function closeRecordDialog() {
  $('#recordDialog').close();
}

function updateRatingButtons() {
  const rating = Number($('#ratingInput').value || 0);
  $$('#ratingButtons button[data-rating]').forEach(button => button.classList.toggle('on', Number(button.dataset.rating) <= rating));
}

function renderPhotoPreview() {
  const preview = $('#photoPreview');
  preview.innerHTML = state.selectedPhotos.map((photo, index) => `
    <div class="photo-item"><img src="${photo.dataUrl}" alt="選択した写真 ${index + 1}"><button type="button" data-photo-index="${index}" aria-label="写真を削除">×</button></div>
  `).join('');
  $$('[data-photo-index]', preview).forEach(button => button.addEventListener('click', () => {
    state.selectedPhotos.splice(Number(button.dataset.photoIndex), 1);
    renderPhotoPreview();
  }));
}

function fileToCompressedDataUrl(file, maxDimension = 1600, quality = .82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDimension / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handlePhotos(files) {
  const available = MAX_PHOTOS - state.selectedPhotos.length;
  const selected = [...files].slice(0, available);
  if (!selected.length) return;
  showToast('写真を処理しています');
  for (const file of selected) {
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      state.selectedPhotos.push({ name: file.name, type: 'image/jpeg', dataUrl });
    } catch (error) {
      console.error(error);
      showToast(`${file.name}を読み込めませんでした`);
    }
  }
  renderPhotoPreview();
  if ([...files].length > available) showToast(`写真は最大${MAX_PHOTOS}枚です`);
}

async function searchPlaces(query, near = null) {
  const resultsBox = $('#placeSearchResults');
  resultsBox.classList.remove('hidden');
  resultsBox.innerHTML = '<div class="place-result"><strong>検索中...</strong></div>';
  try {
    let url;
    if (near) {
      const [lat, lon] = near;
      const delta = 0.006;
      const viewbox = `${lon - delta},${lat + delta},${lon + delta},${lat - delta}`;
      url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&accept-language=ja&countrycodes=jp&bounded=1&viewbox=${encodeURIComponent(viewbox)}&q=${encodeURIComponent(query || 'restaurant')}`;
    } else {
      url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&accept-language=ja&countrycodes=jp&q=${encodeURIComponent(query)}`;
    }
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.length) {
      resultsBox.innerHTML = '<div class="place-result"><strong>候補が見つかりませんでした</strong><span>店名や地域名を変えてください。</span></div>';
      return;
    }
    resultsBox.innerHTML = data.map((place, index) => {
      const parts = place.display_name?.split(',') || [];
      const name = place.name || parts[0] || '名称不明';
      return `<button class="place-result" type="button" data-place-index="${index}"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(place.display_name || '')}</span></button>`;
    }).join('');
    $$('[data-place-index]', resultsBox).forEach(button => button.addEventListener('click', () => {
      const place = data[Number(button.dataset.placeIndex)];
      const parts = place.display_name?.split(',') || [];
      $('#nameInput').value = place.name || parts[0] || '';
      $('#addressInput').value = place.display_name || '';
      $('#latInput').value = place.lat || '';
      $('#lngInput').value = place.lon || '';
      resultsBox.classList.add('hidden');
      showToast('店名と住所を入力しました');
    }));
  } catch (error) {
    console.error(error);
    resultsBox.innerHTML = '<div class="place-result"><strong>店舗検索に失敗しました</strong><span>通信状態を確認し、店名と住所を手入力してください。</span></div>';
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('位置情報に対応していません'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve([pos.coords.latitude, pos.coords.longitude]),
      reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function normalizeAddressForGeocoding(address) {
  return String(address || '')
    .normalize('NFKC')
    .replace(/^〒?\d{3}-?\d{4}\s*/, '')
    .replace(/^日本[、,]?\s*/, '')
    .replace(/[‐‑‒–—―ー−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadCommunityGeocoder() {
  if (typeof window.getLatLng === 'function') return Promise.resolve(window.getLatLng);
  if (state.communityGeocoderPromise) return state.communityGeocoderPromise;
  state.communityGeocoderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GEOLONIA_GEOCODER_URL;
    script.async = true;
    script.onload = () => typeof window.getLatLng === 'function'
      ? resolve(window.getLatLng)
      : reject(new Error('日本住所ジオコーダーを初期化できませんでした'));
    script.onerror = () => reject(new Error('日本住所ジオコーダーを読み込めませんでした'));
    document.head.appendChild(script);
  }).catch(error => {
    // Allow a retry after a transient CDN or network failure.
    state.communityGeocoderPromise = null;
    throw error;
  });
  return state.communityGeocoderPromise;
}

async function geocodeWithGoogle(address, name = '') {
  if (!googleMapsConfigured()) return null;
  let place = await fetchGooglePlace({
    id: `geocode:${normalizeText(name)}:${normalizeText(address)}`,
    name,
    address,
    updatedAt: '',
  });
  // A decorated/old shop name can make the combined query fail; an address-only
  // query is a safer second attempt and still returns an exact Places location.
  if (!place && name) {
    place = await fetchGooglePlace({
      id: `geocode-address:${normalizeText(address)}`,
      name: '',
      address,
      updatedAt: '',
    });
  }
  const coords = coordinatesFromGoogleLocation(place?.location);
  return coords ? { ...coords, source: 'google', accuracy: 'place' } : null;
}

async function geocodeWithCommunity(address) {
  const cleanAddress = normalizeAddressForGeocoding(address);
  if (!cleanAddress) return null;
  try {
    const getLatLng = await loadCommunityGeocoder();
    const candidates = [...new Set([
      cleanAddress,
      // Imported addresses often append a building name or floor after whitespace.
      cleanAddress.replace(/\s+(?:[^\s]*ビル|[^\s]* Building|[^\s]*マンション|[^\s]*タワー)?\s*\d*(?:F|階|号室)?.*$/i, '').trim(),
    ].filter(Boolean))];
    for (const candidate of candidates) {
      const result = await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve(value || null);
        };
        const timer = setTimeout(() => finish(null), 15000);
        try {
          getLatLng(
            candidate,
            value => { clearTimeout(timer); finish(value); },
            () => { clearTimeout(timer); finish(null); }
          );
        } catch (error) {
          clearTimeout(timer);
          console.error('Community geocoder error:', error);
          finish(null);
        }
      });
      const coords = coordinatesFromValues(result?.lat, result?.lng);
      // 市区町村や都道府県の代表点は飲食店のピンとして粗すぎるため、町丁目まで判別できた場合だけ採用する。
      if (coords && Number(result?.level) >= 3) {
        return { ...coords, source: 'geolonia', accuracy: 'town' };
      }
    }
    return null;
  } catch (error) {
    console.error('Community geocoder load error:', error);
    return null;
  }
}

async function geocodeAddress(address, name = '') {
  const cleanAddress = normalizeAddressForGeocoding(address);
  if (!cleanAddress) return null;

  // 店舗名と住所の組み合わせに強いGoogle Placesを優先する。
  const googleCoords = await geocodeWithGoogle(cleanAddress, name);
  if (googleCoords) return googleCoords;

  // APIキー未設定・Google側で候補なしの場合は、日本住所向けの無料ジオコーダーで町丁目の代表点を取得する。
  return geocodeWithCommunity(cleanAddress);
}

async function saveRecord(event) {
  event.preventDefault();
  const name = $('#nameInput').value.trim();
  if (!name) { $('#nameInput').focus(); return; }
  const existing = state.records.find(r => r.id === state.editingId);
  const address = $('#addressInput').value.trim();
  let coords = coordinatesFromValues($('#latInput').value, $('#lngInput').value);
  if (!coords && address) coords = await geocodeAddress(address, name);
  const now = new Date().toISOString();
  const record = {
    id: state.editingId || uid(),
    name,
    address,
    status: $('#statusInput').value,
    date: $('#dateInput').value || '',
    category: $('#categoryInput').value.trim(),
    price: $('#priceInput').value.trim(),
    tags: parseTags($('#tagsInput').value),
    rating: Number($('#ratingInput').value || 0),
    memo: $('#memoInput').value.trim(),
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    locationSource: coords?.source || existing?.locationSource || '',
    locationAccuracy: coords?.accuracy || existing?.locationAccuracy || '',
    photos: state.selectedPhotos.slice(0, MAX_PHOTOS),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  try {
    await dbPut(record);
    closeRecordDialog();
    await refreshRecords();
    showToast(existing ? '記録を更新しました' : '店を登録しました');
  } catch (error) {
    console.error(error);
    showToast('保存できませんでした。ブラウザーの保存容量を確認してください。', 5000);
  }
}

async function openDetail(id) {
  const record = state.records.find(r => r.id === id);
  if (!record) return;
  state.galleryIndex = 0;
  renderDetail(record, { locating: !recordCoordinates(record) && Boolean(record.address) });
  $('#detailDialog').showModal();

  if (!recordCoordinates(record) && record.address) {
    const coords = await geocodeAddress(record.address, record.name);
    if (coords) {
      const updated = {
        ...record,
        lat: coords.lat,
        lng: coords.lng,
        locationSource: coords.source || record.locationSource || '',
        locationAccuracy: coords.accuracy || record.locationAccuracy || '',
      };
      await dbPut(updated);
      const index = state.records.findIndex(item => item.id === record.id);
      if (index >= 0) state.records[index] = updated;
      if ($('#detailDialog').open) renderDetail(updated);
      if (state.currentView === 'map') renderMapMarkers();
    } else {
      const status = $('#detailLocationStatus');
      if (status) status.textContent = '住所から位置を取得できませんでした。地図で開くと店名と住所で検索します。';
    }
  }
}

function renderDetail(record, options = {}) {
  const content = $('#detailContent');
  const photos = record.photos || [];
  const currentPhoto = photos[state.galleryIndex]?.dataUrl;
  const coords = recordCoordinates(record);
  const mapsUrl = googleMapsUrl(record);

  const detailGoogleAttr = !currentPhoto && googlePhotosEnabled() ? ` data-google-photo-record="${escapeHtml(record.id)}"` : '';
  content.innerHTML = `
    <div class="detail-gallery"${detailGoogleAttr}>
      <div class="detail-media">${currentPhoto ? `<img src="${currentPhoto}" alt="${escapeHtml(record.name)}の写真">` : `<div class="placeholder"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 14l3-3 3 3 2-2 4 4M8.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>${googlePhotosEnabled() ? '<span>Googleから店舗画像を取得</span>' : ''}</div>`}</div>
      ${photos.length > 1 ? `<div class="gallery-nav"><button id="galleryPrev" type="button" aria-label="前の写真">‹</button><button id="galleryNext" type="button" aria-label="次の写真">›</button></div><div class="gallery-dots">${photos.map((_,i) => `<span class="gallery-dot ${i === state.galleryIndex ? 'active' : ''}"></span>`).join('')}</div>` : ''}
    </div>
    <div class="detail-body">
      <span class="detail-status">${statusLabel(record.status)}</span>
      <h2>${escapeHtml(record.name)}</h2>
      <p class="detail-address">${escapeHtml(record.address || '住所未登録')}</p>
      <div class="detail-facts">
        <div class="detail-fact"><span>日付</span><strong>${escapeHtml(formatDate(record.date))}</strong></div>
        <div class="detail-fact"><span>評価</span><strong class="rating">${escapeHtml(starText(record.rating))}</strong></div>
        <div class="detail-fact"><span>金額</span><strong>${escapeHtml(formatPrice(record.price))}</strong></div>
        <div class="detail-fact"><span>ジャンル</span><strong>${escapeHtml(record.category || '未登録')}</strong></div>
        <div class="detail-fact"><span>写真</span><strong>${photos.length}枚</strong></div>
        <div class="detail-fact"><span>更新日</span><strong>${escapeHtml(formatDate((record.updatedAt || '').slice(0,10)))}</strong></div>
      </div>
      ${(record.tags || []).length ? `<div class="tag-row">${record.tags.map(tag => `<button class="tag-chip detail-tag" data-tag="${escapeHtml(tag)}" type="button">#${escapeHtml(tag)}</button>`).join('')}</div>` : ''}
      ${record.memo ? `<div class="detail-memo">${escapeHtml(record.memo)}</div>` : ''}
      ${coords ? '<div id="detailMap" class="detail-map"></div>' : (record.address ? `<div id="detailLocationStatus" class="detail-map detail-map-message">${options.locating ? '住所から位置を取得しています…' : '位置情報は未取得です。'}</div>` : '')}
      <div class="detail-actions">
        <a class="secondary-button" href="${mapsUrl}" target="_blank" rel="noopener">地図で開く</a>
        <button id="shareRecordButton" class="secondary-button" type="button">共有</button>
        <button id="editRecordButton" class="primary-button" type="button">編集</button>
        <button id="deleteRecordButton" class="danger-button" type="button">削除</button>
      </div>
    </div>`;

  $('#galleryPrev')?.addEventListener('click', () => { state.galleryIndex = (state.galleryIndex - 1 + photos.length) % photos.length; renderDetail(record); });
  $('#galleryNext')?.addEventListener('click', () => { state.galleryIndex = (state.galleryIndex + 1) % photos.length; renderDetail(record); });
  $$('.detail-tag', content).forEach(button => button.addEventListener('click', () => {
    state.tagFilter = button.dataset.tag;
    $('#detailDialog').close();
    setView('timeline');
    renderTimeline();
  }));
  $('#editRecordButton').addEventListener('click', () => { $('#detailDialog').close(); openRecordDialog(record); });
  $('#deleteRecordButton').addEventListener('click', async () => {
    const ok = await confirmAction('記録を削除', `「${record.name}」を削除します。元に戻せません。`, '削除');
    if (!ok) return;
    await dbDelete(record.id);
    $('#detailDialog').close();
    await refreshRecords();
    showToast('記録を削除しました');
  });
  $('#shareRecordButton').addEventListener('click', () => shareRecord(record, mapsUrl));
  observeGooglePhotoTargets(content);

  if (coords && $('#detailMap')) {
    setTimeout(() => {
      if (state.detailMap) { state.detailMap.remove(); state.detailMap = null; }
      state.detailMap = L.map('detailMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([coords.lat, coords.lng], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(state.detailMap);
      L.marker([coords.lat, coords.lng], { icon: markerIcon(record.status) }).addTo(state.detailMap);
    }, 50);
  }
}

async function shareRecord(record, mapsUrl) {
  const text = [
    `${record.name}（${statusLabel(record.status)}）`,
    record.rating ? `評価：${starText(record.rating)}` : '',
    record.address ? `住所：${record.address}` : '',
    record.memo ? `メモ：${record.memo}` : '',
    mapsUrl
  ].filter(Boolean).join('\n');
  try {
    if (navigator.share) await navigator.share({ title: record.name, text });
    else {
      await navigator.clipboard.writeText(text);
      showToast('共有用テキストをコピーしました');
    }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('共有できませんでした');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

function exportBackup() {
  const payload = { app: '外食レコ', schemaVersion: 1, exportedAt: new Date().toISOString(), records: state.records };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `外食レコ_バックアップ_${dateStamp()}.json`);
  showToast('バックアップを保存しました');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const records = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(records)) throw new Error('recordsがありません');
    let count = 0;
    for (const raw of records) {
      if (!raw.name) continue;
      const now = new Date().toISOString();
      await dbPut({
        id: raw.id || uid(), name: String(raw.name), address: raw.address || '', status: raw.status === 'wishlist' ? 'wishlist' : 'visited',
        date: raw.date || '', category: raw.category || '', price: raw.price || '', tags: parseTags(raw.tags), rating: Number(raw.rating) || 0,
        memo: raw.memo || '', lat: recordCoordinates(raw)?.lat ?? null, lng: recordCoordinates(raw)?.lng ?? null,
        locationSource: raw.locationSource || '', locationAccuracy: raw.locationAccuracy || '',
        photos: Array.isArray(raw.photos) ? raw.photos.slice(0, MAX_PHOTOS) : [], createdAt: raw.createdAt || now, updatedAt: raw.updatedAt || now
      });
      count++;
    }
    await refreshRecords();
    showToast(`${count}件を復元しました`);
  } catch (error) {
    console.error(error);
    showToast('バックアップファイルを読み込めませんでした', 4500);
  }
}

function exportCsv() {
  const rows = state.records.map(r => ({
    '店名': r.name,
    '区分': statusLabel(r.status),
    '日付': r.date || '',
    '住所': r.address || '',
    'ジャンル': r.category || '',
    '金額': r.price || '',
    '評価': r.rating || '',
    'タグ': (r.tags || []).join('|'),
    'メモ': r.memo || '',
    '緯度': r.lat ?? '',
    '経度': r.lng ?? ''
  }));
  const csv = '\ufeff' + Papa.unparse(rows);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `外食レコ_${dateStamp()}.csv`);
  showToast('CSVを保存しました');
}

function findHeader(headers, candidates) {
  const normalized = headers.map(h => ({ original: h, normalized: normalizeText(h).replace(/[\s_\-／/]/g, '') }));
  for (const candidate of candidates) {
    const c = normalizeText(candidate).replace(/[\s_\-／/]/g, '');
    const exact = normalized.find(h => h.normalized === c);
    if (exact) return exact.original;
  }
  for (const candidate of candidates) {
    const c = normalizeText(candidate).replace(/[\s_\-／/]/g, '');
    const partial = normalized.find(h => h.normalized.includes(c));
    if (partial) return partial.original;
  }
  return null;
}

function parseImportedDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  const match = text.match(/(20\d{2})[\/.年-](\d{1,2})[\/.月-](\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2,'0')}-${String(match[3]).padStart(2,'0')}`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10);
}

function importedStatus(value) {
  const text = normalizeText(value);
  return /行きたい|気になる|wishlist|want/.test(text) ? 'wishlist' : 'visited';
}

function normalizeFilename(value) {
  return decodeURIComponent(String(value || '')).split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠._-]/gi, '');
}

async function zipImages(file) {
  if (!file) return new Map();
  const zip = await JSZip.loadAsync(file);
  const map = new Map();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/\.(jpe?g|png|webp|heic)$/i.test(path)) continue;
    const blob = await entry.async('blob');
    let dataUrl;
    try {
      dataUrl = await fileToCompressedDataUrl(new File([blob], path.split('/').pop(), { type: blob.type || 'image/jpeg' }));
    } catch {
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
    }
    map.set(normalizeFilename(path), { name: path.split('/').pop(), type: blob.type || 'image/jpeg', dataUrl });
  }
  return map;
}

function matchPhotosForRow(row, headers, imageMap, idHeader, imageHeaders) {
  const matches = [];
  const used = new Set();
  const candidates = [];
  imageHeaders.forEach(header => {
    const value = row[header];
    if (value) String(value).split(/[|,;\s]+/).forEach(v => candidates.push(normalizeFilename(v)));
  });
  const rowId = idHeader ? normalizeFilename(row[idHeader]) : '';
  for (const [filename, photo] of imageMap) {
    const exact = candidates.some(candidate => candidate && (filename === candidate || filename.endsWith(candidate) || candidate.endsWith(filename)));
    const idMatch = rowId && rowId.length >= 4 && filename.includes(rowId);
    if ((exact || idMatch) && !used.has(filename)) {
      matches.push(photo); used.add(filename);
      if (matches.length >= MAX_PHOTOS) break;
    }
  }
  return matches;
}

async function importMogureco() {
  const csvFile = $('#mogurecoCsvInput').files[0];
  const zipFile = $('#mogurecoZipInput').files[0];
  const result = $('#importResult');
  if (!csvFile) { showToast('CSVファイルを選択してください'); return; }
  result.classList.remove('hidden');
  result.textContent = 'CSVを解析しています...';
  try {
    const csvText = await csvFile.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: 'greedy', transformHeader: h => String(h).trim() });
    if (parsed.errors.length && !parsed.data.length) throw new Error(parsed.errors[0].message);
    const headers = parsed.meta.fields || Object.keys(parsed.data[0] || {});
    const field = {
      name: findHeader(headers, ['店名','店舗名','飲食店名','shopName','restaurantName','name']),
      address: findHeader(headers, ['住所','所在地','address']),
      date: findHeader(headers, ['訪問日','来店日','利用日','日付','date','visitedAt','createdAt']),
      memo: findHeader(headers, ['メモ','感想','コメント','note','memo']),
      rating: findHeader(headers, ['評価','星','rating','score']),
      tags: findHeader(headers, ['タグ','tag','tags']),
      status: findHeader(headers, ['区分','状態','分類','ステータス','status','type']),
      category: findHeader(headers, ['ジャンル','カテゴリ','category']),
      price: findHeader(headers, ['金額','価格','予算','price','cost']),
      lat: findHeader(headers, ['緯度','latitude','lat']),
      lng: findHeader(headers, ['経度','longitude','lon','lng']),
      id: findHeader(headers, ['記録ID','店舗ID','id','recordId']),
    };
    if (!field.name) throw new Error(`店名の列を判定できませんでした。列名: ${headers.join(', ')}`);
    const imageHeaders = headers.filter(h => /画像|写真|photo|image|file/i.test(h));
    let imageMap = new Map();
    if (zipFile) {
      result.textContent = '画像ZIPを展開しています...';
      imageMap = await zipImages(zipFile);
    }
    let imported = 0, withPhotos = 0, skipped = 0, geocoded = 0;
    for (let i = 0; i < parsed.data.length; i++) {
      const row = parsed.data[i];
      const name = String(row[field.name] || '').trim();
      if (!name) { skipped++; continue; }
      const address = field.address ? String(row[field.address] || '').trim() : '';
      const photos = matchPhotosForRow(row, headers, imageMap, field.id, imageHeaders);
      let coords = coordinatesFromValues(
        field.lat ? row[field.lat] : null,
        field.lng ? row[field.lng] : null
      );
      if (!coords && address) {
        result.textContent = `${i + 1}/${parsed.data.length}件を処理中：${name}の位置を取得しています...`;
        coords = await geocodeAddress(address, name);
        if (coords) geocoded++;
        await wait(150);
      }
      const now = new Date().toISOString();
      await dbPut({
        id: uid(), name, address,
        status: field.status ? importedStatus(row[field.status]) : 'visited',
        date: field.date ? parseImportedDate(row[field.date]) : '',
        category: field.category ? String(row[field.category] || '').trim() : '',
        price: field.price ? String(row[field.price] || '').trim() : '',
        tags: field.tags ? parseTags(String(row[field.tags] || '').replaceAll('|', ',')) : [],
        rating: field.rating ? Math.max(0, Math.min(5, Number(String(row[field.rating]).match(/[0-5](?:\.\d)?/)?.[0] || 0))) : 0,
        memo: field.memo ? String(row[field.memo] || '').trim() : '',
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        locationSource: coords?.source || '',
        locationAccuracy: coords?.accuracy || '',
        photos,
        createdAt: now, updatedAt: now,
      });
      imported++;
      if (photos.length) withPhotos++;
      if (i % 10 === 0) result.textContent = `${i + 1}/${parsed.data.length}件を処理しています...`;
    }
    await refreshRecords();
    result.textContent = `取り込み完了\n登録：${imported}件\n写真付き：${withPhotos}件\nスキップ：${skipped}件\n画像ZIP内：${imageMap.size}枚\n位置取得：${geocoded}件`;
    showToast(`${imported}件を取り込みました`);
  } catch (error) {
    console.error(error);
    result.textContent = `取り込みに失敗しました。\n${error.message}`;
    showToast('取り込みに失敗しました', 4500);
  }
}

function setupEvents() {
  $$('.nav-button').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#addButton').addEventListener('click', () => openRecordDialog());
  $$('.close-dialog').forEach(button => button.addEventListener('click', closeRecordDialog));
  $$('.close-detail').forEach(button => button.addEventListener('click', () => $('#detailDialog').close()));
  $('#recordForm').addEventListener('submit', saveRecord);
  $('#searchInput').addEventListener('input', event => { state.query = event.target.value; renderTimeline(); });
  $$('.filter-button').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter-button').forEach(b => b.classList.toggle('active', b === button));
    renderTimeline();
  }));
  $$('#ratingButtons button[data-rating]').forEach(button => button.addEventListener('click', () => {
    $('#ratingInput').value = button.dataset.rating;
    updateRatingButtons();
  }));
  $('#clearRatingButton').addEventListener('click', () => { $('#ratingInput').value = '0'; updateRatingButtons(); });
  $('#photoInput').addEventListener('change', event => { handlePhotos(event.target.files); event.target.value = ''; });
  $('#placeSearchButton').addEventListener('click', () => {
    const query = $('#placeSearchInput').value.trim();
    if (!query) return showToast('店名や地域名を入力してください');
    searchPlaces(query);
  });
  $('#placeSearchInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('#placeSearchButton').click(); }
  });
  $('#addressInput').addEventListener('input', () => {
    $('#latInput').value = '';
    $('#lngInput').value = '';
  });
  $('#repairLocationsButton')?.addEventListener('click', repairMissingCoordinates);
  $('#nearbySearchButton').addEventListener('click', async () => {
    try {
      showToast('現在地を取得しています');
      const pos = await getCurrentPosition();
      await searchPlaces($('#placeSearchInput').value.trim() || '飲食店', pos);
    } catch { showToast('現在地を取得できませんでした'); }
  });
  $('#locateButton').addEventListener('click', async () => {
    try {
      const pos = await getCurrentPosition();
      state.map.setView(pos, 15);
      L.circleMarker(pos, { radius: 7, color: '#2767b1', fillColor: '#fff', fillOpacity: 1, weight: 4 }).addTo(state.mapLayer).bindPopup('現在地').openPopup();
    } catch { showToast('現在地を取得できませんでした'); }
  });
  $('#exportButton').addEventListener('click', exportBackup);
  $('#jsonImportInput').addEventListener('change', event => { if (event.target.files[0]) importBackup(event.target.files[0]); event.target.value = ''; });
  $('#csvExportButton').addEventListener('click', exportCsv);
  $('#mogurecoImportButton').addEventListener('click', importMogureco);
  $('#requestPersistenceButton')?.addEventListener('click', requestPersistentStorage);
  $('#saveGoogleSettingsButton')?.addEventListener('click', saveGoogleSettings);
  $('#clearGoogleSettingsButton')?.addEventListener('click', clearGoogleSettings);
  $('#deleteAllButton').addEventListener('click', async () => {
    const ok = await confirmAction('全データを削除', '登録した店と写真をすべて削除します。バックアップがない場合は復元できません。', 'すべて削除');
    if (!ok) return;
    await dbClear();
    await refreshRecords();
    showToast('全データを削除しました');
  });
  $('#recordDialog').addEventListener('click', event => { if (event.target === $('#recordDialog')) closeRecordDialog(); });
  $('#detailDialog').addEventListener('click', event => { if (event.target === $('#detailDialog')) $('#detailDialog').close(); });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    $('#installButton').classList.remove('hidden');
  });
  $('#installButton').addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $('#installButton').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => $('#installButton').classList.add('hidden'));
}

async function normalizeStoredCoordinates() {
  const records = await dbGetAll();
  for (const record of records) {
    const normalized = normalizeRecordCoordinates(record);
    if (record.lat !== normalized.lat || record.lng !== normalized.lng) {
      // Spread-based normalization changes coordinates only and preserves all legacy fields/photos.
      await dbPut(normalized);
    }
  }
}

async function init() {
  try {
    state.db = await openDb();
    setupEvents();
    updateGoogleSettingsUi();
    await normalizeStoredCoordinates();
    await refreshRecords();
    await updateStorageStatus();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .then(registration => registration.update())
        .catch(console.warn);
    }
  } catch (error) {
    console.error(error);
    document.body.innerHTML = '<main><div class="empty-state"><h2>アプリを起動できませんでした</h2><p>ブラウザーのプライベートモードや保存設定を確認してください。</p></div></main>';
  }
}

document.addEventListener('DOMContentLoaded', init);
