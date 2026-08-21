import {
    characters,
    this_chid,
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
    unshallowCharacter,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const EXTENSION_KEY = 'frontendMediaLocalizer';
const API_BASE = '/api/plugins/frontend-media-localizer';
const EXTENSION_PUBLIC_PATH = '/scripts/extensions/third-party/frontend-media-localizer';
const OFFLINE_PLACEHOLDER_PATH = `${EXTENSION_PUBLIC_PATH}/offline-placeholder.svg`;
const OFFLINE_BLOCKED_PATH = `${EXTENSION_PUBLIC_PATH}/offline-blocked`;
const BACKEND_PLUGIN_FOLDER = 'frontend-media-localizer';
const BACKEND_TEMPLATE_FILES = ['index.mjs', 'package.json'];
const REQUIRED_BACKEND_VERSION = '1.6.1';
const MEDIA_TYPES = ['image', 'audio', 'video'];
const TYPE_LABELS = { image: '图片', audio: '音频', video: '视频' };
const TYPE_ICONS = { image: 'fa-image', audio: 'fa-music', video: 'fa-film' };
const QUEUE_COLORS = ['#62a9ed', '#f39c5a', '#58bd7b', '#ae7bea', '#ed6fa5', '#46c7c7', '#e3bd4f', '#e36b6b'];
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gi;

const defaults = {
    enabled: true,
    useLocalResources: true,
    onlineMode: false,
    offlineMode: false,
    showFloatingButton: true,
    sniffingEnabled: false,
    sniffNotifications: true,
    sniffAutoDownload: false,
    sniffSaveAs: false,
    sniffMaxNotifications: 3,
    sniffNotificationSeconds: 5,
    sniffBlockedUrls: [],
    pendingSniffRegistrations: [],
    floatingPositions: { desktop: null, mobile: null },
    defaultRequestIntervalSeconds: 1,
    siteRateRules: [
        { domain: 'files.catbox.moe', intervalSeconds: 5 },
    ],
};

let currentCard = null;
let currentStorageCardName = null;
let currentCandidates = new Map();
let currentLibrary = [];
let routeMap = new Map();
let routeRegex = null;
let reverseRouteMap = new Map();
let reverseRouteRegex = null;
let serverAvailable = false;
let activeModal = null;
let cardChangeSequence = 0;
let downloadQueue = [];
let queueRunnerActive = false;
let queueDisplayIndex = 0;
let allCardsRefreshPromise = null;
let allCardsPollTimer = null;
let serverHealthTimer = null;
let serverHealthPromise = null;
let serverStatusChecked = false;
let currentLibraryPollTimer = null;
let currentLibraryRefreshPromise = null;
let libraryMutationSequence = 0;
let currentCardRoutingReady = false;
let cardSyncPromise = null;
let cardSyncIdentity = null;
let lifecycleEventsInitialized = false;
let offlineFallbackApplied = false;
let backendInstallPrompted = false;
let backendUpdateRequired = false;
let detectedBackendVersion = null;
let latestLoadedResource = null;
let sniffRecords = new Map();
const sniffRecordIndex = new Map();
const runtimeSessions = new Map();
const runtimeSessionByDocument = new WeakMap();
let runtimeSessionSequence = 0;
let sniffAutoQueue = [];
let sniffAutoRunnerActive = false;
let resourceDirectoryHandle = null;
let nextSniffRequestAt = new Map();
let sniffRequestGate = Promise.resolve();
let floatingViewportMode = null;
let offlineNoticeTimes = new Map();
const trackedMediaElements = new Set();

const HANDLE_DB_NAME = 'frontend-media-localizer';
const HANDLE_STORE_NAME = 'handles';
const RESOURCE_HANDLE_KEY = 'resources-root';

function openHandleDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(HANDLE_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(HANDLE_STORE_NAME)) request.result.createObjectStore(HANDLE_STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function readStoredHandle() {
    const database = await openHandleDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const request = database.transaction(HANDLE_STORE_NAME, 'readonly').objectStore(HANDLE_STORE_NAME).get(RESOURCE_HANDLE_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } finally { database.close(); }
}

async function storeResourceHandle(handle) {
    const database = await openHandleDatabase();
    try {
        await new Promise((resolve, reject) => {
            const request = database.transaction(HANDLE_STORE_NAME, 'readwrite').objectStore(HANDLE_STORE_NAME).put(handle, RESOURCE_HANDLE_KEY);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } finally { database.close(); }
}

async function handlePermission(handle, request = false) {
    if (!handle) return false;
    const options = { mode: 'readwrite' };
    if (await handle.queryPermission(options) === 'granted') return true;
    return request && await handle.requestPermission(options) === 'granted';
}

function getSettings() {
    if (!extension_settings[EXTENSION_KEY] || typeof extension_settings[EXTENSION_KEY] !== 'object') {
        extension_settings[EXTENSION_KEY] = structuredClone(defaults);
    }
    const settings = extension_settings[EXTENSION_KEY];
    const onlineModeMissing = settings.onlineMode === undefined;
    for (const [key, value] of Object.entries(defaults)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    if (onlineModeMissing) settings.onlineMode = !settings.useLocalResources && !settings.offlineMode;
    if (settings.offlineMode) {
        settings.onlineMode = false;
        settings.useLocalResources = true;
    } else if (settings.onlineMode) {
        settings.useLocalResources = false;
    }
    return settings;
}

function saveSettings() {
    saveSettingsDebounced();
}

function isMobileLayout() {
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    return window.matchMedia('(max-width: 767px)').matches || (hasTouch && window.innerWidth < 900);
}

function normalizeRateSeconds(value, fallback = 1) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(3600, Math.max(0.1, parsed)) : fallback;
}

function normalizeRateDomain(value) {
    let domain = String(value ?? '').trim().toLowerCase();
    try {
        if (domain.includes('://')) domain = new URL(domain).hostname.toLowerCase();
    } catch { return ''; }
    domain = domain.replace(/^\.+|\.+$/g, '');
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) ? domain : '';
}

function getRatePolicy() {
    const settings = getSettings();
    const rules = [];
    const seen = new Set();
    for (const item of Array.isArray(settings.siteRateRules) ? settings.siteRateRules : []) {
        const domain = normalizeRateDomain(item?.domain);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        rules.push({ domain, intervalMs: Math.round(normalizeRateSeconds(item?.intervalSeconds, 1) * 1000) });
    }
    return {
        defaultIntervalMs: Math.round(normalizeRateSeconds(settings.defaultRequestIntervalSeconds, 1) * 1000),
        rules,
    };
}

async function waitForSniffRequestSlot(url) {
    const policy = getRatePolicy();
    const hostname = new URL(url).hostname.toLowerCase();
    const rule = [...policy.rules].sort((left, right) => right.domain.length - left.domain.length)
        .find(item => hostname === item.domain || hostname.endsWith(`.${item.domain}`));
    const key = rule?.domain || hostname;
    const intervalMs = rule?.intervalMs ?? policy.defaultIntervalMs;
    const turn = sniffRequestGate.then(async () => {
        const delay = Math.max(0, (nextSniffRequestAt.get(key) || 0) - Date.now());
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        nextSniffRequestAt.set(key, Date.now() + intervalMs);
    });
    sniffRequestGate = turn.catch(() => {});
    await turn;
}

function renderRateRuleRows(container, settings) {
    const rules = Array.isArray(settings.siteRateRules) ? settings.siteRateRules : [];
    container.innerHTML = rules.length ? rules.map((rule, index) => `
        <div class="fml-rate-rule" data-index="${index}">
            <input class="text_pole fml-rate-domain" type="text" value="${escapeHtml(rule?.domain || '')}" placeholder="files.example.com" aria-label="网站域名">
            <input class="text_pole fml-rate-seconds" type="number" min="0.1" max="3600" step="0.1" value="${escapeHtml(normalizeRateSeconds(rule?.intervalSeconds, 1))}" aria-label="请求间隔秒数">
            <span>秒</span>
            <button class="menu_button fml-rate-remove" type="button" title="删除规则"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') : '<small class="fml-rate-empty">暂无单独网站规则，全部使用默认间隔。</small>';
}

function saveRateRulesFromPanel(panel, settings) {
    const rules = [];
    const seen = new Set();
    for (const row of panel.querySelectorAll('.fml-rate-rule')) {
        const domain = normalizeRateDomain(row.querySelector('.fml-rate-domain')?.value);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        rules.push({
            domain,
            intervalSeconds: normalizeRateSeconds(row.querySelector('.fml-rate-seconds')?.value, 1),
        });
    }
    settings.siteRateRules = rules;
    saveSettings();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOfflineMode() {
    const settings = getSettings();
    return Boolean(settings.enabled && settings.offlineMode && !settings.onlineMode);
}

function encodeSourceParameter(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isOfflineResourceUrl(value) {
    try {
        const url = new URL(String(value).replaceAll('&amp;', '&'), location.origin);
        return url.origin === location.origin
            && (url.pathname === OFFLINE_PLACEHOLDER_PATH || url.pathname.startsWith(`${OFFLINE_BLOCKED_PATH}-`));
    } catch { return false; }
}

function offlineResourceUrl(source, type) {
    const path = type === 'image' ? OFFLINE_PLACEHOLDER_PATH : `${OFFLINE_BLOCKED_PATH}-${type}.bin`;
    const url = new URL(path, location.origin);
    url.searchParams.set('source', encodeSourceParameter(source));
    url.searchParams.set('type', type);
    return url.href;
}

function localResourceUrl(localUrl) {
    try {
        const url = new URL(localUrl, location.origin);
        if (isOfflineMode()) url.searchParams.set('offline', '1');
        return url.href;
    } catch { return localUrl; }
}

function currentCardResource(source, typeHint = null) {
    const normalized = decodeSourceParameter(source) || normalizeCandidate(source);
    if (!normalized) return null;
    const candidate = currentCandidates.get(normalized);
    if (!candidate) return null;
    const type = typeHint || candidate.type || inferType(normalized);
    return MEDIA_TYPES.includes(type) ? { source: normalized, type, candidate } : null;
}

function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '大小未知';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = -1;
    do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
    return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

function normalizeCandidate(raw) {
    let value = String(raw ?? '').trim().replace(/&amp;/gi, '&');
    value = value.replace(/[),;\]}]+$/g, '');
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        if (url.origin === location.origin
            && (url.pathname.startsWith(API_BASE) || url.pathname === OFFLINE_PLACEHOLDER_PATH || url.pathname.startsWith(`${OFFLINE_BLOCKED_PATH}-`))) return null;
        return url.href;
    } catch {
        return null;
    }
}

function inferType(url, context = '') {
    let pathname = '';
    let hostname = '';
    try {
        const parsed = new URL(url);
        pathname = parsed.pathname.toLowerCase();
        hostname = parsed.hostname.toLowerCase();
    } catch { return null; }
    if (hostname === 'fonts.googleapis.com'
        || /\.(?:css|m?js|json|html?|xml|txt|woff2?|ttf|otf|eot)$/.test(pathname)) return null;
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(pathname)) return 'image';
    if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(pathname)) return 'audio';
    if (/\.(mp4|webm|mov|mkv|m4v|avi|ogv)$/.test(pathname)) return 'video';
    const lower = context.toLowerCase();
    if (/<video\b|video(?:url|src)|\.video|playsinline/.test(lower)) return 'video';
    if (/<audio\b|new\s+audio|audio(?:url|src)|bgm|voice|sound/.test(lower)) return 'audio';
    if (/<img\b|image(?:url|src)|background(?:-image)?|sprite|portrait|avatar|\.src/.test(lower)) return 'image';
    return null;
}

function collectFromString(text, field, output) {
    URL_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        const raw = match[0].trim().replace(/[),;\]}]+$/g, '');
        const url = normalizeCandidate(match[0]);
        if (!url) continue;
        const start = Math.max(0, match.index - 180);
        const end = Math.min(text.length, match.index + match[0].length + 180);
        const hint = inferType(url, text.slice(start, end));
        const existing = output.get(url);
        if (existing) {
            existing.fields.add(field);
            existing.aliases.add(raw);
            if (!existing.type && hint) existing.type = hint;
        } else {
            output.set(url, {
                url,
                type: hint,
                hint,
                size: null,
                contentType: null,
                error: null,
                selected: Boolean(hint),
                fields: new Set([field]),
                aliases: new Set([raw, url]),
                status: 'detected',
            });
        }
    }
}

function collectRemoteResources(value, field = '', output = new Map(), seen = new WeakSet()) {
    if (typeof value === 'string') {
        if (/https?:\/\//i.test(value)) collectFromString(value, field, output);
        return output;
    }
    if (!value || typeof value !== 'object') return output;
    if (seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectRemoteResources(item, `${field}[${index}]`, output, seen));
    } else {
        Object.entries(value).forEach(([key, item]) => collectRemoteResources(item, field ? `${field}.${key}` : key, output, seen));
    }
    return output;
}

async function api(pathname, options = {}) {
    const response = await fetch(`${API_BASE}${pathname}`, {
        ...options,
        headers: { ...getRequestHeaders(), ...(options.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
}

async function apiUpload(pathname, formData) {
    const headers = new Headers(getRequestHeaders());
    headers.delete('content-type');
    const response = await fetch(`${API_BASE}${pathname}`, {
        method: 'POST',
        headers,
        body: formData,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
}

function isVersionAtLeast(actual, required) {
    if (!actual) return false;
    const normalize = value => String(value).split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
    const left = normalize(actual);
    const right = normalize(required);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
        const difference = (left[index] || 0) - (right[index] || 0);
        if (difference !== 0) return difference > 0;
    }
    return true;
}

async function checkServer() {
    if (serverHealthPromise) return serverHealthPromise;
    serverHealthPromise = checkServerOnce().finally(() => { serverHealthPromise = null; });
    return serverHealthPromise;
}

async function checkServerOnce() {
    const wasAvailable = serverAvailable;
    try {
        const status = await api('/status', { method: 'GET', headers: {}, signal: AbortSignal.timeout(4000) });
        detectedBackendVersion = status.version || null;
        backendUpdateRequired = Boolean(status.enabled && status.writable && !isVersionAtLeast(detectedBackendVersion, REQUIRED_BACKEND_VERSION));
        serverAvailable = Boolean(status.enabled && status.writable && !backendUpdateRequired);
        updateSettingsStatus({ ...status, updateRequired: backendUpdateRequired });
        await handleServerAvailabilityChange(wasAvailable, serverAvailable);
        refreshAllCardsInline();
        return status;
    } catch (error) {
        serverAvailable = false;
        backendUpdateRequired = false;
        detectedBackendVersion = null;
        updateSettingsStatus({ enabled: false, error: error.message });
        await handleServerAvailabilityChange(wasAvailable, false);
        return null;
    } finally {
        serverStatusChecked = true;
    }
}

async function handleServerAvailabilityChange(wasAvailable, isAvailable) {
    if (!isAvailable) {
        if (offlineFallbackApplied) return;
        offlineFallbackApplied = true;
        currentLibrary = [];
        setRouteMap([]);
        if (isOfflineMode()) {
            applyCurrentResourcePolicy();
        } else {
            applyOnlineResourcePolicy();
        }
        updateFloatingButton();
        updateSettingsSummary();
        return;
    }
    offlineFallbackApplied = false;
    if (wasAvailable === isAvailable) return;
    await syncPendingRegistrations().catch(error => console.debug('[FrontendMediaLocalizer] Pending registration sync failed:', error));
    if (!currentCard || !getSettings().enabled || !getSettings().useLocalResources || getSettings().onlineMode) return;
    try {
        await loadLibrary(currentCard.name);
        applyCurrentResourcePolicy();
    } catch (error) {
        console.debug('[FrontendMediaLocalizer] Failed to restore local routes after reconnect:', error);
    }
}

function updateSettingsStatus(status) {
    const indicator = document.querySelector('#fml-server-status');
    if (indicator) {
        const ready = Boolean(status?.writable && !status?.updateRequired);
        indicator.className = `fml-status ${ready ? 'is-ok' : 'is-error'}`;
        indicator.textContent = status?.updateRequired
            ? `服务端版本 ${detectedBackendVersion || '旧版'}，需要更新至 ${REQUIRED_BACKEND_VERSION}`
            : status?.writable
                ? `服务端已连接，可读写（v${detectedBackendVersion || REQUIRED_BACKEND_VERSION}）`
                : '服务端未连接，请安装后端或重启酒馆';
        indicator.title = status?.error || '';
    }
    const installer = document.querySelector('#fml-backend-install-row');
    if (installer) {
        installer.hidden = Boolean(status?.enabled && status?.writable && !status?.updateRequired);
        const button = installer.querySelector('#fml-install-backend-settings');
        if (button) button.innerHTML = `<i class="fa-solid fa-download"></i> ${status?.updateRequired ? '更新后端' : '安装后端'}`;
        const description = installer.querySelector('small');
        if (description) description.textContent = status?.updateRequired
            ? '授权 SillyTavern/plugins 文件夹并覆盖旧后端，完成后重启酒馆。'
            : '选择 SillyTavern/plugins 文件夹后写入后端，完成后重启酒馆。';
    }
}

async function getBackendTemplateFiles() {
    const entries = await Promise.all(BACKEND_TEMPLATE_FILES.map(async name => {
        const response = await fetch(`${EXTENSION_PUBLIC_PATH}/server-plugin/${name}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法读取后端安装文件：${name}`);
        return [name, await response.text()];
    }));
    return new Map(entries);
}

async function fileExists(directory, name) {
    try {
        await directory.getFileHandle(name);
        return true;
    } catch (error) {
        if (error?.name === 'NotFoundError') return false;
        throw error;
    }
}

async function writeTextFile(directory, name, contents) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
        await writable.write(contents);
    } finally {
        await writable.close();
    }
}

async function installBackendPluginFromHandle() {
    if (!window.showDirectoryPicker) {
        throw new Error('当前酒馆浏览器不支持文件夹授权，无法使用内置安装。');
    }

    const pluginsDirectory = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (String(pluginsDirectory.name || '').toLowerCase() !== 'plugins') {
        throw new Error('请选择 SillyTavern 根目录内的 plugins 文件夹，而不是其他目录。');
    }

    const files = await getBackendTemplateFiles();
    const pluginDirectory = await pluginsDirectory.getDirectoryHandle(BACKEND_PLUGIN_FOLDER, { create: true });
    const exists = await Promise.all(BACKEND_TEMPLATE_FILES.map(name => fileExists(pluginDirectory, name)));
    if (exists.some(Boolean) && !window.confirm('检测到已有资源本地化后端。继续将覆盖其 index.mjs 与 package.json，是否继续？')) {
        return false;
    }

    for (const [name, contents] of files) {
        await writeTextFile(pluginDirectory, name, contents);
    }
    return true;
}

function backendInstallerBody(message = '') {
    const updating = backendUpdateRequired;
    return `
        <div class="fml-installer-copy">
            <p>${updating
                ? `检测到服务端版本 <code>${escapeHtml(detectedBackendVersion || '旧版')}</code>，当前前端要求至少 <code>${REQUIRED_BACKEND_VERSION}</code>。更新前已暂停资源扫描和下载。`
                : '完整的资源下载功能需要酒馆服务端后端，目前尚未检测到可用版本。'}</p>
            <p>点击${updating ? '更新' : '安装'}后，请在系统选择框中选中 <code>SillyTavern/plugins</code> 文件夹。扩展会${updating ? '覆盖更新' : '写入'}其中的 <code>frontend-media-localizer</code> 后端文件。</p>
            <p>安装完成后必须重启酒馆；若重启后仍未连接，请在 <code>config.yaml</code> 中启用 <code>enableServerPlugins: true</code>。</p>
            <div class="fml-installer-result">${escapeHtml(message)}</div>
        </div>
        <footer class="fml-modal-footer">
            <button class="menu_button fml-close-installer">稍后处理</button>
            <button class="menu_button fml-install-backend"><i class="fa-solid fa-download"></i> 选择 plugins 文件夹并${updating ? '更新' : '安装'}</button>
        </footer>`;
}

function openBackendInstaller(message = '') {
    const updating = backendUpdateRequired;
    const modal = createModal(`${updating ? '更新' : '安装'}资源本地化后端`, backendInstallerBody(message), 'fml-backend-installer-modal');
    const result = modal.querySelector('.fml-installer-result');
    const installButton = modal.querySelector('.fml-install-backend');
    modal.querySelector('.fml-close-installer').addEventListener('click', closeModal);
    installButton.addEventListener('click', async () => {
        installButton.disabled = true;
        result.textContent = '正在等待文件夹授权……';
        try {
            const installed = await installBackendPluginFromHandle();
            if (!installed) {
                result.textContent = '已取消，现有后端文件未被修改。';
                return;
            }
            result.textContent = `后端文件已${updating ? '更新' : '写入'}。请完全重启酒馆，然后前端会自动复检版本。`;
            installButton.hidden = true;
        } catch (error) {
            if (error?.name === 'AbortError') result.textContent = '未选择文件夹，安装已取消。';
            else result.textContent = `安装失败：${error.message || error}`;
        } finally {
            installButton.disabled = false;
        }
    });
}

function activeCardIdentity(characterId = this_chid) {
    const character = characterId === undefined ? null : characters[characterId];
    if (!character) return null;
    return String(characterId);
}

async function getActiveCard(characterId = this_chid) {
    if (characterId === undefined || !characters[characterId]) return null;
    await unshallowCharacter(characterId).catch(() => {});
    const character = characters[characterId];
    if (!character) return null;
    return {
        identity: activeCardIdentity(characterId),
        name: character.name || character.avatar?.replace(/\.png$/i, '') || 'Unnamed Character',
        character,
    };
}

async function loadLibrary(cardName = currentCard?.name) {
    if (!cardName || !serverAvailable) {
        currentLibrary = [];
        setRouteMap([]);
        return [];
    }
    const data = await api(`/library?card=${encodeURIComponent(cardName)}`, { method: 'GET', headers: {} });
    const resources = Array.isArray(data.resources) ? data.resources : [];
    if (currentCard?.name !== cardName) return resources;
    currentStorageCardName = data.card || cardName;
    currentLibrary = resources;
    libraryMutationSequence++;
    setRouteMap(currentLibrary);
    applyConfiguredResourcePolicy();
    updateFloatingButton();
    updateSettingsSummary();
    return currentLibrary;
}

async function refreshCurrentLibrarySilently() {
    if (!serverAvailable || !currentCard || document.hidden || downloadQueue.length || queueRunnerActive || sniffAutoRunnerActive) return;
    if ([...sniffRecords.values()].some(record => record.state === 'saving')) return;
    if (currentLibraryRefreshPromise) return currentLibraryRefreshPromise;
    const cardName = currentCard.name;
    const mutationSequence = libraryMutationSequence;
    currentLibraryRefreshPromise = (async () => {
        try {
            const data = await api(`/library?card=${encodeURIComponent(cardName)}`, { method: 'GET', headers: {} });
            if (currentCard?.name !== cardName || mutationSequence !== libraryMutationSequence) return;
            currentLibrary = Array.isArray(data.resources) ? data.resources : [];
            currentStorageCardName = data.card || cardName;
            libraryMutationSequence++;
            setRouteMap(currentLibrary);
            applyConfiguredResourcePolicy();
            updateFloatingButton();
            updateSettingsSummary();
            if (Number(data.repaired) > 0) {
                console.info('[FrontendMediaLocalizer] 已静默修复手动删除的本地资源映射', {
                    角色卡: cardName,
                    修复数量: Number(data.repaired),
                });
            }
        } catch (error) {
            console.debug('[FrontendMediaLocalizer] 当前卡资源静默复检失败:', error);
        }
    })().finally(() => { currentLibraryRefreshPromise = null; });
    return currentLibraryRefreshPromise;
}

function setRouteMap(resources) {
    const available = resources.filter(item => item.source && item.localUrl && item.exists !== false);
    routeMap = new Map(available.map(item => [item.source, item.localUrl]));
    reverseRouteMap = new Map(available.map(item => [item.localUrl, item.source]));
    for (const candidate of currentCandidates.values()) {
        const localUrl = routeMap.get(candidate.url);
        if (!localUrl) continue;
        for (const alias of candidate.aliases ?? []) routeMap.set(alias, localUrl);
    }
    if (routeMap.size) {
        const alternatives = [...routeMap.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
        routeRegex = new RegExp(alternatives.join('|'), 'g');
    } else {
        routeRegex = null;
    }
    if (reverseRouteMap.size) {
        const alternatives = [...reverseRouteMap.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
        reverseRouteRegex = new RegExp(alternatives.join('|'), 'g');
    } else {
        reverseRouteRegex = null;
    }
}

function rememberMediaElement(element) {
    const tag = String(element?.tagName || '').toLowerCase();
    if (!['audio', 'video'].includes(tag)) return;
    trackedMediaElements.add(element);
    if (trackedMediaElements.size <= 256) return;
    for (const candidate of trackedMediaElements) {
        if (candidate === element) continue;
        if (candidate?.ended || (candidate?.paused && !candidate?.isConnected)) trackedMediaElements.delete(candidate);
        if (trackedMediaElements.size <= 192) break;
    }
    while (trackedMediaElements.size > 256) trackedMediaElements.delete(trackedMediaElements.values().next().value);
}

function valueSourceMatches(value, source) {
    if (!value || !source) return false;
    const stringValue = String(value).replaceAll('&amp;', '&');
    return stringValue === source
        || decodeSourceParameter(stringValue) === source
        || reverseRouteMap.get(stringValue) === source
        || normalizeCandidate(stringValue) === source;
}

function captureMediaPlaybackState(media) {
    return {
        currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0,
        shouldResume: !media.paused && !media.ended,
        volume: media.volume,
        muted: media.muted,
        playbackRate: media.playbackRate,
        loop: media.loop,
    };
}

function restoreMediaPlaybackState(media, state) {
    const restore = () => {
        try {
            media.volume = state.volume;
            media.muted = state.muted;
            media.playbackRate = state.playbackRate;
            media.loop = state.loop;
            if (state.currentTime > 0 && Number.isFinite(state.currentTime)) {
                const maximum = Number.isFinite(media.duration) && media.duration > 0 ? Math.max(0, media.duration - 0.05) : state.currentTime;
                media.currentTime = Math.min(state.currentTime, maximum);
            }
        } catch (error) {
            console.debug('[FrontendMediaLocalizer] 恢复媒体播放状态失败:', error);
        }
        if (state.shouldResume) void media.play().catch(error => console.debug('[FrontendMediaLocalizer] 本地媒体自动续播失败:', error));
    };
    if (media.readyState >= 1) queueMicrotask(restore);
    else media.addEventListener('loadedmetadata', restore, { once: true });
}

function hotSwapMediaElement(media, source, localUrl) {
    if (!media || media.dataset?.fmlHotSwapping === 'true') return false;
    const directMatch = valueSourceMatches(media.getAttribute('src'), source) || valueSourceMatches(media.currentSrc, source);
    const matchingSources = [...(media.querySelectorAll?.('source[src]') || [])].filter(element => valueSourceMatches(element.getAttribute('src'), source));
    if (!directMatch && !matchingSources.length) return false;

    const state = captureMediaPlaybackState(media);
    if (media.dataset) media.dataset.fmlHotSwapping = 'true';
    try {
        if (directMatch) setMediaAttributeWithoutRouting(media, 'src', localUrl);
        matchingSources.forEach(element => setMediaAttributeWithoutRouting(element, 'src', localUrl));
        media.load();
        restoreMediaPlaybackState(media, state);
        rememberMediaElement(media);
        return true;
    } finally {
        if (media.dataset) delete media.dataset.fmlHotSwapping;
    }
}

function accessibleDocuments(root = document, output = new Set()) {
    if (!root || output.has(root)) return output;
    output.add(root);
    root.querySelectorAll?.('iframe').forEach(iframe => {
        try {
            if (iframe.contentDocument) accessibleDocuments(iframe.contentDocument, output);
        } catch { /* cross-origin iframe */ }
    });
    return output;
}

function hotSwapDocumentResource(documentRef, source, localUrl, processedMedia) {
    if (!documentRef) return 0;
    if (documentRef !== document) bindDocumentMediaFallback(documentRef);
    let switched = 0;

    documentRef.querySelectorAll('audio, video').forEach(media => {
        processedMedia.add(media);
        if (hotSwapMediaElement(media, source, localUrl)) switched++;
    });
    documentRef.querySelectorAll('img[src], input[type="image"][src]').forEach(element => {
        if (!valueSourceMatches(element.getAttribute('src'), source)) return;
        setMediaAttributeWithoutRouting(element, 'src', localUrl);
        switched++;
    });
    documentRef.querySelectorAll('source[src]').forEach(element => {
        if (['audio', 'video'].includes(String(element.parentElement?.tagName || '').toLowerCase())) return;
        if (!valueSourceMatches(element.getAttribute('src'), source)) return;
        setMediaAttributeWithoutRouting(element, 'src', localUrl);
        switched++;
    });
    documentRef.querySelectorAll('video[poster]').forEach(element => {
        if (!valueSourceMatches(element.getAttribute('poster'), source)) return;
        setMediaAttributeWithoutRouting(element, 'poster', localUrl);
        switched++;
    });
    documentRef.querySelectorAll('[srcset]').forEach(element => {
        const value = element.getAttribute('srcset') || '';
        const replacement = rewriteText(value);
        if (replacement === value) return;
        setMediaAttributeWithoutRouting(element, 'srcset', replacement);
        switched++;
    });
    documentRef.querySelectorAll('[style]').forEach(element => {
        const value = element.getAttribute('style') || '';
        const replacement = rewriteText(value);
        if (replacement === value) return;
        setMediaAttributeWithoutRouting(element, 'style', replacement);
        switched++;
    });
    documentRef.querySelectorAll('style').forEach(element => {
        const value = element.textContent || '';
        const replacement = rewriteText(value);
        if (replacement === value) return;
        element.textContent = replacement;
        switched++;
    });
    return switched;
}

async function activateDownloadedResource(cardName, resource) {
    if (!resource?.source || !resource?.localUrl) return 0;
    const normalized = { ...resource, exists: true, status: 'downloaded' };
    markSniffRecordSaved(cardName, normalized);
    if (currentCard?.name !== cardName) return 0;
    libraryMutationSequence++;
    const index = currentLibrary.findIndex(item => item.id === normalized.id || item.source === normalized.source);
    if (index >= 0) currentLibrary[index] = { ...currentLibrary[index], ...normalized };
    else currentLibrary.push(normalized);
    setRouteMap(currentLibrary);
    updateSettingsSummary();
    updateFloatingButton();
    if (!shouldUseLocalRoutes()) return 0;
    const activeLocalUrl = localResourceUrl(normalized.localUrl);

    const processedMedia = new Set();
    let switched = 0;
    try {
        for (const documentRef of accessibleDocuments()) switched += hotSwapDocumentResource(documentRef, normalized.source, activeLocalUrl, processedMedia);
        for (const media of [...trackedMediaElements]) {
            if (!media) {
                trackedMediaElements.delete(media);
                continue;
            }
            if (processedMedia.has(media)) continue;
            if (hotSwapMediaElement(media, normalized.source, activeLocalUrl)) switched++;
        }
        if (switched > 0) {
            setLatestLoadedResource({ source: normalized.source, actual: activeLocalUrl, type: normalized.type, local: true }, '下载完成后静默热切换');
        }
        console.info('[FrontendMediaLocalizer] 本地资源路由已热更新', {
            原始链接: normalized.source,
            本地链接: activeLocalUrl,
            原地切换数量: switched,
            保留前端卡运行状态: true,
        });
    } catch (error) {
        console.error('[FrontendMediaLocalizer] 资源热切换失败，后续加载仍会使用本地路由:', error);
    }
    return switched;
}

function rewriteText(text) {
    if (typeof text !== 'string' || !getSettings().enabled) return text;
    if (isOfflineMode()) {
        URL_PATTERN.lastIndex = 0;
        return text.replace(URL_PATTERN, match => {
            const raw = match.trim().replace(/[),;\]}]+$/g, '');
            const suffix = match.slice(raw.length);
            const info = currentCardResource(raw);
            if (!info) return match;
            const localUrl = serverAvailable && getSettings().useLocalResources ? routeMap.get(info.source) : null;
            return `${localUrl ? localResourceUrl(localUrl) : offlineResourceUrl(info.source, info.type)}${suffix}`;
        });
    }
    if (!serverAvailable || !getSettings().useLocalResources || !routeRegex) return text;
    routeRegex.lastIndex = 0;
    return text.replace(routeRegex, match => {
        const localUrl = routeMap.get(match);
        return localUrl ? localResourceUrl(localUrl) : match;
    });
}

function shouldUseLocalRoutes() {
    const settings = getSettings();
    return Boolean(serverAvailable && settings.enabled && settings.useLocalResources && !settings.onlineMode && routeMap.size);
}

function canonicalManagedResourceRoute(value) {
    if (typeof value !== 'string' || !value) return null;
    let decoded = value.replaceAll('&amp;', '&');
    const markers = [`${API_BASE}/file/`, OFFLINE_PLACEHOLDER_PATH, `${OFFLINE_BLOCKED_PATH}-`];
    for (let attempt = 0; attempt < 4; attempt++) {
        for (const marker of markers) {
            const index = decoded.indexOf(marker);
            if (index < 0) continue;
            try {
                const url = new URL(decoded.slice(index), location.origin);
                const recognized = url.pathname.startsWith(`${API_BASE}/file/`)
                    || url.pathname === OFFLINE_PLACEHOLDER_PATH
                    || url.pathname.startsWith(`${OFFLINE_BLOCKED_PATH}-`);
                if (recognized) return `${url.pathname}${url.search}${url.hash}`;
            } catch { return null; }
        }
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch { break; }
    }
    return null;
}

function canonicalLocalRoute(value) {
    const route = canonicalManagedResourceRoute(value);
    return route?.startsWith(`${API_BASE}/file/`) ? route : null;
}

function routeForDynamicValue(element, attribute, value, reason = '') {
    if (typeof value !== 'string' || !value) return value;
    const documentRef = element?.ownerDocument;
    const state = documentRef?._fmlRuntimeRouterState;
    if (state?.bypass.has(element)) return value;

    if (['style', 'cssText', 'innerHTML', 'outerHTML', 'srcset'].includes(attribute)) {
        observeRuntimeValue(element, attribute, value, reason);
        if (!shouldUseLocalRoutes() && !isOfflineMode()) return value;
        return rewriteText(value);
    }

    if (isOfflineResourceUrl(value)) {
        const source = decodeSourceParameter(value);
        let type = runtimeTypeForElement(element, source, reason);
        try { type = new URL(value, location.origin).searchParams.get('type') || type; } catch { /* keep inferred type */ }
        if (source && ['audio', 'video'].includes(type)) showOfflineMissingNotice(source, type);
        return value;
    }

    const embeddedLocalRoute = canonicalManagedResourceRoute(value);
    if (embeddedLocalRoute) {
        const embeddedSource = decodeSourceParameter(embeddedLocalRoute);
        if (!embeddedSource) return value;
        const typeHint = attribute === 'poster' ? 'image' : runtimeTypeForElement(element, embeddedSource, reason);
        observeRuntimeSource(embeddedSource, typeHint, reason, embeddedLocalRoute);
        const fallback = state?.fallbackSources.get(element)?.get(attribute);
        const expectedLocalRoute = routeMap.get(embeddedSource);
        if (isOfflineMode()) {
            const info = currentCardResource(embeddedSource, typeHint);
            if (!info) return embeddedSource;
            if (serverAvailable && getSettings().useLocalResources && expectedLocalRoute) return localResourceUrl(expectedLocalRoute);
            if (info.type !== 'image') showOfflineMissingNotice(info.source, info.type);
            return offlineResourceUrl(info.source, info.type);
        }
        if (!shouldUseLocalRoutes() || fallback === embeddedSource || !expectedLocalRoute) return embeddedSource;
        if (value !== expectedLocalRoute) {
            console.info('[FrontendMediaLocalizer] 已修复前端卡二次拼接的本地路由', {
                错误地址: value,
                修复地址: expectedLocalRoute,
                原始在线地址: embeddedSource,
                拦截位置: reason || `${element?.tagName || 'element'}.${attribute}`,
            });
        }
        return localResourceUrl(expectedLocalRoute);
    }

    observeRuntimeValue(element, attribute, value, reason);
    const source = normalizeCandidate(value);
    if (!source) return value;
    const typeHint = attribute === 'poster' ? 'image' : runtimeTypeForElement(element, source, reason);
    const info = currentCardResource(source, typeHint);
    const fallback = state?.fallbackSources.get(element)?.get(attribute);
    if (!isOfflineMode() && fallback === source) return value;
    if (fallback && fallback !== source) state.fallbackSources.get(element)?.delete(attribute);
    const localUrl = routeMap.get(value) || routeMap.get(source);
    if (localUrl && shouldUseLocalRoutes()) {
        console.info('[FrontendMediaLocalizer] 动态资源映射命中', {
            类型: info?.type || inferType(source, `${element?.tagName || ''}.${attribute}`),
            原始链接: source,
            本地链接: localUrl,
            拦截位置: reason || `${element?.tagName || 'element'}.${attribute}`,
        });
        return localResourceUrl(localUrl);
    }
    if (isOfflineMode() && info) {
        if (info.type !== 'image') showOfflineMissingNotice(info.source, info.type);
        return offlineResourceUrl(info.source, info.type);
    }
    if (!shouldUseLocalRoutes()) return value;

    return value;
}

function setMediaAttributeWithoutRouting(element, attribute, value, markFallback = false) {
    const state = element?.ownerDocument?._fmlRuntimeRouterState;
    if (markFallback && state) {
        let attributes = state.fallbackSources.get(element);
        if (!attributes) {
            attributes = new Map();
            state.fallbackSources.set(element, attributes);
        }
        const source = normalizeCandidate(value);
        if (source) attributes.set(attribute, source);
    }
    state?.bypass.add(element);
    try {
        element.setAttribute(attribute, value);
    } finally {
        state?.bypass.delete(element);
    }
}

function applyRoutedAttribute(element, attribute, value, reason) {
    if (!value) return false;
    const replacement = routeForDynamicValue(element, attribute, value, reason);
    if (!replacement || replacement === value) return false;
    const tag = String(element?.tagName || '').toLowerCase();
    if (attribute === 'src' && ['audio', 'video'].includes(tag) && canonicalLocalRoute(replacement)) {
        const source = decodeSourceParameter(replacement) || normalizeCandidate(value);
        if (source && hotSwapMediaElement(element, source, replacement)) return true;
    }
    setMediaAttributeWithoutRouting(element, attribute, replacement);
    return true;
}

function installDocumentRuntimeRouter(documentRef) {
    if (!documentRef?.defaultView || documentRef === document || documentRef._fmlRuntimeRouterState) return;
    const windowRef = documentRef.defaultView;
    const state = {
        bypass: new WeakSet(),
        fallbackSources: new WeakMap(),
        restorers: [],
    };
    documentRef._fmlRuntimeRouterState = state;

    const patchProperty = (prototype, property, attribute = property) => {
        if (!prototype) return;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (!descriptor?.set || !descriptor.configurable) return;
        try {
            Object.defineProperty(prototype, property, {
                ...descriptor,
                set(value) {
                    if (attribute === 'src') rememberMediaElement(this);
                    const routed = routeForDynamicValue(this, attribute, value, `${this.tagName || prototype.constructor?.name}.${property} 赋值`);
                    return descriptor.set.call(this, routed);
                },
            });
            state.restorers.push(() => Object.defineProperty(prototype, property, descriptor));
        } catch (error) {
            console.debug(`[FrontendMediaLocalizer] 无法拦截 ${prototype.constructor?.name}.${property}:`, error);
        }
    };

    const originalSetAttribute = windowRef.Element?.prototype?.setAttribute;
    if (originalSetAttribute) {
        windowRef.Element.prototype.setAttribute = function (name, value) {
            const attribute = String(name).toLowerCase();
            if (attribute === 'src') rememberMediaElement(this);
            const routable = ['src', 'srcset', 'poster', 'style'].includes(attribute);
            const routed = routable ? routeForDynamicValue(this, attribute, String(value), `setAttribute(${attribute})`) : value;
            return originalSetAttribute.call(this, name, routed);
        };
        state.restorers.push(() => { windowRef.Element.prototype.setAttribute = originalSetAttribute; });
    }

    patchProperty(windowRef.HTMLImageElement?.prototype, 'src');
    patchProperty(windowRef.HTMLImageElement?.prototype, 'srcset');
    patchProperty(windowRef.HTMLMediaElement?.prototype, 'src');
    patchProperty(windowRef.HTMLSourceElement?.prototype, 'src');
    patchProperty(windowRef.HTMLVideoElement?.prototype, 'poster');
    patchProperty(windowRef.Element?.prototype, 'innerHTML');
    patchProperty(windowRef.Element?.prototype, 'outerHTML');
    patchProperty(windowRef.CSSStyleDeclaration?.prototype, 'cssText');
    patchProperty(windowRef.CSSStyleDeclaration?.prototype, 'background', 'style');
    patchProperty(windowRef.CSSStyleDeclaration?.prototype, 'backgroundImage', 'style');

    const originalInsertAdjacentHTML = windowRef.Element?.prototype?.insertAdjacentHTML;
    if (originalInsertAdjacentHTML) {
        windowRef.Element.prototype.insertAdjacentHTML = function (position, text) {
            return originalInsertAdjacentHTML.call(this, position, rewriteText(String(text)));
        };
        state.restorers.push(() => { windowRef.Element.prototype.insertAdjacentHTML = originalInsertAdjacentHTML; });
    }

    const originalStyleSetProperty = windowRef.CSSStyleDeclaration?.prototype?.setProperty;
    if (originalStyleSetProperty) {
        windowRef.CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
            return originalStyleSetProperty.call(this, property, rewriteText(String(value)), priority);
        };
        state.restorers.push(() => { windowRef.CSSStyleDeclaration.prototype.setProperty = originalStyleSetProperty; });
    }

    const originalFetch = windowRef.fetch;
    if (typeof originalFetch === 'function') {
        windowRef.fetch = function (input, init) {
            const source = typeof input === 'string' || input instanceof windowRef.URL ? String(input) : input?.url;
            if (!source) return originalFetch.call(this, input, init);
            const routed = routeForDynamicValue(null, 'src', source, 'iframe fetch()');
            if (routed === source) return originalFetch.call(this, input, init);
            const request = input instanceof windowRef.Request ? new windowRef.Request(routed, input) : routed;
            return originalFetch.call(this, request, init);
        };
        state.restorers.push(() => { windowRef.fetch = originalFetch; });
    }

    const originalXhrOpen = windowRef.XMLHttpRequest?.prototype?.open;
    if (originalXhrOpen) {
        windowRef.XMLHttpRequest.prototype.open = function (method, url, ...args) {
            const source = typeof url === 'string' || url instanceof windowRef.URL ? String(url) : url;
            const routed = typeof source === 'string' ? routeForDynamicValue(null, 'src', source, 'iframe XMLHttpRequest.open()') : url;
            return originalXhrOpen.call(this, method, routed, ...args);
        };
        state.restorers.push(() => { windowRef.XMLHttpRequest.prototype.open = originalXhrOpen; });
    }

    const OriginalAudio = windowRef.Audio;
    if (typeof OriginalAudio === 'function') {
        const LocalizedAudio = function (source) {
            const routed = typeof source === 'string' ? routeForDynamicValue(null, 'src', source, 'new Audio(url)') : source;
            const audio = new OriginalAudio(routed);
            rememberMediaElement(audio);
            return audio;
        };
        LocalizedAudio.prototype = OriginalAudio.prototype;
        Object.setPrototypeOf(LocalizedAudio, OriginalAudio);
        windowRef.Audio = LocalizedAudio;
        state.restorers.push(() => { windowRef.Audio = OriginalAudio; });
    }

    const originalMediaPlay = windowRef.HTMLMediaElement?.prototype?.play;
    if (originalMediaPlay) {
        windowRef.HTMLMediaElement.prototype.play = function (...args) {
            observeMediaElementActivity(this, 'HTMLMediaElement.play()');
            return originalMediaPlay.apply(this, args);
        };
        state.restorers.push(() => { windowRef.HTMLMediaElement.prototype.play = originalMediaPlay; });
    }

    const originalMediaLoad = windowRef.HTMLMediaElement?.prototype?.load;
    if (originalMediaLoad) {
        windowRef.HTMLMediaElement.prototype.load = function (...args) {
            observeMediaElementActivity(this, 'HTMLMediaElement.load()');
            return originalMediaLoad.apply(this, args);
        };
        state.restorers.push(() => { windowRef.HTMLMediaElement.prototype.load = originalMediaLoad; });
    }

    const rewriteElement = element => {
        if (!element || element.nodeType !== 1) return;
        for (const attribute of ['src', 'srcset', 'poster', 'style']) {
            const value = element.getAttribute(attribute);
            const replacement = routeForDynamicValue(element, attribute, value, `DOM ${attribute} 变化`);
            if (replacement && replacement !== value) originalSetAttribute.call(element, attribute, replacement);
        }
        element.querySelectorAll?.('[src], [srcset], [poster], [style]').forEach(rewriteElement);
    };
    const observer = new windowRef.MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') rewriteElement(mutation.target);
            else mutation.addedNodes.forEach(rewriteElement);
        }
    });
    observer.observe(documentRef.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'poster', 'style'],
    });
    state.observer = observer;
    rewriteElement(documentRef.documentElement);
    console.debug('[FrontendMediaLocalizer] 已安装 iframe 动态资源本地路由器');
}

function installTopLevelAudioRouter() {
    if (window._fmlTopLevelAudioRouterInstalled) return;
    window._fmlTopLevelAudioRouterInstalled = true;

    const isCardAudioSource = value => {
        const embeddedRoute = canonicalManagedResourceRoute(value);
        const source = decodeSourceParameter(embeddedRoute || value) || reverseRouteMap.get(value) || normalizeCandidate(value);
        return Boolean(source && (currentCandidates.has(source) || routeMap.has(source)));
    };

    const OriginalAudio = window.Audio;
    if (typeof OriginalAudio === 'function') {
        const LocalizedAudio = function (source) {
            const routed = typeof source === 'string' && isCardAudioSource(source)
                ? routeForDynamicValue(null, 'src', source, '父页面 new Audio(url)')
                : source;
            const audio = new OriginalAudio(routed);
            rememberMediaElement(audio);
            return audio;
        };
        LocalizedAudio.prototype = OriginalAudio.prototype;
        Object.setPrototypeOf(LocalizedAudio, OriginalAudio);
        window.Audio = LocalizedAudio;
    }

    const patchSourceProperty = prototype => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'src');
        if (!descriptor?.set || !descriptor.configurable) return;
        try {
            Object.defineProperty(prototype, 'src', {
                ...descriptor,
                set(value) {
                    rememberMediaElement(this);
                    const routed = typeof value === 'string' && isCardAudioSource(value)
                        ? routeForDynamicValue(this, 'src', value, '父页面音频 src 赋值')
                        : value;
                    return descriptor.set.call(this, routed);
                },
            });
        } catch (error) {
            console.debug('[FrontendMediaLocalizer] 无法拦截父页面音频 src:', error);
        }
    };
    patchSourceProperty(window.HTMLMediaElement?.prototype);
    patchSourceProperty(window.HTMLSourceElement?.prototype);

    const originalPlay = window.HTMLMediaElement?.prototype?.play;
    if (originalPlay) {
        window.HTMLMediaElement.prototype.play = function (...args) {
            const info = mediaInfoFromElement(this);
            if (info?.type === 'audio' && currentCandidates.has(info.source)) {
                observeMediaElementActivity(this, '父页面 HTMLMediaElement.play()');
            }
            return originalPlay.apply(this, args);
        };
    }
}

function decodeSourceParameter(value) {
    try {
        const url = new URL(String(value).replaceAll('&amp;', '&'), location.origin);
        const isLocalFile = url.pathname.startsWith(`${API_BASE}/file/`);
        const isOfflineResource = url.pathname === OFFLINE_PLACEHOLDER_PATH || url.pathname.startsWith(`${OFFLINE_BLOCKED_PATH}-`);
        if (!isLocalFile && !isOfflineResource) return null;
        const encoded = url.searchParams.get('source');
        if (!encoded) return null;
        const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const source = new TextDecoder().decode(bytes);
        return /^https?:\/\//i.test(source) ? source : null;
    } catch { return null; }
}

function restoreText(text) {
    if (typeof text !== 'string' || !text) return text;
    let restored = text;
    if (reverseRouteRegex) {
        reverseRouteRegex.lastIndex = 0;
        restored = restored.replace(reverseRouteRegex, match => reverseRouteMap.get(match) || decodeSourceParameter(match) || match);
    }
    const localPattern = new RegExp(`(?:https?:\\/\\/[^\\s<>"'\\)]+)?${escapeRegExp(API_BASE)}\\/file\\/[^\\s<>"'\\)]+`, 'g');
    restored = restored.replace(localPattern, match => decodeSourceParameter(match.replaceAll('&amp;', '&')) || match);
    const offlinePattern = new RegExp(`(?:https?:\\/\\/[^\\s<>"'\\)]+)?${escapeRegExp(EXTENSION_PUBLIC_PATH)}\\/(?:offline-placeholder\\.svg|offline-blocked-(?:audio|video)\\.bin)[^\\s<>"'\\)]*`, 'g');
    return restored.replace(offlinePattern, match => decodeSourceParameter(match.replaceAll('&amp;', '&')) || match);
}

function rewriteMessage(messageId) {
    if (!getSettings().enabled || (!isOfflineMode() && (!getSettings().useLocalResources || !serverAvailable || !routeMap.size))) return;
    const hasMessageId = messageId !== null && messageId !== undefined && Number.isFinite(Number(messageId));
    const selector = hasMessageId ? `#chat > .mes[mesid="${Number(messageId)}"]` : '#chat > .mes';
    document.querySelectorAll(`${selector} pre code`).forEach(code => {
        const original = code.textContent || '';
        const rewritten = rewriteText(original);
        if (rewritten !== original) code.textContent = rewritten;
    });
}

function restoreMessage(messageId = null) {
    const hasMessageId = messageId !== null && messageId !== undefined && Number.isFinite(Number(messageId));
    const selector = hasMessageId ? `#chat > .mes[mesid="${Number(messageId)}"]` : '#chat > .mes';
    document.querySelectorAll(`${selector} pre code`).forEach(code => {
        const current = code.textContent || '';
        const restored = restoreText(current);
        if (restored !== current) code.textContent = restored;
    });
}

function rewriteAllMessages() {
    rewriteMessage(null);
}

function rewriteIframe(iframe) {
    if (!iframe?.contentDocument || !getSettings().enabled || (!isOfflineMode() && (!serverAvailable || !getSettings().useLocalResources || !routeMap.size))) return;
    const documentRef = iframe.contentDocument;
    bindDocumentMediaFallback(documentRef);
    installDocumentRuntimeRouter(documentRef);
    documentRef.querySelectorAll('img[src], audio[src], video[src], source[src], video[poster]').forEach(element => {
        for (const attribute of ['src', 'poster']) {
            const value = element.getAttribute(attribute);
            applyRoutedAttribute(element, attribute, value, `iframe 初始 ${attribute}`);
        }
    });
    documentRef.querySelectorAll('[style]').forEach(element => {
        const value = element.getAttribute('style');
        const replacement = rewriteText(value);
        if (replacement !== value) setMediaAttributeWithoutRouting(element, 'style', replacement);
    });
    documentRef.querySelectorAll('style').forEach(element => {
        const value = element.textContent || '';
        const replacement = rewriteText(value);
        if (replacement !== value) element.textContent = replacement;
    });
}

function bindDocumentMediaFallback(documentRef) {
    if (!documentRef || documentRef.documentElement?.dataset.fmlFallbackBound === 'true') return;
    ensureRuntimeSession(documentRef);
    installDocumentRuntimeRouter(documentRef);
    documentRef.addEventListener('error', handleLocalizedMediaError, true);
    documentRef.addEventListener('load', handleMediaLoaded, true);
    documentRef.addEventListener('loadeddata', handleMediaLoaded, true);
    documentRef.addEventListener('loadedmetadata', handleMediaLoaded, true);
    documentRef.addEventListener('canplay', handleMediaLoaded, true);
    documentRef.addEventListener('play', handleMediaLoaded, true);
    documentRef.addEventListener('playing', handleMediaLoaded, true);
    const windowRef = documentRef.defaultView;
    if (windowRef?.PerformanceObserver && !documentRef._fmlResourceObserver) {
        try {
            const observer = new windowRef.PerformanceObserver(list => {
                for (const entry of list.getEntries()) processRuntimeResourceEntry(entry, documentRef);
                updateFloatingButton();
            });
            observer.observe({ type: 'resource', buffered: true });
            documentRef._fmlResourceObserver = observer;
        } catch { /* resource observation unavailable */ }
    }
    if (documentRef.documentElement) documentRef.documentElement.dataset.fmlFallbackBound = 'true';
}

function restoreDocumentResources(documentRef) {
    if (!documentRef) return;
    bindDocumentMediaFallback(documentRef);
    documentRef.querySelectorAll('img[src], audio[src], video[src], source[src], video[poster]').forEach(element => {
        for (const attribute of ['src', 'poster']) {
            const value = element.getAttribute(attribute);
            const replacement = value && (reverseRouteMap.get(value) || decodeSourceParameter(value));
            if (replacement) element.setAttribute(attribute, replacement);
        }
    });
    documentRef.querySelectorAll('[style]').forEach(element => {
        const value = element.getAttribute('style');
        const replacement = restoreText(value);
        if (replacement !== value) element.setAttribute('style', replacement);
    });
    documentRef.querySelectorAll('style').forEach(element => {
        const value = element.textContent || '';
        const replacement = restoreText(value);
        if (replacement !== value) element.textContent = replacement;
    });
}

function restoreAllLocalizedContent() {
    restoreMessage(null);
    restoreDocumentResources(document);
    document.querySelectorAll('iframe').forEach(iframe => {
        try { restoreDocumentResources(iframe.contentDocument); } catch { /* cross-origin iframe */ }
    });
}

function applyOnlineResourcePolicy() {
    restoreAllLocalizedContent();
    for (const media of [...trackedMediaElements]) {
        if (!media) {
            trackedMediaElements.delete(media);
            continue;
        }
        const value = media.getAttribute?.('src') || media.currentSrc;
        const source = value && (decodeSourceParameter(value) || reverseRouteMap.get(value));
        if (!source || source === value) continue;
        hotSwapMediaElement(media, source, source);
    }
}

function applyCurrentResourcePolicy() {
    if (!getSettings().enabled) return;
    rewriteAllMessages();
    document.querySelectorAll('#chat > .mes img[src], #chat > .mes audio[src], #chat > .mes video[src], #chat > .mes source[src], #chat > .mes video[poster]').forEach(element => {
        for (const attribute of ['src', 'poster']) {
            const value = element.getAttribute(attribute);
            applyRoutedAttribute(element, attribute, value, `父页面当前内容 ${attribute}`);
        }
    });
    document.querySelectorAll('iframe').forEach(iframe => {
        try { rewriteIframe(iframe); } catch (error) { console.debug('[FrontendMediaLocalizer] 应用 iframe 资源策略失败:', error); }
    });
    for (const media of [...trackedMediaElements]) {
        if (!media) {
            trackedMediaElements.delete(media);
            continue;
        }
        const value = media.getAttribute?.('src') || media.currentSrc;
        if (!value) continue;
        const replacement = routeForDynamicValue(media, 'src', value, '已跟踪媒体切换策略');
        if (!replacement || replacement === value) continue;
        const playback = captureMediaPlaybackState(media);
        setMediaAttributeWithoutRouting(media, 'src', replacement);
        try { media.load(); } catch { /* detached media */ }
        if (!isOfflineResourceUrl(replacement)) restoreMediaPlaybackState(media, playback);
    }
}

function applyConfiguredResourcePolicy() {
    const settings = getSettings();
    if (!settings.enabled || settings.onlineMode || (!serverAvailable && !isOfflineMode())) {
        applyOnlineResourcePolicy();
        return;
    }
    applyCurrentResourcePolicy();
}

function handleLocalizedMediaError(event) {
    const element = event.target;
    if (!element || element.nodeType !== 1 || typeof element.getAttribute !== 'function') return;
    let restored = false;
    for (const attribute of ['src', 'poster']) {
        const value = element.getAttribute(attribute);
        const replacement = value && (reverseRouteMap.get(value) || decodeSourceParameter(value));
        if (!replacement) continue;
        const typeHint = attribute === 'poster' ? 'image' : runtimeTypeForElement(element, replacement, `媒体错误 ${attribute}`);
        const info = currentCardResource(replacement, typeHint);
        if (isOfflineMode() && info) {
            const blockedUrl = offlineResourceUrl(info.source, info.type);
            if (!isOfflineResourceUrl(value)) setMediaAttributeWithoutRouting(element, attribute, blockedUrl);
            const media = ['audio', 'video'].includes(String(element.tagName || '').toLowerCase())
                ? element
                : ['audio', 'video'].includes(String(element.parentElement?.tagName || '').toLowerCase())
                    ? element.parentElement
                    : null;
            if (media) {
                try { media.pause(); } catch { /* already stopped */ }
            }
            if (info.type !== 'image') showOfflineMissingNotice(info.source, info.type);
            continue;
        }
        setMediaAttributeWithoutRouting(element, attribute, replacement, true);
        restored = true;
    }
    if (restored) void checkServer();
}

function mediaInfoFromElement(element) {
    if (!element || element.nodeType !== 1 || typeof element.getAttribute !== 'function') return null;
    const tag = String(element.tagName || '').toLowerCase();
    const sourceParentTag = String(element.parentElement?.tagName || '').toLowerCase();
    const sourceMimeType = String(element.type || '').split('/')[0];
    const type = tag === 'img'
        ? 'image'
        : tag === 'audio'
            ? 'audio'
            : tag === 'video'
                ? 'video'
                : tag === 'source'
                    ? (['audio', 'video'].includes(sourceParentTag) ? sourceParentTag : MEDIA_TYPES.includes(sourceMimeType) ? sourceMimeType : inferType(element.src || ''))
                    : null;
    if (!MEDIA_TYPES.includes(type)) return null;
    const actual = element.currentSrc || element.src || element.getAttribute('src') || (type === 'video' ? element.poster : '');
    if (!actual) return null;
    const source = decodeSourceParameter(actual) || reverseRouteMap.get(actual) || normalizeCandidate(actual);
    if (!source) return null;
    const local = Boolean(canonicalLocalRoute(actual));
    return { source, actual: String(actual), type, local };
}

function runtimeTypeForElement(element, source, context = '') {
    const tag = String(element?.tagName || '').toLowerCase();
    if (tag === 'img') return 'image';
    if (tag === 'audio') return 'audio';
    if (tag === 'video') return 'video';
    if (tag === 'source') {
        const parentTag = String(element.parentElement?.tagName || '').toLowerCase();
        if (parentTag === 'audio' || parentTag === 'video') return parentTag;
        const mimeType = String(element.type || '').split('/')[0];
        if (MEDIA_TYPES.includes(mimeType)) return mimeType;
    }
    return inferType(source, `${context} ${tag}`);
}

function addRuntimeCandidate(source, type, reason) {
    if (!source || !type || currentCandidates.has(source)) return;
    currentCandidates.set(source, {
        url: source,
        type,
        hint: type,
        size: null,
        contentType: null,
        error: null,
        selected: true,
        fields: new Set([reason || '运行时加载']),
        aliases: new Set([source]),
        status: 'detected',
    });
    updateSettingsSummary();
}

function observeRuntimeSource(sourceValue, typeHint, reason, actualValue = sourceValue, documentRef = null) {
    if (!getSettings().enabled || !currentCard) return;
    const actual = String(actualValue || sourceValue || '');
    const source = decodeSourceParameter(actual) || reverseRouteMap.get(actual) || normalizeCandidate(sourceValue);
    if (!source) return;
    const type = typeHint || inferType(source, reason);
    if (!MEDIA_TYPES.includes(type)) return;
    addRuntimeCandidate(source, type, reason);
    const local = Boolean(canonicalLocalRoute(actual));
    if (getSettings().sniffingEnabled) {
        const session = touchRuntimeSession(documentRef, reason);
        registerSniffedResource({
            source,
            actual,
            type,
            local,
            cardName: currentCard.name,
            sessionId: session?.id || null,
            reason,
        });
    }
}

function observeRuntimeValue(element, attribute, value, reason = '') {
    if (!getSettings().enabled || !currentCard || typeof value !== 'string' || !value) return;
    const context = `${reason} ${attribute}`;
    if (['style', 'cssText', 'innerHTML', 'outerHTML', 'srcset'].includes(attribute)) {
        const found = new Map();
        collectFromString(value, context, found);
        for (const item of found.values()) {
            const type = runtimeTypeForElement(element, item.url, context) || item.type;
            observeRuntimeSource(item.url, type, context, item.url, element?.ownerDocument || null);
        }
        return;
    }
    const normalized = decodeSourceParameter(value) || reverseRouteMap.get(value) || normalizeCandidate(value);
    if (!normalized) return;
    observeRuntimeSource(normalized, runtimeTypeForElement(element, normalized, context), context, value, element?.ownerDocument || null);
}

function observeMediaElementActivity(element, reason) {
    const info = mediaInfoFromElement(element);
    if (!info) return;
    rememberMediaElement(element);
    addRuntimeCandidate(info.source, info.type, reason);
    setLatestLoadedResource(info, reason);
    if (getSettings().sniffingEnabled) {
        const session = touchRuntimeSession(element.ownerDocument, reason)
            || (element.ownerDocument === document ? activeRuntimeSession() : null);
        if (session && element.ownerDocument === document) {
            session.lastActivityAt = Date.now();
            session.lastActivityReason = reason;
        }
        registerSniffedResource({ ...info, cardName: currentCard?.name, sessionId: session?.id || null, reason });
    }
}

function setLatestLoadedResource(info, reason) {
    latestLoadedResource = { ...info, cardName: currentCard?.name || null, loadedAt: Date.now() };
    const settings = getSettings();
    const isLocal = Boolean(info.local && serverAvailable && settings.useLocalResources);
    const offlineBlocked = isOfflineResourceUrl(info.actual);
    const fallbackReason = offlineBlocked
        ? '离线模式已阻止在线加载，当前显示缺失占位或阻断状态'
        : !info.local
        ? '实际加载的是原始在线地址'
        : !serverAvailable
            ? '后端未连接，已按回退逻辑显示云端'
            : !settings.useLocalResources
                ? '“使用本地资源”已关闭，已按回退逻辑显示云端'
                : '通过本地资源路由加载';
    console.info('[FrontendMediaLocalizer] 悬浮球资源判定', {
        显示: isLocal ? '本地盒子' : '云朵',
        类型: info.type,
        原始链接: info.source,
        实际加载链接: info.actual,
        判定原因: fallbackReason,
        离线模式: settings.offlineMode,
        触发位置: reason,
        后端已连接: serverAvailable,
        使用本地资源: settings.useLocalResources,
    });
    updateFloatingButton();
}

function handleMediaLoaded(event) {
    if (!getSettings().enabled) return;
    const info = mediaInfoFromElement(event.target);
    if (!info) return;
    if (event.target.ownerDocument === document && !event.target.closest('#chat > .mes')) {
        const isCurrentCardAudio = info.type === 'audio' && currentCandidates.has(info.source) && ['loadedmetadata', 'canplay', 'play', 'playing'].includes(event.type);
        if (!isCurrentCardAudio) return;
    }
    observeMediaElementActivity(event.target, `媒体事件：${event.type || 'loaded'}`);
}

function sniffFilename(url, type, contentType = '') {
    let name = '';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { /* fallback below */ }
    name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
    const hasExtension = /\.[a-z0-9]{2,8}$/i.test(name);
    const mimeExtension = String(contentType).split('/')[1]?.split(/[;+]/)[0]?.replace('jpeg', 'jpg');
    const fallbackExtension = type === 'image' ? 'img' : type === 'audio' ? 'audio' : 'video';
    if (!name) name = `resource-${Date.now()}.${mimeExtension || fallbackExtension}`;
    else if (!hasExtension) name += `.${mimeExtension || fallbackExtension}`;
    return name;
}

function sniffRecordKey(cardName, source) {
    return `${cardName || ''}\n${source}`;
}

function runtimeFrameForDocument(documentRef) {
    if (!documentRef || documentRef === document) return null;
    try { return documentRef.defaultView?.frameElement || null; } catch { return null; }
}

function runtimeMessageId(iframe) {
    const value = iframe?.closest?.('#chat > .mes')?.getAttribute('mesid');
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : -1;
}

function isElementInCurrentScene(element) {
    if (!element?.isConnected) return false;
    const target = String(element.tagName || '').toLowerCase() === 'source' ? element.parentElement : element;
    if (!target?.isConnected) return false;
    try {
        const style = target.ownerDocument.defaultView?.getComputedStyle(target);
        if (style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) === 0) return false;
        const rect = target.getBoundingClientRect();
        const width = target.ownerDocument.documentElement?.clientWidth || target.ownerDocument.defaultView?.innerWidth || 0;
        const height = target.ownerDocument.documentElement?.clientHeight || target.ownerDocument.defaultView?.innerHeight || 0;
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
    } catch { return false; }
}

function isRuntimeFrameVisible(iframe) {
    if (!iframe?.isConnected) return false;
    try {
        const style = getComputedStyle(iframe);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = iframe.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
            && rect.left < window.innerWidth && rect.top < window.innerHeight;
    } catch { return false; }
}

function pruneRuntimeSessions() {
    for (const [id, session] of runtimeSessions) {
        let currentDocument = null;
        try { currentDocument = session.iframe?.contentDocument || null; } catch { /* cross-origin iframe */ }
        if (session.iframe?.isConnected && session.documentRef?.defaultView && currentDocument === session.documentRef) continue;
        runtimeSessions.delete(id);
    }
}

function touchRuntimeSession(documentRef, reason = '') {
    const session = ensureRuntimeSession(documentRef);
    if (!session) return null;
    session.lastActivityAt = Date.now();
    session.lastActivityReason = reason;
    return session;
}

function ensureRuntimeSession(documentRef, allowCardRebind = false) {
    if (!documentRef || documentRef === document || !currentCard) return null;
    const existing = runtimeSessionByDocument.get(documentRef);
    if (existing && existing.cardName === currentCard.name) return existing;
    if (existing && !allowCardRebind) return null;
    const iframe = runtimeFrameForDocument(documentRef);
    if (!iframe) return null;
    const now = Date.now();
    const session = {
        id: `runtime-${++runtimeSessionSequence}`,
        cardName: currentCard.name,
        storageCardName: currentStorageCardName || currentCard.name,
        iframe,
        documentRef,
        messageId: runtimeMessageId(iframe),
        createdAt: now,
        lastActivityAt: now,
        lastActivityReason: 'iframe 初始化',
        recordIds: new Set(),
    };
    runtimeSessionByDocument.set(documentRef, session);
    runtimeSessions.set(session.id, session);
    if (!documentRef._fmlRuntimeActivityBound) {
        const markActive = event => touchRuntimeSession(documentRef, `用户交互：${event.type}`);
        for (const eventName of ['pointerdown', 'touchstart', 'keydown', 'focusin']) {
            documentRef.addEventListener(eventName, markActive, { capture: true, passive: eventName !== 'keydown' });
        }
        documentRef._fmlRuntimeActivityBound = true;
    }
    pruneRuntimeSessions();
    return session;
}

function activeRuntimeSession() {
    pruneRuntimeSessions();
    if (!currentCard) return null;
    document.querySelectorAll('#chat iframe').forEach(iframe => {
        if (!isRuntimeFrameVisible(iframe)) return;
        try { ensureRuntimeSession(iframe.contentDocument); } catch { /* cross-origin iframe */ }
    });
    const sessions = [...runtimeSessions.values()]
        .filter(session => session.cardName === currentCard.name && isRuntimeFrameVisible(session.iframe));
    sessions.sort((left, right) => right.lastActivityAt - left.lastActivityAt
        || right.messageId - left.messageId
        || right.createdAt - left.createdAt);
    return sessions[0] || null;
}

function registerSniffedResource(info, options = {}) {
    const settings = getSettings();
    const cardName = info.cardName || currentCard?.name;
    if (!settings.enabled || !cardName || !MEDIA_TYPES.includes(info.type)) return;
    const notificationsBlocked = settings.sniffBlockedUrls.includes(info.source);
    const key = sniffRecordKey(cardName, info.source);
    const now = Date.now();
    const localResource = cardName === currentCard?.name && currentLibrary.find(item => item.exists && item.source === info.source);
    const existing = sniffRecords.get(sniffRecordIndex.get(key));
    if (existing) {
        const wasSaved = existing.state === 'saved';
        existing.actual = info.actual || existing.actual;
        existing.local = Boolean(info.local || localResource);
        existing.lastSeenAt = now;
        existing.lastReason = info.reason || existing.lastReason;
        if (info.sessionId) {
            existing.sessionIds.add(info.sessionId);
            runtimeSessions.get(info.sessionId)?.recordIds.add(existing.id);
        }
        if (existing.local && existing.state !== 'saving') {
            existing.state = 'saved';
            existing.localMissing = false;
            existing.error = null;
            existing.directFailed = false;
            existing.manualStep = null;
            existing.recoveryBlob = null;
            if (localResource) existing.saved = localResource;
        } else if (wasSaved && serverAvailable && cardName === currentCard?.name) {
            existing.state = 'ready';
            existing.localMissing = true;
            existing.saved = null;
            existing.error = null;
            existing.directFailed = false;
            existing.manualStep = 1;
            existing.recoveryBlob = null;
            if (!notificationsBlocked && options.notify !== false && settings.sniffNotifications) showSniffNotification(existing);
            if (options.autoDownload !== false && settings.sniffAutoDownload && !settings.offlineMode) enqueueSniffAutoDownload(existing);
        }
        return existing;
    }
    const downloaded = Boolean(info.local || localResource);
    const record = {
        ...info,
        id: crypto.randomUUID(),
        cardName,
        storageCardName: currentStorageCardName || cardName,
        state: downloaded ? 'saved' : 'ready',
        directFailed: false,
        manualStep: downloaded ? null : 1,
        recoveryBlob: null,
        createdAt: now,
        lastSeenAt: now,
        lastReason: info.reason || '',
        sessionIds: new Set(info.sessionId ? [info.sessionId] : []),
        saved: localResource || null,
    };
    sniffRecords.set(record.id, record);
    sniffRecordIndex.set(key, record.id);
    if (info.sessionId) runtimeSessions.get(info.sessionId)?.recordIds.add(record.id);
    const shouldNotify = !notificationsBlocked && options.notify !== false && !downloaded && settings.sniffNotifications;
    const shouldAutoDownload = options.autoDownload !== false && !downloaded && settings.sniffAutoDownload && !settings.offlineMode;
    if (shouldNotify) showSniffNotification(record);
    if (shouldAutoDownload) enqueueSniffAutoDownload(record);
    return record;
}

function markSniffRecordSaved(cardName, resource) {
    const record = sniffRecords.get(sniffRecordIndex.get(sniffRecordKey(cardName, resource?.source)));
    if (!record) return;
    record.state = 'saved';
    record.local = true;
    record.localMissing = false;
    record.directFailed = false;
    record.manualStep = null;
    record.recoveryBlob = null;
    record.error = null;
    record.saved = resource;
    updateSniffNotification(record);
}

function markSniffRecordFailed(cardName, source, error, type = null) {
    let record = sniffRecords.get(sniffRecordIndex.get(sniffRecordKey(cardName, source)));
    if (!record && MEDIA_TYPES.includes(type)) {
        record = registerSniffedResource({ cardName, source, actual: source, type, local: false, reason: '批量下载失败' }, { notify: false, autoDownload: false });
    }
    if (!record) return;
    record.state = 'failed';
    record.directFailed = true;
    record.manualStep = 2;
    record.recoveryBlob = null;
    record.error = String(error || '下载失败');
    updateSniffNotification(record);
}

function clearSniffNotifications() {
    const container = document.querySelector('#fml-sniff-notification-container');
    container?.querySelectorAll('.fml-sniff-notification').forEach(element => clearTimeout(element._fmlTimer));
    container?.replaceChildren();
}

function ensureSniffContainer() {
    let container = document.querySelector('#fml-sniff-notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'fml-sniff-notification-container';
        container.className = 'fml-sniff-notifications';
        container.addEventListener('click', handleSniffNotificationClick);
        document.body.append(container);
    }
    return container;
}

function showOfflineMissingNotice(source, type) {
    if (!isOfflineMode() || !['audio', 'video'].includes(type)) return;
    const key = `${type}\n${source}`;
    const now = Date.now();
    if (now - (offlineNoticeTimes.get(key) || 0) < 1500) return;
    offlineNoticeTimes.set(key, now);
    if (offlineNoticeTimes.size > 200) {
        for (const [item, time] of offlineNoticeTimes) {
            if (now - time > 60000) offlineNoticeTimes.delete(item);
        }
    }

    const container = ensureSniffContainer();
    const element = document.createElement('div');
    element.className = `fml-offline-notification is-${type} is-entering`;
    element.dataset.offlineNotice = key;
    element.innerHTML = `
        <i class="fa-solid ${TYPE_ICONS[type]} fml-offline-type"></i>
        <span class="fml-sniff-copy"><strong title="${escapeHtml(source)}">${escapeHtml(sniffFilename(source, type))}</strong><small>离线模式：本地${TYPE_LABELS[type]}缺失，已阻止在线加载</small></span>
        <button class="fml-sniff-icon fml-offline-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>`;
    element.querySelector('.fml-offline-close').addEventListener('click', () => dismissSniffNotification(element, true));
    container.append(element);
    element.addEventListener('animationend', () => element.classList.remove('is-entering'), { once: true });
    const delay = Math.max(1, Number(getSettings().sniffNotificationSeconds) || 5) * 1000;
    element._fmlTimer = setTimeout(() => dismissSniffNotification(element), delay);

    const maximum = Math.max(1, Math.min(20, Number(getSettings().sniffMaxNotifications) || 3));
    let active = [...container.children].filter(item => item.dataset.dismissing !== 'true').length;
    while (active > maximum) {
        const oldest = [...container.children].find(item => item !== element && item.dataset.dismissing !== 'true');
        if (!oldest) break;
        dismissSniffNotification(oldest, true);
        active--;
    }
}

function sniffManualStep(record) {
    if (record.state === 'saved') return 0;
    if (record.state === 'awaiting-import') return 4;
    const step = Number(record.manualStep);
    if (Number.isInteger(step) && step >= 1 && step <= 4) return step;
    return record.directFailed ? 2 : 1;
}

function sniffStepInfo(record) {
    const step = sniffManualStep(record);
    if (record.state === 'awaiting-import') return { step: 4, label: '导入', icon: 'fa-file-import', title: '第 4 步：选择刚才下载的文件并导入' };
    if (step === 2) return { step, label: '第2步', icon: 'fa-cloud-arrow-up', title: '第 2 步：浏览器读取资源并上传酒馆' };
    if (step === 3) return { step, label: '第3步', icon: 'fa-folder-open', title: '第 3 步：写入备用授权目录' };
    if (step === 4) return { step, label: '第4步', icon: 'fa-download', title: '第 4 步：下载文件，随后手动导入' };
    return { step: 1, label: '下载', icon: 'fa-download', title: '第 1 步：服务端直接下载' };
}

function sniffStatusLabel(record) {
    if (record.state === 'saving') {
        if (record.recoveryStage === 'direct') return '第 1 次：服务端直接下载…';
        if (record.recoveryStage === 'browser-read') return '第 2 次：读取浏览器资源…';
        if (record.recoveryStage === 'server-upload') return '第 2 次：上传到酒馆服务端…';
        if (record.recoveryStage === 'directory-handle') return '第 3 次：写入备用授权目录…';
        if (record.recoveryStage === 'manual-import') return '第 4 次：导入浏览器下载文件…';
        return '正在保存…';
    }
    if (record.state === 'saved') return '已保存到本地';
    if (record.state === 'awaiting-import') return record.error ? `导入失败：${record.error}；点击重试` : '浏览器下载完成后点击导入';
    const action = sniffStepInfo(record);
    if (record.state === 'failed') return `${record.error || '保存失败'}；点击${action.label}`;
    return record.local ? '本地资源' : `待执行${action.title.replace(/^第 \d 步：/, '')}`;
}

function notificationActionIcon(record) {
    return sniffStepInfo(record).icon;
}

function scheduleSniffNotification(element, record) {
    clearTimeout(element._fmlTimer);
    if (record.state === 'saving') return;
    const delay = Math.max(1, Number(getSettings().sniffNotificationSeconds) || 5) * 1000;
    element._fmlTimer = setTimeout(() => dismissSniffNotification(element), delay);
}

function dismissSniffNotification(element, fast = false) {
    if (!element || element.dataset.dismissing === 'true') return;
    clearTimeout(element._fmlTimer);
    element.dataset.dismissing = 'true';
    element.classList.add('is-leaving', fast ? 'is-leaving-fast' : 'is-leaving-timed');
    setTimeout(() => element.remove(), fast ? 170 : 340);
}

function renderSniffNotification(element, record) {
    const filename = sniffFilename(record.source, record.type);
    const action = sniffStepInfo(record);
    element.className = `fml-sniff-notification is-${record.type} is-${record.state}`;
    element.dataset.recordId = record.id;
    element.innerHTML = `
        <i class="fa-solid ${TYPE_ICONS[record.type]} fml-sniff-type"></i>
        <span class="fml-sniff-copy"><strong title="${escapeHtml(record.source)}">${escapeHtml(filename)}</strong><small>${escapeHtml(sniffStatusLabel(record))}</small></span>
        <button class="fml-sniff-icon fml-sniff-download" title="${escapeHtml(action.title)}"><i class="fa-solid ${notificationActionIcon(record)}"></i></button>
        <button class="fml-sniff-icon fml-sniff-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        <button class="fml-sniff-icon fml-sniff-more" title="更多"><i class="fa-solid fa-ellipsis"></i></button>
        <button class="fml-sniff-block" hidden>不再通知此资源</button>`;
    element.querySelectorAll('.fml-sniff-icon').forEach(button => button.disabled = record.state === 'saving');
    scheduleSniffNotification(element, record);
}

function showSniffNotification(record) {
    if (!getSettings().enabled || !getSettings().sniffingEnabled || !getSettings().sniffNotifications) return;
    if (record.cardName !== currentCard?.name || record.state === 'saved') return;
    record.lastNotifiedAt = Date.now();
    const container = ensureSniffContainer();
    let element = container.querySelector(`[data-record-id="${CSS.escape(record.id)}"]`);
    if (!element) {
        element = document.createElement('div');
        container.append(element);
        element.addEventListener('mouseenter', () => clearTimeout(element._fmlTimer));
        element.addEventListener('mouseleave', () => scheduleSniffNotification(element, record));
        element.addEventListener('focusin', () => clearTimeout(element._fmlTimer));
        element.addEventListener('focusout', event => {
            if (!element.contains(event.relatedTarget)) scheduleSniffNotification(element, record);
        });
    }
    renderSniffNotification(element, record);
    if (!element.dataset.animated) {
        element.dataset.animated = 'true';
        element.classList.add('is-entering');
        element.addEventListener('animationend', () => element.classList.remove('is-entering'), { once: true });
    }
    const maximum = Math.max(1, Math.min(20, Number(getSettings().sniffMaxNotifications) || 3));
    let active = [...container.children].filter(item => item.dataset.dismissing !== 'true').length;
    while (active > maximum) {
        const oldest = [...container.children].find(item => item.dataset.dismissing !== 'true');
        if (!oldest) break;
        dismissSniffNotification(oldest, true);
        active--;
    }
}

function updateSniffNotification(record) {
    const element = document.querySelector(`#fml-sniff-notification-container [data-record-id="${CSS.escape(record.id)}"]`);
    if (element) renderSniffNotification(element, record);
    else if (record.state !== 'saved') showSniffNotification(record);
}

async function handleSniffNotificationClick(event) {
    const element = event.target.closest('.fml-sniff-notification');
    if (!element) return;
    const record = sniffRecords.get(element.dataset.recordId);
    if (!record) return element.remove();
    if (event.target.closest('.fml-sniff-close')) return dismissSniffNotification(element, true);
    if (event.target.closest('.fml-sniff-more')) {
        const block = element.querySelector('.fml-sniff-block');
        block.hidden = !block.hidden;
        return;
    }
    if (event.target.closest('.fml-sniff-block')) {
        const settings = getSettings();
        if (!settings.sniffBlockedUrls.includes(record.source)) settings.sniffBlockedUrls.push(record.source);
        saveSettings();
        return dismissSniffNotification(element, true);
    }
    if (event.target.closest('.fml-sniff-download')) await handleManualSniffSave(record);
}

function enqueueSniffAutoDownload(record) {
    if (sniffAutoQueue.some(item => item.id === record.id)) return;
    sniffAutoQueue.push(record);
    void runSniffAutoQueue();
}

async function runSniffAutoQueue() {
    if (sniffAutoRunnerActive) return;
    sniffAutoRunnerActive = true;
    while (sniffAutoQueue.length) {
        if (getSettings().offlineMode) {
            sniffAutoQueue = [];
            break;
        }
        const record = sniffAutoQueue.shift();
        try { await saveSniffRecordDirect(record, false); } catch { /* state and notification handled by saver */ }
    }
    sniffAutoRunnerActive = false;
}

function safeDirectoryName(value, fallback) {
    const cleaned = String(value || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
    return cleaned || fallback;
}

async function chooseResourceDirectory() {
    if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持文件夹授权');
    const pickerOptions = { mode: 'readwrite', id: 'fml-resources' };
    if (resourceDirectoryHandle) pickerOptions.startIn = resourceDirectoryHandle;
    const handle = await window.showDirectoryPicker(pickerOptions);
    if (String(handle.name || '').toLowerCase() !== 'resources') throw new Error('请选择 SillyTavern/data/resources 文件夹');
    if (!await handlePermission(handle, true)) throw new Error('未取得目录读写权限');
    resourceDirectoryHandle = handle;
    await storeResourceHandle(handle);
    updateHandleStatus();
    return handle;
}

async function authorizeResourceDirectory() {
    if (!resourceDirectoryHandle) resourceDirectoryHandle = await readStoredHandle().catch(() => null);
    if (!resourceDirectoryHandle) return chooseResourceDirectory();
    if (String(resourceDirectoryHandle.name || '').toLowerCase() !== 'resources') {
        resourceDirectoryHandle = null;
        updateHandleStatus();
        toastr.warning('原有目录不是 resources，请重新确认正确目录', '资源嗅探');
        return chooseResourceDirectory();
    }
    const permission = await resourceDirectoryHandle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
        updateHandleStatus();
        return resourceDirectoryHandle;
    }
    const result = await resourceDirectoryHandle.requestPermission({ mode: 'readwrite' });
    if (result !== 'granted') throw new Error('未取得 resources 目录读写权限');
    await storeResourceHandle(resourceDirectoryHandle);
    updateHandleStatus();
    return resourceDirectoryHandle;
}

async function requireResourceDirectory(interactive = true) {
    if (!resourceDirectoryHandle) resourceDirectoryHandle = await readStoredHandle().catch(() => null);
    if (resourceDirectoryHandle && await handlePermission(resourceDirectoryHandle, interactive)) return resourceDirectoryHandle;
    if (!interactive) throw new Error('资源目录尚未授权');
    return chooseResourceDirectory();
}

function updateHandleStatus() {
    const element = document.querySelector('#fml-handle-status');
    if (!element) return;
    element.textContent = resourceDirectoryHandle ? `已选择：${resourceDirectoryHandle.name}` : '尚未选择资源目录（推荐选择 data/resources）';
}

async function availableResourceFilename(directory, requested) {
    const extensionIndex = requested.lastIndexOf('.');
    const base = extensionIndex > 0 ? requested.slice(0, extensionIndex) : requested;
    const extension = extensionIndex > 0 ? requested.slice(extensionIndex) : '';
    for (let index = 0; index < 1000; index++) {
        const candidate = index ? `${base}-${index}${extension}` : requested;
        try { await directory.getFileHandle(candidate); }
        catch (error) { if (error?.name === 'NotFoundError') return candidate; throw error; }
    }
    return `${base}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}

async function writeBlobToResourceDirectory(record, blob, preferredFilename = '', interactive = true) {
    const root = await requireResourceDirectory(interactive);
    const cardName = safeDirectoryName(record.storageCardName || record.cardName, 'Unnamed Character');
    const requestedFilename = safeDirectoryName(preferredFilename || sniffFilename(record.source, record.type, blob.type), `resource-${Date.now()}`);
    const cardDirectoryHandle = await root.getDirectoryHandle(cardName, { create: true });
    const typeDirectoryHandle = await cardDirectoryHandle.getDirectoryHandle(record.type, { create: true });
    const filename = await availableResourceFilename(typeDirectoryHandle, requestedFilename);
    const fileHandle = await typeDirectoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try { await writable.write(blob); } finally { await writable.close(); }
    const file = await fileHandle.getFile();
    return { filename, size: file.size, contentType: file.type || blob.type || 'application/octet-stream' };
}

async function registerSavedResource(record, saved) {
    const registration = {
        card: record.cardName,
        source: record.source,
        type: record.type,
        filename: saved.filename,
        contentType: saved.contentType,
    };
    if (!serverAvailable) {
        const settings = getSettings();
        if (!settings.pendingSniffRegistrations.some(item => item.card === registration.card && item.source === registration.source)) {
            settings.pendingSniffRegistrations.push(registration);
            saveSettings();
        }
        return null;
    }
    const data = await api('/register-local', { method: 'POST', body: JSON.stringify(registration) });
    await activateDownloadedResource(record.cardName, data.resource);
    refreshAllCardsInline();
    return data.resource;
}

async function syncPendingRegistrations() {
    if (!serverAvailable) return;
    const settings = getSettings();
    const pending = Array.isArray(settings.pendingSniffRegistrations) ? [...settings.pendingSniffRegistrations] : [];
    if (!pending.length) return;
    const remaining = [];
    for (const item of pending) {
        try { await api('/register-local', { method: 'POST', body: JSON.stringify(item) }); }
        catch { remaining.push(item); }
    }
    settings.pendingSniffRegistrations = remaining;
    saveSettings();
    if (currentCard) await loadLibrary(currentCard.name);
}

async function saveSniffRecordDirect(record, interactive = true) {
    record.state = 'saving';
    record.recoveryStage = 'direct';
    record.error = null;
    updateSniffNotification(record);
    try {
        if (!serverAvailable) throw new Error('酒馆服务器端插件未连接');
        const data = await api('/download', {
            method: 'POST',
            body: JSON.stringify({
                card: record.cardName,
                resources: [{ url: record.source, type: record.type }],
                ratePolicy: getRatePolicy(),
            }),
        });
        const result = data.results?.[0];
        if (!result?.ok || !result.resource) throw new Error(result?.error || '服务器端下载失败');
        const saved = result.resource;
        await activateDownloadedResource(record.cardName, saved);
        refreshAllCardsInline();
        record.state = 'saved';
        record.recoveryStage = null;
        record.directFailed = false;
        record.manualStep = null;
        record.recoveryBlob = null;
        record.saved = saved;
        updateSniffNotification(record);
        return saved;
    } catch (error) {
        record.state = 'failed';
        record.recoveryStage = null;
        record.directFailed = true;
        record.manualStep = 2;
        record.recoveryBlob = null;
        record.error = String(error.message || error);
        updateSniffNotification(record);
        throw error;
    }
}

async function readSniffBlobFromBrowser(record) {
    const source = String(record.actual || record.source || '');
    record.state = 'saving';
    record.recoveryStage = 'browser-read';
    record.error = null;
    updateSniffNotification(record);
    let response;
    try {
        await waitForSniffRequestSlot(source);
        response = await fetch(source, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            cache: 'force-cache',
            referrerPolicy: 'no-referrer',
        });
    } catch (error) {
        const wrapped = new Error('浏览器无法读取该资源，可能被资源网站的跨域策略阻止');
        wrapped.code = 'FML_BROWSER_RESOURCE_UNREADABLE';
        wrapped.cause = error;
        throw wrapped;
    }
    if (!response.ok) throw new Error(`浏览器读取资源失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('浏览器读取到的资源为空');
    const majorType = String(blob.type || '').split('/')[0];
    if (majorType && MEDIA_TYPES.includes(majorType) && majorType !== record.type) {
        throw new Error(`资源类型不匹配：需要${TYPE_LABELS[record.type]}，实际为${TYPE_LABELS[majorType]}`);
    }
    return blob;
}

async function uploadSniffBlobToServer(record, blob, preferredFilename = '', recoveryStage = 'server-upload') {
    record.state = 'saving';
    record.recoveryStage = recoveryStage;
    record.error = null;
    updateSniffNotification(record);
    try {
        if (!serverAvailable) {
            await checkServer();
            if (!serverAvailable) throw new Error('酒馆服务器端插件未连接');
        }
        const filename = preferredFilename || sniffFilename(record.source, record.type, blob.type);
        const formData = new FormData();
        formData.append('card', record.cardName);
        formData.append('source', record.source);
        formData.append('type', record.type);
        formData.append('filename', filename);
        formData.append('contentType', blob.type || 'application/octet-stream');
        formData.append('file', blob, filename);
        const data = await apiUpload('/import-blob', formData);
        if (!data?.resource) throw new Error('服务端未返回已导入资源');
        await activateDownloadedResource(record.cardName, data.resource);
        refreshAllCardsInline();
        record.state = 'saved';
        record.recoveryStage = null;
        record.directFailed = false;
        record.manualStep = null;
        record.recoveryBlob = null;
        record.saved = data.resource;
        updateSniffNotification(record);
        toastr.success('浏览器资源已上传到酒馆本地目录并更新映射', '资源嗅探');
        return data.resource;
    } catch (error) {
        record.state = 'failed';
        record.recoveryStage = null;
        record.directFailed = true;
        record.error = String(error.message || error);
        updateSniffNotification(record);
        throw error;
    }
}

async function saveSniffRecordToAuthorizedDirectory(record, blob, preferredFilename = '', interactive = false) {
    record.state = 'saving';
    record.recoveryStage = 'directory-handle';
    record.error = null;
    updateSniffNotification(record);
    try {
        const saved = await writeBlobToResourceDirectory(
            record,
            blob,
            preferredFilename || sniffFilename(record.source, record.type, blob.type),
            interactive,
        );
        const registered = await registerSavedResource(record, saved);
        record.state = 'saved';
        record.recoveryStage = null;
        record.directFailed = false;
        record.manualStep = null;
        record.recoveryBlob = null;
        record.saved = registered || saved;
        updateSniffNotification(record);
        toastr.success(`已通过备用句柄保存到 resources/${safeDirectoryName(record.storageCardName || record.cardName, 'Unnamed Character')}/${record.type}`, '资源嗅探');
        return record.saved;
    } catch (error) {
        record.state = 'failed';
        record.recoveryStage = null;
        record.directFailed = true;
        record.error = String(error.message || error);
        updateSniffNotification(record);
        throw error;
    }
}

function triggerBrowserSaveAs(record, blob = null) {
    const anchor = document.createElement('a');
    const objectUrl = blob ? URL.createObjectURL(blob) : null;
    anchor.href = objectUrl || record.source;
    anchor.download = sniffFilename(record.source, record.type);
    if (!objectUrl) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
    }
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function pickImportedFile(record) {
    let file;
    if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({ multiple: false });
        file = await handle.getFile();
    } else {
        file = await new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = `${record.type}/*`;
            input.onchange = () => input.files?.[0] ? resolve(input.files[0]) : reject(new Error('未选择文件'));
            input.click();
        });
    }
    if (!file?.size) throw new Error('选择的文件为空');
    const major = String(file.type || '').split('/')[0];
    if (major && major !== record.type) throw new Error(`请选择${TYPE_LABELS[record.type]}文件`);
    record.state = 'saving';
    record.recoveryStage = 'manual-import';
    record.error = null;
    updateSniffNotification(record);
    return uploadSniffBlobToServer(record, file, file.name, 'manual-import');
}

function setSniffManualFailure(record, failedStep, nextStep, error) {
    record.state = 'failed';
    record.recoveryStage = null;
    record.directFailed = true;
    record.manualStep = nextStep;
    record.error = `第 ${failedStep} 步失败：${error?.message || error || '未知错误'}`;
    updateSniffNotification(record);
}

async function handleManualSniffSave(record) {
    const step = sniffManualStep(record);
    if (step > 1 && record.state !== 'awaiting-import' && !getSettings().sniffSaveAs) {
        return toastr.info('请先在资源嗅探设置中开启“失败后启用补偿保存”', '资源嗅探');
    }
    if (record.state === 'saving' || record.state === 'saved') return;

    if (step === 1) {
        try {
            return await saveSniffRecordDirect(record, true);
        } catch (error) {
            toastr.warning('第 1 步失败，已停在第 2 步；请再次点击继续', '资源嗅探');
            return;
        }
    }

    if (step === 2) {
        let blob;
        try {
            blob = await readSniffBlobFromBrowser(record);
            record.recoveryBlob = blob;
        } catch (error) {
            record.recoveryBlob = null;
            setSniffManualFailure(record, 2, 4, error);
            toastr.warning('第 2 步无法读取资源，已停在第 4 步；请再次点击继续', '资源嗅探');
            return;
        }
        try {
            return await uploadSniffBlobToServer(record, blob);
        } catch (error) {
            record.recoveryBlob = blob;
            setSniffManualFailure(record, 2, 3, error);
            toastr.warning('第 2 步上传失败，已停在第 3 步；请再次点击继续', '资源嗅探');
            return;
        }
    }

    if (step === 3) {
        if (!record.recoveryBlob) {
            setSniffManualFailure(record, 3, 2, new Error('浏览器资源缓存已丢失，请重新执行第 2 步'));
            return toastr.warning('资源缓存已丢失，已退回第 2 步', '资源嗅探');
        }
        try {
            return await saveSniffRecordToAuthorizedDirectory(record, record.recoveryBlob, '', true);
        } catch (error) {
            if (error?.name === 'AbortError') {
                setSniffManualFailure(record, 3, 3, new Error('已取消目录授权'));
                return;
            }
            setSniffManualFailure(record, 3, 4, error);
            toastr.warning('第 3 步失败，已停在第 4 步；请再次点击继续', '资源嗅探');
            return;
        }
    }

    if (record.state === 'awaiting-import') {
        try {
            return await pickImportedFile(record);
        } catch (error) {
            if (error?.name === 'AbortError') return;
            record.state = 'awaiting-import';
            record.recoveryStage = null;
            record.manualStep = 4;
            record.error = String(error.message || error);
            updateSniffNotification(record);
            toastr.error('第 4 步导入失败；请再次点击选择文件重试', '资源嗅探');
            return;
        }
    }

    try {
        triggerBrowserSaveAs(record, record.recoveryBlob);
        record.state = 'awaiting-import';
        record.recoveryStage = null;
        record.manualStep = 4;
        record.error = null;
        updateSniffNotification(record);
    } catch (error) {
        setSniffManualFailure(record, 4, 4, error);
        toastr.error(error.message || String(error), '资源嗅探');
    }
}

function scanLoadedMedia(documentRef) {
    if (!documentRef) return;
    bindDocumentMediaFallback(documentRef);
    documentRef.querySelectorAll('img[src], audio[src], video[src], source[src]').forEach(element => {
        const info = mediaInfoFromElement(element);
        if (!info) return;
        const loaded = info.type === 'image' ? Boolean(element.complete && element.naturalWidth) : Number(element.readyState) >= 2;
        if (loaded) handleMediaLoaded({ target: element });
    });
}

function collectRuntimeResources(iframe) {
    if (!iframe?.contentWindow) return;
    const documentRef = iframe.contentDocument;
    ensureRuntimeSession(documentRef, true);
    touchRuntimeSession(documentRef, 'iframe 资源收集');
    let entries = [];
    try { entries = iframe.contentWindow.performance.getEntriesByType('resource'); } catch { return; }
    for (const entry of entries) processRuntimeResourceEntry(entry, documentRef);
    scanLoadedMedia(documentRef);
    updateFloatingButton();
}

function processRuntimeResourceEntry(entry, documentRef = null) {
    if (!getSettings().enabled) return;
    if (!['img', 'audio', 'video'].includes(entry?.initiatorType) && !inferType(entry?.name)) return;
    const url = normalizeCandidate(entry.name);
    if (!url) return;
    const type = inferType(url, entry.initiatorType);
    if (!type) return;
    if (!currentCandidates.has(url)) {
        currentCandidates.set(url, {
            url,
            type,
            hint: type,
            size: Number(entry.transferSize) || null,
            contentType: null,
            error: null,
            selected: Boolean(type),
            fields: new Set(['运行时加载']),
            aliases: new Set([url]),
            status: 'detected',
        });
    }
    const localUrl = routeMap.get(url);
    if (localUrl && shouldUseLocalRoutes()) {
        console.debug('[FrontendMediaLocalizer] 忽略已映射资源的旧云端性能记录', { 原始链接: url, 本地链接: localUrl });
        return;
    }
    const session = touchRuntimeSession(documentRef, '浏览器运行时资源记录');
    const info = {
        source: url,
        actual: url,
        type,
        local: false,
        cardName: currentCard?.name || null,
        sessionId: session?.id || null,
        reason: '浏览器运行时资源记录',
    };
    setLatestLoadedResource(info, '浏览器运行时资源记录');
    if (getSettings().enabled && getSettings().sniffingEnabled) registerSniffedResource(info);
}

function recordManualSceneResource(info, session, reason, flags = {}) {
    if (!info?.source || !session) return null;
    addRuntimeCandidate(info.source, info.type, reason);
    const record = registerSniffedResource({
        ...info,
        cardName: session.cardName,
        storageCardName: session.storageCardName,
        sessionId: session.id,
        reason,
    }, { notify: false, autoDownload: false });
    if (!record) return null;
    record.lastSeenAt = Date.now();
    record.sceneVisible = Boolean(flags.visible);
    record.scenePlaying = Boolean(flags.playing);
    session.recordIds.add(record.id);
    return record;
}

function collectCurrentSceneRecords(session) {
    const documentRef = session?.documentRef;
    if (!documentRef?.documentElement) return [];
    const active = new Map();
    const rememberElement = element => {
        const info = mediaInfoFromElement(element);
        if (!info) return;
        const target = String(element.tagName || '').toLowerCase() === 'source' ? element.parentElement : element;
        const tag = String(target?.tagName || '').toLowerCase();
        const visible = isElementInCurrentScene(target);
        const playing = ['audio', 'video'].includes(tag) && !target.paused && !target.ended;
        const loadedImage = tag === 'img' && target.complete && target.naturalWidth > 0;
        const loadedMedia = ['audio', 'video'].includes(tag) && Number(target.readyState) >= 1;
        if (!(playing || (visible && (loadedImage || loadedMedia)))) return;
        const record = recordManualSceneResource(info, session, '手动嗅探：当前媒体元素', { visible, playing });
        if (record) active.set(record.id, record);
    };

    documentRef.querySelectorAll('img[src], audio[src], video[src], source[src]').forEach(rememberElement);
    for (const media of trackedMediaElements) {
        if (![documentRef, document].includes(media?.ownerDocument) || media.paused || media.ended) continue;
        rememberElement(media);
    }

    const elements = [...documentRef.querySelectorAll('body *')].slice(0, 2000);
    for (const element of elements) {
        if (!isElementInCurrentScene(element)) continue;
        let background = '';
        try { background = documentRef.defaultView?.getComputedStyle(element)?.backgroundImage || ''; } catch { continue; }
        if (!background || background === 'none' || !background.includes('url(')) continue;
        URL_PATTERN.lastIndex = 0;
        for (const match of background.matchAll(URL_PATTERN)) {
            const actual = match[0].trim().replace(/[),;\]}]+$/g, '');
            const source = decodeSourceParameter(actual) || reverseRouteMap.get(actual) || normalizeCandidate(actual);
            if (!source) continue;
            const record = recordManualSceneResource({
                source,
                actual,
                type: 'image',
                local: Boolean(canonicalLocalRoute(actual)),
            }, session, '手动嗅探：当前可见背景图', { visible: true, playing: false });
            if (record) active.set(record.id, record);
        }
    }
    return [...active.values()];
}

function currentCardSniffRecords() {
    if (!currentCard) return [];
    const known = new Map(currentLibrary.filter(item => item.exists).map(item => [item.source, item]));
    return [...sniffRecords.values()]
        .filter(record => record.cardName === currentCard.name)
        .map(record => {
            const local = known.get(record.source);
            if (local && record.state !== 'saving') {
                record.state = 'saved';
                record.local = true;
                record.localMissing = false;
                record.saved = local;
                record.error = null;
            } else if (!local && (record.local || record.state === 'saved') && serverAvailable) {
                record.local = false;
                record.localMissing = true;
                record.state = 'ready';
                record.saved = null;
            }
            return record;
        })
        .sort((left, right) => (right.lastSeenAt || right.createdAt) - (left.lastSeenAt || left.createdAt));
}

function manualResniffCurrentScene() {
    const settings = getSettings();
    if (!settings.enabled || !currentCard) return toastr.info('当前没有可嗅探的角色卡', '资源嗅探');
    if (!settings.sniffingEnabled) return toastr.info('请先在扩展设置中开启“启用资源嗅探”', '资源嗅探');
    if (!settings.sniffNotifications) return toastr.info('请先开启“接收嗅探通知”，或使用右下角列表查看记录', '资源嗅探');
    const session = activeRuntimeSession();
    if (!session) return toastr.info('没有找到当前可见的前端卡运行窗口', '资源嗅探');
    touchRuntimeSession(session.documentRef, '手动重新嗅探');
    const active = collectCurrentSceneRecords(session);
    const activeIds = new Set(active.map(record => record.id));
    const recentWindow = Math.max(30000, (Number(settings.sniffNotificationSeconds) || 5) * 4000);
    const now = Date.now();
    const candidates = [...session.recordIds]
        .map(id => sniffRecords.get(id))
        .filter(record => record && record.cardName === currentCard.name && record.state !== 'saved')
        .filter(record => activeIds.has(record.id) || now - (record.lastSeenAt || record.createdAt) <= recentWindow)
        .sort((left, right) => Number(activeIds.has(right.id)) - Number(activeIds.has(left.id))
            || Number(Boolean(right.scenePlaying)) - Number(Boolean(left.scenePlaying))
            || (right.lastSeenAt || right.createdAt) - (left.lastSeenAt || left.createdAt));
    const maximum = Math.max(1, Math.min(20, Number(settings.sniffMaxNotifications) || 3));
    const selected = candidates.slice(0, maximum);
    selected.forEach(record => showSniffNotification(record));
    if (!selected.length) return toastr.info('当前场景没有未下载或失败的资源；可点击右下角列表查看全部记录', '资源嗅探');
    toastr.info(`已重新显示 ${selected.length} 条当前场景资源`, `${currentCard.name} · 资源嗅探`);
}

async function synchronizeActiveCard(identity, characterId) {
    const sequence = ++cardChangeSequence;
    const card = await getActiveCard(characterId);
    if (sequence !== cardChangeSequence || activeCardIdentity(characterId) !== identity || this_chid !== characterId) return null;
    currentCard = card;
    currentStorageCardName = card?.name || null;
    currentCandidates = card ? collectRemoteResources(card.character) : new Map();
    currentLibrary = [];
    latestLoadedResource = null;
    clearSniffNotifications();
    setRouteMap([]);
    if (card && serverAvailable) await loadLibrary(card.name).catch(error => toastr.error(error.message, '资源本地化'));
    if (sequence !== cardChangeSequence || activeCardIdentity(characterId) !== identity || this_chid !== characterId) return null;
    currentCardRoutingReady = true;
    applyConfiguredResourcePolicy();
    updateFloatingButton();
    updateSettingsSummary();
    return card;
}

async function handleCardChange({ force = false } = {}) {
    const identity = activeCardIdentity();
    const characterId = this_chid;
    if (!force && currentCardRoutingReady && currentCard?.identity === identity) return currentCard;
    if (cardSyncPromise && cardSyncIdentity === identity) return cardSyncPromise;
    currentCardRoutingReady = false;
    cardSyncIdentity = identity;
    const operation = synchronizeActiveCard(identity, characterId);
    cardSyncPromise = operation.finally(() => {
        if (cardSyncPromise === operation || cardSyncIdentity === identity) {
            cardSyncPromise = null;
            cardSyncIdentity = null;
        }
    });
    return cardSyncPromise;
}

function unresolvedCandidates() {
    const known = new Set(currentLibrary.filter(item => item.exists).map(item => item.source));
    return [...currentCandidates.values()].filter(item => !known.has(item.url));
}

function updateFloatingButton() {
    const button = document.querySelector('#fml-floating-button');
    if (!button) return;
    const settings = getSettings();
    const hasQueue = downloadQueue.length > 0;
    const displayedTask = hasQueue ? downloadQueue[Math.min(queueDisplayIndex, downloadQueue.length - 1)] : null;
    const detected = [...currentCandidates.values()].filter(item => MEDIA_TYPES.includes(item.type) || !item.type).length;
    const pending = unresolvedCandidates().filter(item => MEDIA_TYPES.includes(item.type) || !item.type).length;
    button.hidden = !(settings.enabled && settings.showFloatingButton && (hasQueue || currentCard));
    button.classList.toggle('is-downloading', hasQueue);
    button.classList.toggle('has-pending', !hasQueue && pending > 0);
    const icon = button.querySelector('.fml-floating-icon');
    const progress = button.querySelector('.fml-floating-progress');
    const progressPercent = button.querySelector('.fml-progress-percent');
    const progressCount = button.querySelector('.fml-progress-count');
    const latestLocal = Boolean(latestLoadedResource?.local && serverAvailable && settings.useLocalResources);
    if (icon) {
        icon.className = `fa-solid ${latestLocal ? 'fa-box-archive' : 'fa-cloud'} fml-floating-icon`;
        icon.title = latestLocal ? '最新资源：本地' : '最新资源：云端';
    }
    button.classList.toggle('is-local-source', latestLocal);
    button.classList.toggle('is-cloud-source', !latestLocal);
    if (displayedTask) {
        const processed = displayedTask.completed + displayedTask.failed;
        const percent = displayedTask.total ? Math.round(processed / displayedTask.total * 100) : 0;
        const queuePosition = downloadQueue.indexOf(displayedTask) + 1;
        const stateText = displayedTask.status === 'running' ? '正在下载' : '等待中';
        button.style.setProperty('--fml-queue-color', displayedTask.color);
        button.style.setProperty('--fml-progress', `${percent * 3.6}deg`);
        button.title = `${displayedTask.cardName}：${stateText} ${processed}/${displayedTask.total}，失败 ${displayedTask.failed}（队列 ${queuePosition}/${downloadQueue.length}）`;
        if (progressPercent) progressPercent.textContent = `${percent}%`;
        if (progressCount) progressCount.textContent = `${processed}/${displayedTask.total}`;
    } else {
        button.style.removeProperty('--fml-progress');
        button.style.removeProperty('--fml-queue-color');
        button.title = pending > 0 ? `发现 ${pending} 个尚未本地化的在线资源` : `已管理 ${currentLibrary.length} 个资源`;
    }
    if (icon) icon.hidden = false;
    if (progress) progress.hidden = !hasQueue;
    const badge = button.querySelector('.fml-floating-badge');
    if (badge) {
        badge.classList.toggle('is-queue', hasQueue);
        if (displayedTask) {
            badge.textContent = `${downloadQueue.indexOf(displayedTask) + 1}/${downloadQueue.length}`;
            badge.hidden = false;
        } else {
            badge.textContent = pending > 999 ? '999+' : String(pending);
            badge.hidden = pending === 0;
        }
    }
}

function activateFloatingButton() {
    if (downloadQueue.length) {
        const currentCardQueued = currentCard && downloadQueue.some(task => task.cardName === currentCard.name);
        if (currentCard && !currentCardQueued && unresolvedCandidates().length) return openScanModal();
        queueDisplayIndex = (queueDisplayIndex + 1) % downloadQueue.length;
        const task = downloadQueue[queueDisplayIndex];
        const processed = task.completed + task.failed;
        const stateText = task.status === 'running' ? '下载中' : '等待中';
        updateFloatingButton();
        toastr.info(`${task.cardName}：${stateText} ${processed}/${task.total}，失败 ${task.failed}（${queueDisplayIndex + 1}/${downloadQueue.length}）`, '下载队列');
        return;
    }
    const pending = unresolvedCandidates();
    if (pending.length) openScanModal();
    else openLibraryModal();
}

function floatingPositionMode() {
    return isMobileLayout() ? 'mobile' : 'desktop';
}

function clampFloatingButton(button) {
    if (!button || button.hidden) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const margin = 8;
    const left = Math.min(viewportLeft + viewportWidth - rect.width - margin, Math.max(viewportLeft + margin, rect.left));
    const top = Math.min(viewportTop + viewportHeight - rect.height - margin, Math.max(viewportTop + margin, rect.top));
    button.style.left = `${Math.round(left)}px`;
    button.style.top = `${Math.round(top)}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
}

function applyFloatingPosition(button = document.querySelector('#fml-floating-button')) {
    if (!button) return;
    const mode = floatingPositionMode();
    floatingViewportMode = mode;
    const position = getSettings().floatingPositions?.[mode];
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        button.style.left = `${position.x}px`;
        button.style.top = `${position.y}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
        requestAnimationFrame(() => clampFloatingButton(button));
    } else {
        const viewport = window.visualViewport;
        const viewportLeft = viewport?.offsetLeft || 0;
        const viewportTop = viewport?.offsetTop || 0;
        const viewportWidth = viewport?.width || window.innerWidth;
        const viewportHeight = viewport?.height || window.innerHeight;
        const size = button.offsetWidth || 52;
        const rightGap = isMobileLayout() ? 12 : 18;
        const bottomGap = isMobileLayout() ? 84 : 88;
        button.style.left = `${Math.max(8, Math.round(viewportLeft + viewportWidth - size - rightGap))}px`;
        button.style.top = `${Math.max(8, Math.round(viewportTop + viewportHeight - size - bottomGap))}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
    }
}

function saveFloatingPosition(button) {
    const rect = button.getBoundingClientRect();
    const settings = getSettings();
    settings.floatingPositions ||= { desktop: null, mobile: null };
    settings.floatingPositions[floatingPositionMode()] = { x: Math.round(rect.left), y: Math.round(rect.top) };
    saveSettings();
}

function hideFloatingButtonFromControl() {
    const settings = getSettings();
    settings.showFloatingButton = false;
    const setting = document.querySelector('#fml-show-floating');
    if (setting) setting.checked = false;
    saveSettings();
    updateFloatingButton();
}

function bindFloatingDrag(button) {
    let drag = null;
    let ignoreMouseUntil = 0;
    const pointFromEvent = event => event.touches?.[0] || event.changedTouches?.[0] || event;
    const start = event => {
        if (event.target.closest('.fml-floating-control') || (event.pointerType === 'mouse' && event.button !== 0)) return;
        if (drag) return;
        const point = pointFromEvent(event);
        const rect = button.getBoundingClientRect();
        drag = { id: event.pointerId, x: point.clientX, y: point.clientY, left: rect.left, top: rect.top, moved: false };
        if (event.pointerId !== undefined) button.setPointerCapture?.(event.pointerId);
        button.classList.add('is-dragging');
        button.focus({ preventScroll: true });
        event.preventDefault();
    };
    const move = event => {
        if (!drag || (drag.id !== undefined && event.pointerId !== undefined && drag.id !== event.pointerId)) return;
        const point = pointFromEvent(event);
        const dx = point.clientX - drag.x;
        const dy = point.clientY - drag.y;
        if (Math.hypot(dx, dy) > 5) drag.moved = true;
        button.style.left = `${drag.left + dx}px`;
        button.style.top = `${drag.top + dy}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
        clampFloatingButton(button);
        event.preventDefault();
    };
    const finish = event => {
        if (!drag || (drag.id !== undefined && event.pointerId !== undefined && drag.id !== event.pointerId)) return;
        const moved = drag.moved;
        const pointerId = drag.id;
        drag = null;
        button.classList.remove('is-dragging');
        if (pointerId !== undefined) button.releasePointerCapture?.(pointerId);
        if (moved) saveFloatingPosition(button);
        else activateFloatingButton();
        event.preventDefault();
    };
    button.addEventListener('pointerdown', start);
    button.addEventListener('pointermove', move);
    button.addEventListener('pointerup', finish);
    button.addEventListener('pointercancel', event => {
        if (!drag || drag.id !== event.pointerId) return;
        drag = null;
        button.classList.remove('is-dragging');
        clampFloatingButton(button);
    });
    button.addEventListener('touchstart', event => {
        ignoreMouseUntil = Date.now() + 700;
        if (drag) return;
        start(event);
    }, { passive: false });
    button.addEventListener('touchmove', move, { passive: false });
    button.addEventListener('touchend', finish, { passive: false });
    button.addEventListener('touchcancel', event => {
        if (!drag) return;
        drag = null;
        button.classList.remove('is-dragging');
        clampFloatingButton(button);
        event.preventDefault();
    }, { passive: false });
    button.addEventListener('mousedown', event => {
        if (Date.now() >= ignoreMouseUntil) start(event);
    });
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
}

function updateSettingsSummary() {
    const element = document.querySelector('#fml-current-summary');
    if (!element) return;
    if (!currentCard) {
        element.textContent = '当前未选择角色卡';
        return;
    }
    const local = currentLibrary.filter(item => item.exists).length;
    const localSize = currentLibrary.filter(item => item.exists).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    element.textContent = `${currentCard.name}：检测 ${currentCandidates.size} 个链接，本地 ${local} 个（${formatBytes(localSize)}）`;
}

function injectFloatingButton() {
    if (document.querySelector('#fml-floating-button')) return;
    const button = document.createElement('div');
    button.id = 'fml-floating-button';
    button.className = 'fml-floating-button';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', '前端卡资源本地化');
    button.hidden = true;
    button.innerHTML = `
        <i class="fa-solid fa-cloud fml-floating-icon"></i>
        <span class="fml-floating-progress" hidden>
            <strong class="fml-progress-percent">0%</strong>
            <small class="fml-progress-count">0/0</small>
        </span>
        <span class="fml-floating-badge" hidden>0</span>
        <button class="fml-floating-control fml-floating-close" type="button" title="关闭悬浮球" aria-label="关闭悬浮球"><i class="fa-solid fa-xmark"></i></button>
        <button class="fml-floating-control fml-floating-resniff" type="button" title="重新嗅探当前场景" aria-label="重新嗅探当前场景"><i class="fa-solid fa-rotate"></i></button>
        <button class="fml-floating-control fml-floating-records" type="button" title="查看本次嗅探记录" aria-label="查看本次嗅探记录"><i class="fa-solid fa-list-ul"></i></button>`;
    const bindControl = (selector, action) => {
        const control = button.querySelector(selector);
        for (const eventName of ['pointerdown', 'mousedown', 'touchstart']) {
            control.addEventListener(eventName, event => event.stopPropagation(), { passive: eventName === 'touchstart' });
        }
        control.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            action();
        });
    };
    bindControl('.fml-floating-close', hideFloatingButtonFromControl);
    bindControl('.fml-floating-resniff', manualResniffCurrentScene);
    bindControl('.fml-floating-records', openSniffRecordsModal);
    button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateFloatingButton();
    });
    bindFloatingDrag(button);
    document.body.append(button);
    applyFloatingPosition(button);
}

function injectSettingsPanel() {
    if (document.querySelector('#fml-settings')) return;
    const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings_container');
    if (!container) return;
    const settings = getSettings();
    const panel = document.createElement('div');
    panel.id = 'fml-settings';
    panel.className = 'extension_settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-box-archive"></i> 前端卡资源本地化</b>
                <i class="inline-drawer-icon fa-solid fa-circle-chevron-down"></i>
            </div>
            <div class="inline-drawer-content" style="display:none;">
                <div class="fml-settings-module">
                    <div class="fml-module-title">运行状态</div>
                    <div id="fml-server-status" class="fml-status">正在检查服务端……</div>
                    <div id="fml-backend-install-row" class="fml-backend-install-row" hidden>
                        <button id="fml-install-backend-settings" class="menu_button"><i class="fa-solid fa-download"></i> 安装后端</button>
                        <small>选择 SillyTavern/plugins 文件夹后写入后端，完成后重启酒馆。</small>
                    </div>
                </div>
                <div class="fml-settings-module">
                    <div class="fml-module-title">检测与悬浮球</div>
                    <label class="fml-check-row"><span>启用开关</span><input id="fml-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}></label>
                    <label class="fml-check-row"><span>使用本地资源</span><input id="fml-use-local" type="checkbox" ${settings.useLocalResources ? 'checked' : ''} ${settings.offlineMode ? 'disabled' : ''}></label>
                    <label class="fml-check-row"><span>在线模式（不使用本地资源）</span><input id="fml-online-mode" type="checkbox" ${settings.onlineMode ? 'checked' : ''}></label>
                    <label class="fml-check-row"><span>离线模式</span><input id="fml-offline-mode" type="checkbox" ${settings.offlineMode ? 'checked' : ''}></label>
                    <label class="fml-check-row"><span>显示悬浮球</span><input id="fml-show-floating" type="checkbox" ${settings.showFloatingButton ? 'checked' : ''}></label>
                    <small>在线模式始终使用原图床；本地模式优先使用已下载资源；离线模式禁止缺失资源回退图床。手动扫描下载不受模式限制。</small>
                </div>
                <div class="fml-settings-module">
                    <div class="fml-module-title">资源嗅探</div>
                    <label class="fml-check-row"><span>启用资源嗅探</span><input id="fml-sniff-enabled" type="checkbox" ${settings.sniffingEnabled ? 'checked' : ''}></label>
                    <label class="fml-check-row"><span>接收嗅探通知</span><input id="fml-sniff-notifications" type="checkbox" ${settings.sniffNotifications ? 'checked' : ''}></label>
                    <label class="fml-check-row"><span>自动下载嗅探资源</span><input id="fml-sniff-auto" type="checkbox" ${settings.sniffAutoDownload ? 'checked' : ''} ${settings.offlineMode ? 'disabled' : ''}></label>
                    <label class="fml-check-row"><span>失败后启用补偿保存</span><input id="fml-sniff-save-as" type="checkbox" ${settings.sniffSaveAs ? 'checked' : ''}></label>
                    <label class="fml-number-row"><span>最多同时显示</span><span><input id="fml-sniff-max" class="text_pole" type="number" min="1" max="20" step="1" value="${escapeHtml(settings.sniffMaxNotifications)}"> 条</span></label>
                    <label class="fml-number-row"><span>通知显示时间</span><span><input id="fml-sniff-seconds" class="text_pole" type="number" min="1" max="300" step="1" value="${escapeHtml(settings.sniffNotificationSeconds)}"> 秒</span></label>
                    <div id="fml-handle-status" class="fml-current-summary">尚未选择资源目录（推荐选择 data/resources）</div>
                    <div class="fml-settings-actions">
                        <button id="fml-choose-resource-folder" class="menu_button"><i class="fa-solid fa-folder-open"></i> 授权备用目录（可选）</button>
                        <button id="fml-clear-sniff-blocks" class="menu_button"><i class="fa-solid fa-bell"></i> 清除不再通知列表</button>
                    </div>
                    <small>备用目录授权用于第 3 步，让浏览器把已读取的资源直接写入酒馆。首次使用可点击“授权备用目录”，在浏览器窗口选择 <code>SillyTavern/data/resources</code> 并允许读写，通常只需一次；也可等第 3 步按钮出现后再授权。每一步都需要手动点击，不会自动进入下一步。</small>
                </div>
                <div class="fml-settings-module">
                    <div class="fml-module-title">网站请求速率</div>
                    <label class="fml-rate-default"><span>默认最小请求间隔</span><span><input id="fml-default-rate" class="text_pole" type="number" min="0.1" max="3600" step="0.1" value="${escapeHtml(normalizeRateSeconds(settings.defaultRequestIntervalSeconds, 1))}"> 秒</span></label>
                    <div class="fml-rate-heading"><span>单独网站规则</span><button id="fml-add-rate-rule" class="menu_button" type="button"><i class="fa-solid fa-plus"></i> 添加网站</button></div>
                    <div id="fml-rate-rules" class="fml-rate-rules"></div>
                    <small>填写域名即可，例如 files.catbox.moe。规则同时作用于该域名及其子域名；估算与下载均受限制，并发固定为 1。</small>
                </div>
                <div class="fml-settings-module">
                    <div class="fml-module-title">当前角色卡</div>
                    <div id="fml-current-summary" class="fml-current-summary">当前未选择角色卡</div>
                    <div class="fml-settings-actions">
                        <button id="fml-scan-now" class="menu_button"><i class="fa-solid fa-magnifying-glass"></i> 扫描下载</button>
                        <button id="fml-manage-now" class="menu_button"><i class="fa-solid fa-list"></i> 管理资源</button>
                        <button id="fml-open-folder" class="menu_button"><i class="fa-solid fa-folder-open"></i> 打开文件夹</button>
                    </div>
                </div>
                <div class="fml-settings-module">
                    <div class="fml-module-title">所有角色卡资源</div>
                    <div id="fml-all-cards-summary" class="fml-current-summary">正在静默检索本地资源……</div>
                    <div id="fml-all-cards-inline-list" class="fml-inline-card-list"></div>
                    <div class="fml-settings-actions">
                        <button id="fml-manage-all-cards" class="menu_button"><i class="fa-solid fa-boxes-stacked"></i> 管理所有卡资源</button>
                    </div>
                </div>
            </div>
        </div>`;
    container.append(panel);

    const rateRules = panel.querySelector('#fml-rate-rules');
    renderRateRuleRows(rateRules, settings);

    const useLocalControl = panel.querySelector('#fml-use-local');
    const onlineModeControl = panel.querySelector('#fml-online-mode');
    const offlineModeControl = panel.querySelector('#fml-offline-mode');
    const sniffAutoControl = panel.querySelector('#fml-sniff-auto');
    const syncModeControls = () => {
        useLocalControl.checked = Boolean(settings.useLocalResources);
        useLocalControl.disabled = Boolean(settings.offlineMode);
        onlineModeControl.checked = Boolean(settings.onlineMode);
        offlineModeControl.checked = Boolean(settings.offlineMode);
        sniffAutoControl.checked = Boolean(settings.sniffAutoDownload);
        sniffAutoControl.disabled = Boolean(settings.offlineMode);
    };
    const applyModeSelection = async () => {
        if (settings.enabled && !settings.onlineMode && serverAvailable && currentCard) {
            await loadLibrary(currentCard.name).catch(error => toastr.error(error.message, '资源本地化'));
            return;
        }
        applyConfiguredResourcePolicy();
    };
    syncModeControls();

    panel.querySelector('#fml-enabled').addEventListener('change', async event => {
        settings.enabled = event.target.checked;
        saveSettings();
        if (!settings.enabled) {
            clearSniffNotifications();
            sniffAutoQueue = [];
        }
        await applyModeSelection();
        updateFloatingButton();
    });
    useLocalControl.addEventListener('change', async event => {
        settings.useLocalResources = event.target.checked;
        settings.onlineMode = !settings.useLocalResources;
        if (settings.onlineMode) settings.offlineMode = false;
        syncModeControls();
        saveSettings();
        await applyModeSelection();
        updateFloatingButton();
        updateSettingsSummary();
    });
    onlineModeControl.addEventListener('change', async event => {
        settings.onlineMode = event.target.checked;
        settings.offlineMode = false;
        settings.useLocalResources = !settings.onlineMode;
        syncModeControls();
        saveSettings();
        await applyModeSelection();
        updateFloatingButton();
        updateSettingsSummary();
        toastr.info(settings.onlineMode ? '已进入在线模式；当前卡将使用原图床资源' : '已退出在线模式；优先使用已下载的本地资源', '资源本地化');
    });
    offlineModeControl.addEventListener('change', async event => {
        settings.offlineMode = event.target.checked;
        if (settings.offlineMode) {
            settings.onlineMode = false;
            settings.useLocalResources = true;
            settings.sniffAutoDownload = false;
            sniffAutoQueue = [];
        } else {
            settings.onlineMode = false;
            settings.useLocalResources = true;
        }
        syncModeControls();
        saveSettings();
        await applyModeSelection();
        toastr.info(settings.offlineMode ? '已进入离线模式；缺失媒体不会再访问在线图床' : '已退出离线模式；恢复本地优先并允许在线回退', '资源本地化');
        updateFloatingButton();
        updateSettingsSummary();
    });
    panel.querySelector('#fml-show-floating').addEventListener('change', event => {
        settings.showFloatingButton = event.target.checked;
        saveSettings();
        updateFloatingButton();
        if (settings.showFloatingButton) applyFloatingPosition();
    });
    panel.querySelector('#fml-sniff-enabled').addEventListener('change', event => {
        settings.sniffingEnabled = event.target.checked;
        saveSettings();
        if (!settings.sniffingEnabled) clearSniffNotifications();
        else if (settings.enabled) document.querySelectorAll('iframe').forEach(iframe => scanLoadedMedia(iframe.contentDocument));
    });
    panel.querySelector('#fml-sniff-notifications').addEventListener('change', event => {
        settings.sniffNotifications = event.target.checked;
        saveSettings();
        if (!settings.sniffNotifications) clearSniffNotifications();
        else if (settings.enabled && settings.sniffingEnabled) {
            for (const record of sniffRecords.values()) {
                if (record.cardName === currentCard?.name && record.state !== 'saved') showSniffNotification(record);
            }
        }
    });
    panel.querySelector('#fml-sniff-auto').addEventListener('change', event => {
        if (settings.offlineMode) {
            event.target.checked = false;
            return;
        }
        settings.sniffAutoDownload = event.target.checked;
        saveSettings();
    });
    panel.querySelector('#fml-sniff-save-as').addEventListener('change', event => {
        settings.sniffSaveAs = event.target.checked;
        saveSettings();
    });
    panel.querySelector('#fml-sniff-max').addEventListener('change', event => {
        settings.sniffMaxNotifications = Math.max(1, Math.min(20, Number(event.target.value) || 3));
        event.target.value = settings.sniffMaxNotifications;
        saveSettings();
    });
    panel.querySelector('#fml-sniff-seconds').addEventListener('change', event => {
        settings.sniffNotificationSeconds = Math.max(1, Math.min(300, Number(event.target.value) || 5));
        event.target.value = settings.sniffNotificationSeconds;
        saveSettings();
    });
    panel.querySelector('#fml-choose-resource-folder').addEventListener('click', async () => {
        try { await authorizeResourceDirectory(); toastr.success('resources 目录授权成功', '资源嗅探'); }
        catch (error) { if (error?.name !== 'AbortError') toastr.error(error.message || String(error), '资源嗅探'); }
    });
    panel.querySelector('#fml-clear-sniff-blocks').addEventListener('click', () => {
        settings.sniffBlockedUrls = [];
        saveSettings();
        toastr.success('已清除不再通知列表', '资源嗅探');
    });
    panel.querySelector('#fml-default-rate').addEventListener('change', event => {
        settings.defaultRequestIntervalSeconds = normalizeRateSeconds(event.target.value, 1);
        event.target.value = settings.defaultRequestIntervalSeconds;
        saveSettings();
    });
    panel.querySelector('#fml-add-rate-rule').addEventListener('click', () => {
        saveRateRulesFromPanel(panel, settings);
        settings.siteRateRules.push({ domain: '', intervalSeconds: settings.defaultRequestIntervalSeconds });
        renderRateRuleRows(rateRules, settings);
        rateRules.querySelector('.fml-rate-rule:last-child .fml-rate-domain')?.focus();
    });
    rateRules.addEventListener('change', event => {
        if (!event.target.matches('.fml-rate-domain, .fml-rate-seconds')) return;
        if (event.target.matches('.fml-rate-domain')) {
            event.target.classList.toggle('fml-input-invalid', Boolean(event.target.value.trim()) && !normalizeRateDomain(event.target.value));
        } else {
            event.target.value = normalizeRateSeconds(event.target.value, 1);
        }
        saveRateRulesFromPanel(panel, settings);
    });
    rateRules.addEventListener('click', event => {
        const button = event.target.closest('.fml-rate-remove');
        if (!button) return;
        button.closest('.fml-rate-rule')?.remove();
        saveRateRulesFromPanel(panel, settings);
        renderRateRuleRows(rateRules, settings);
    });
    panel.querySelector('#fml-scan-now').addEventListener('click', openScanModal);
    panel.querySelector('#fml-manage-now').addEventListener('click', () => openLibraryModal());
    panel.querySelector('#fml-open-folder').addEventListener('click', openCurrentFolder);
    panel.querySelector('#fml-manage-all-cards').addEventListener('click', openAllCardsModal);
    panel.querySelector('#fml-all-cards-inline-list').addEventListener('click', handleInlineCardAction);
    panel.querySelector('#fml-install-backend-settings').addEventListener('click', () => openBackendInstaller());
    updateSettingsSummary();
    updateHandleStatus();
    checkServer();
    refreshAllCardsInline();
    if (!allCardsPollTimer) allCardsPollTimer = setInterval(refreshAllCardsInline, 3000);
}

function createModal(title, bodyHtml, className = '') {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'fml-modal-overlay';
    overlay.innerHTML = `
        <section class="fml-modal ${className}" role="dialog" aria-modal="true">
            <header class="fml-modal-header"><h3>${escapeHtml(title)}</h3><button class="fml-icon-button fml-close" title="关闭"><i class="fa-solid fa-xmark"></i></button></header>
            <div class="fml-modal-body">${bodyHtml}</div>
        </section>`;
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) closeModal(); });
    overlay.querySelector('.fml-close').addEventListener('click', closeModal);
    document.body.append(overlay);
    activeModal = overlay;
    return overlay;
}

function closeModal() {
    activeModal?.remove();
    activeModal = null;
}

function candidateRecoveryRecord(item, cardName, create = false) {
    let record = item.sniffRecordId ? sniffRecords.get(item.sniffRecordId) : null;
    if (!record && cardName) record = sniffRecords.get(sniffRecordIndex.get(sniffRecordKey(cardName, item.url)));
    if (!record && create && cardName && MEDIA_TYPES.includes(item.type)) {
        record = registerSniffedResource({
            cardName,
            source: item.url,
            actual: item.url,
            type: item.type,
            local: false,
            reason: '资源列表手动下载',
        }, { notify: false, autoDownload: false });
    }
    if (record) {
        item.sniffRecordId = record.id;
        if (item.directFailed && record.state === 'ready' && sniffManualStep(record) === 1) {
            record.state = 'failed';
            record.directFailed = true;
            record.manualStep = Math.max(2, Number(record.manualStep) || 2);
            record.error = item.error || record.error || '第 1 步下载失败';
        }
    }
    return record || null;
}

function syncCandidateRecoveryState(item, cardName) {
    const record = candidateRecoveryRecord(item, cardName);
    if (!record) return;
    if (record.state === 'saved') {
        item.downloaded = true;
        item.selected = false;
        item.directFailed = false;
        item.status = 'downloaded';
        item.statusLabel = '已下载到本地';
        item.error = null;
        return;
    }
    if (record.state === 'saving') {
        item.status = 'downloading';
        item.statusLabel = sniffStatusLabel(record);
        item.error = null;
        return;
    }
    if (record.state === 'failed' || record.state === 'awaiting-import') {
        item.status = record.state === 'failed' ? 'error' : 'ready';
        item.statusLabel = sniffStatusLabel(record);
        item.error = record.state === 'failed' ? record.error : null;
    }
}

function candidateActionInfo(item, cardName) {
    if (item.downloaded) return { label: '本地', icon: 'fa-hard-drive', title: '已保存到本地', disabled: true };
    if (!MEDIA_TYPES.includes(item.type)) return { label: '不可用', icon: 'fa-ban', title: '不是支持的媒体资源', disabled: true };
    const record = candidateRecoveryRecord(item, cardName);
    if (item.manualBusy || record?.state === 'saving' || item.status === 'downloading') {
        return { label: '处理中', icon: 'fa-spinner fa-spin', title: '当前步骤正在执行', disabled: true };
    }
    return { ...sniffStepInfo(record || { state: 'ready', manualStep: item.directFailed ? 2 : 1 }), disabled: false };
}

function renderCandidateRow(item, cardName = '') {
    const type = MEDIA_TYPES.includes(item.type) ? item.type : 'unknown';
    const host = (() => { try { return new URL(item.url).hostname; } catch { return ''; } })();
    const status = item.statusLabel || (item.downloaded ? '已下载' : item.error ? item.error : item.status === 'probing' ? '正在估算……' : item.status === 'downloading' ? '正在下载……' : item.status === 'done' ? '已完成' : formatBytes(item.size));
    const action = candidateActionInfo(item, cardName);
    return `
        <div class="fml-resource-row ${item.downloaded ? 'is-downloaded' : ''}" data-url="${escapeHtml(item.url)}" data-type="${type}">
            <input class="fml-resource-check" type="checkbox" ${item.selected && MEDIA_TYPES.includes(item.type) && !item.downloaded ? 'checked' : ''} ${!MEDIA_TYPES.includes(item.type) || item.downloaded ? 'disabled' : ''}>
            <i class="fa-solid ${TYPE_ICONS[item.type] || 'fa-circle-question'} fml-type-icon"></i>
            <span class="fml-resource-main"><span class="fml-resource-host">${escapeHtml(host)}</span><span class="fml-resource-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span></span>
            <span class="fml-resource-status ${item.error ? 'is-error' : ''}">${escapeHtml(status)}</span>
            <button type="button" class="menu_button fml-resource-download" title="${escapeHtml(action.title)}" ${action.disabled ? 'disabled' : ''}><i class="fa-solid ${action.icon}"></i> ${escapeHtml(action.label)}</button>
        </div>`;
}

function scanModalBody(items, pendingCount) {
    return `
        <div class="fml-scan-summary"><strong>待处理 <span id="fml-pending-count">${pendingCount}</span> 个，共 ${items.length} 个资源</strong><span id="fml-estimated-total">大小估算中，下载可以立即开始</span></div>
        <div class="fml-type-selectors">
            ${MEDIA_TYPES.map(type => `<label><input class="fml-type-toggle" type="checkbox" data-type="${type}" checked><i class="fa-solid ${TYPE_ICONS[type]}"></i> ${TYPE_LABELS[type]} <span data-count-for="${type}">0</span></label>`).join('')}
            <label class="fml-show-all-toggle"><input id="fml-only-pending-resources" type="checkbox" checked><i class="fa-solid fa-filter"></i> 仅显示未下载/失败</label>
        </div>
        <div class="fml-resource-list">${items.map(item => renderCandidateRow(item)).join('')}</div>
        <footer class="fml-modal-footer">
            <span id="fml-selection-summary">尚未完成估算</span>
            <button class="menu_button fml-cancel">取消</button>
            <button id="fml-download-selected" class="menu_button fml-primary" disabled><i class="fa-solid fa-download"></i> 下载所选资源</button>
        </footer>`;
}

function sniffRecordsModalBody(items, pendingCount) {
    return `
        <div class="fml-scan-summary"><strong>待处理 <span id="fml-pending-count">${pendingCount}</span> 个，共记录 ${items.length} 个实际出现资源</strong><span id="fml-estimated-total">打开列表不会访问在线图床</span></div>
        <div class="fml-type-selectors">
            ${MEDIA_TYPES.map(type => `<label><input class="fml-type-toggle" type="checkbox" data-type="${type}" checked><i class="fa-solid ${TYPE_ICONS[type]}"></i> ${TYPE_LABELS[type]} <span data-count-for="${type}">0</span></label>`).join('')}
            <label class="fml-show-all-toggle"><input id="fml-only-pending-resources" type="checkbox" ${pendingCount ? 'checked' : ''}><i class="fa-solid fa-filter"></i> 仅显示未下载/失败</label>
        </div>
        <div class="fml-resource-list">${items.map(item => renderCandidateRow(item)).join('')}</div>
        <footer class="fml-modal-footer">
            <span id="fml-selection-summary">已选择 0 / ${pendingCount}</span>
            <button class="menu_button fml-cancel">关闭</button>
            <button id="fml-download-selected" class="menu_button fml-primary" disabled><i class="fa-solid fa-download"></i> 下载所选资源</button>
        </footer>`;
}

async function runCandidateManualStep(modal, items, item) {
    const cardName = modal.dataset.cardName || currentCard?.name;
    if (!cardName || item.manualBusy || item.downloaded || !MEDIA_TYPES.includes(item.type)) return;
    const record = candidateRecoveryRecord(item, cardName, true);
    if (!record) return toastr.error('无法为该资源建立下载记录', '资源本地化');
    item.manualBusy = true;
    refreshScanModal(modal, items);
    try {
        await handleManualSniffSave(record);
    } finally {
        item.manualBusy = false;
        syncCandidateRecoveryState(item, cardName);
        refreshScanModal(modal, items);
    }
}

function bindCandidateListActions(modal, items) {
    const list = modal.querySelector('.fml-resource-list');
    list.addEventListener('change', event => {
        if (!event.target.classList.contains('fml-resource-check')) return;
        const row = event.target.closest('.fml-resource-row');
        const item = items.find(candidate => candidate.url === row?.dataset.url);
        if (item) item.selected = event.target.checked;
        updateScanSummary(modal, items);
    });
    list.addEventListener('click', event => {
        const button = event.target.closest('.fml-resource-download');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const row = button.closest('.fml-resource-row');
        const item = items.find(candidate => candidate.url === row?.dataset.url);
        if (item) void runCandidateManualStep(modal, items, item);
    });
}

function openSniffRecordsModal() {
    if (!currentCard) return toastr.info('当前没有角色卡资源记录', '资源嗅探');
    const known = new Map(currentLibrary.filter(item => item.exists).map(item => [item.source, item]));
    const items = currentCardSniffRecords().map(record => {
        const localResource = known.get(record.source);
        const savedPendingRegistration = record.state === 'saved' && !serverAvailable;
        const localMissing = Boolean(record.localMissing && !localResource && serverAvailable);
        const downloaded = Boolean(localResource || savedPendingRegistration);
        let statusLabel = '待下载';
        if (localResource) statusLabel = '已下载到本地';
        else if (savedPendingRegistration) statusLabel = '已写入授权目录，等待服务端登记';
        else if (record.state === 'saving') statusLabel = '正在保存……';
        else if (record.state === 'awaiting-import') statusLabel = '等待导入浏览器下载文件';
        else if (record.state === 'failed') statusLabel = record.error || '下载失败';
        else if (localMissing) statusLabel = '本地文件或映射缺失';
        return {
            url: record.source,
            type: record.type,
            hint: record.type,
            size: Number(localResource?.size || record.saved?.size) || null,
            contentType: localResource?.contentType || record.saved?.contentType || null,
            error: record.state === 'failed' || localMissing ? statusLabel : null,
            selected: !downloaded && record.state !== 'saving',
            downloaded,
            status: record.state === 'saving' ? 'downloading' : record.state === 'failed' || localMissing ? 'error' : downloaded ? 'downloaded' : 'detected',
            statusLabel,
            sniffRecordId: record.id,
            lastSeenAt: record.lastSeenAt || record.createdAt,
        };
    });
    const pendingCount = items.filter(item => !item.downloaded).length;
    const modal = createModal(`${currentCard.name} · 本次嗅探记录`, sniffRecordsModalBody(items, pendingCount), 'fml-scan-modal fml-sniff-records-modal');
    modal.dataset.cardName = currentCard.name;
    modal.dataset.showAll = String(pendingCount === 0);
    modal.dataset.noProbe = 'true';
    modal.querySelector('.fml-cancel').addEventListener('click', closeModal);
    modal.querySelector('#fml-only-pending-resources').addEventListener('change', event => {
        modal.dataset.showAll = String(!event.target.checked);
        refreshScanModal(modal, items);
    });
    modal.querySelectorAll('.fml-type-toggle').forEach(toggle => {
        toggle.addEventListener('change', () => {
            items.filter(item => !item.downloaded && item.type === toggle.dataset.type).forEach(item => item.selected = toggle.checked);
            refreshScanModal(modal, items);
        });
    });
    bindCandidateListActions(modal, items);
    modal.querySelector('#fml-download-selected').addEventListener('click', () => downloadSelected(modal, items));
    refreshScanModal(modal, items);
}

async function openScanModal() {
    if (!currentCard) return toastr.warning('请先选择一张角色卡', '资源本地化');
    if (downloadQueue.some(task => task.cardName === currentCard.name)) return toastr.info('当前角色卡已在下载队列中', '资源本地化');
    if (!serverAvailable) {
        await checkServer();
        if (!serverAvailable) return toastr.error('服务端插件未连接，请重启酒馆后再试', '资源本地化');
    }
    const known = new Set(currentLibrary.filter(item => item.exists).map(item => item.source));
    const items = [...currentCandidates.values()];
    const pendingItems = items.filter(item => !known.has(item.url));
    if (!pendingItems.length) return openLibraryModal();
    items.forEach(item => {
        item.downloaded = known.has(item.url);
        item.selected = !item.downloaded && Boolean(item.type);
        item.status = item.downloaded ? 'downloaded' : 'detected';
        if (!item.downloaded) item.error = null;
    });
    const modal = createModal(`${currentCard.name} · 在线资源`, scanModalBody(items, pendingItems.length), 'fml-scan-modal');
    modal.dataset.cardName = currentCard.name;
    modal.dataset.showAll = 'false';
    modal.querySelector('.fml-cancel').addEventListener('click', closeModal);
    modal.querySelector('#fml-only-pending-resources').addEventListener('change', event => {
        modal.dataset.showAll = String(!event.target.checked);
        refreshScanModal(modal, items);
    });
    modal.querySelectorAll('.fml-type-toggle').forEach(toggle => {
        toggle.addEventListener('change', () => {
            items.filter(item => !item.downloaded && item.type === toggle.dataset.type).forEach(item => item.selected = toggle.checked);
            refreshScanModal(modal, items);
        });
    });
    bindCandidateListActions(modal, items);
    modal.querySelector('#fml-download-selected').addEventListener('click', () => downloadSelected(modal, items));
    refreshScanModal(modal, items);
    await probeCandidates(modal, pendingItems, items);
}

function refreshScanModal(modal, items) {
    const list = modal.querySelector('.fml-resource-list');
    if (!list) return;
    const cardName = modal.dataset.cardName || currentCard?.name || '';
    items.forEach(item => syncCandidateRecoveryState(item, cardName));
    const showAll = modal.dataset.showAll === 'true';
    const rows = items
        .filter(item => (showAll || !item.downloaded) && (MEDIA_TYPES.includes(item.type) || item.status === 'probing'))
        .map(item => renderCandidateRow(item, cardName))
        .join('');
    list.innerHTML = rows || '<div class="fml-inline-empty">当前筛选条件下没有资源记录。</div>';
    updateScanSummary(modal, items);
}

function updateScanSummary(modal, items) {
    if (!modal?.isConnected) return;
    for (const type of MEDIA_TYPES) {
        const typed = items.filter(item => !item.downloaded && item.type === type);
        const count = typed.length;
        const element = modal.querySelector(`[data-count-for="${type}"]`);
        if (element) element.textContent = `(${count})`;
        const toggle = modal.querySelector(`.fml-type-toggle[data-type="${type}"]`);
        if (toggle) {
            toggle.checked = typed.length > 0 && typed.every(item => item.selected);
            toggle.indeterminate = typed.some(item => item.selected) && !typed.every(item => item.selected);
        }
    }
    const mediaItems = items.filter(item => !item.downloaded && MEDIA_TYPES.includes(item.type));
    const selected = mediaItems.filter(item => item.selected);
    const knownSize = selected.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const unknown = selected.filter(item => !Number.isFinite(item.size)).length;
    const total = modal.querySelector('#fml-estimated-total');
    if (total) {
        if (modal.dataset.noProbe === 'true') total.textContent = `本次运行已记录 ${items.length} 个资源；打开列表不会访问在线图床`;
        else {
            const probing = items.some(item => item.status === 'probing');
            if (unknown && knownSize === 0) total.textContent = `${probing ? '正在估算' : '大小未知'}（${unknown} 个）`;
            else total.textContent = `预计 ${formatBytes(knownSize)}${unknown ? `，${unknown} 个大小未知` : ''}${probing ? '，仍在估算' : ''}`;
        }
    }
    const summary = modal.querySelector('#fml-selection-summary');
    if (summary) summary.textContent = `已选择 ${selected.length} / ${mediaItems.length}`;
    const pending = modal.querySelector('#fml-pending-count');
    if (pending) pending.textContent = String(mediaItems.length);
    const button = modal.querySelector('#fml-download-selected');
    if (button) button.disabled = selected.length === 0 || items.some(item => item.status === 'downloading');
}

async function probeCandidates(modal, items, allItems = items) {
    const batches = [];
    for (let index = 0; index < items.length; index += 1) batches.push(items.slice(index, index + 1));
    for (const batch of batches) {
        if (!modal.isConnected) return;
        batch.forEach(item => item.status = 'probing');
        refreshScanModal(modal, allItems);
        try {
            const data = await api('/probe', {
                method: 'POST',
                body: JSON.stringify({ resources: batch.map(item => ({ url: item.url, hint: item.hint })), ratePolicy: getRatePolicy() }),
            });
            for (const result of data.resources ?? []) {
                const item = items.find(candidate => candidate.url === result.url);
                if (!item) continue;
                item.type = result.type;
                item.size = result.size;
                item.contentType = result.contentType;
                const isMedia = MEDIA_TYPES.includes(result.type);
                item.error = isMedia ? null : result.error;
                item.note = isMedia ? result.error : null;
                item.status = isMedia ? 'ready' : 'error';
                item.selected = isMedia;
            }
        } catch (error) {
            batch.forEach(item => {
                if (MEDIA_TYPES.includes(item.type)) {
                    item.error = null;
                    item.note = error.message;
                    item.status = 'ready';
                    item.selected = true;
                } else {
                    item.error = error.message;
                    item.status = 'error';
                    item.selected = false;
                }
            });
        }
        refreshScanModal(modal, allItems);
    }
}

async function downloadSelected(modal, items) {
    const selected = items.filter(item => !item.downloaded && item.selected && MEDIA_TYPES.includes(item.type));
    if (!selected.length) return;
    const button = modal.querySelector('#fml-download-selected');
    button.disabled = true;
    if (!serverAvailable) {
        await checkServer();
        if (!serverAvailable) {
            button.disabled = false;
            return toastr.error('服务端插件未连接，无法直接下载到酒馆资源目录', '资源本地化');
        }
    }
    const cardName = modal.dataset.cardName || currentCard?.name;
    if (!cardName) return;
    if (downloadQueue.some(task => task.cardName === cardName)) return toastr.info('当前角色卡已在下载队列中', '资源本地化');
    const task = {
        id: crypto.randomUUID(),
        cardName,
        total: selected.length,
        completed: 0,
        failed: 0,
        status: 'queued',
        color: nextQueueColor(),
        items,
        selected,
    };
    downloadQueue.push(task);
    queueDisplayIndex = downloadQueue.length - 1;
    closeModal();
    updateFloatingButton();
    toastr.info(`${selected.length} 个资源已加入队列（第 ${downloadQueue.length} 项）`, `${cardName} · 资源本地化`);
    void runDownloadQueue();
}

function nextQueueColor() {
    const used = new Set(downloadQueue.map(task => task.color));
    return QUEUE_COLORS.find(color => !used.has(color)) || QUEUE_COLORS[downloadQueue.length % QUEUE_COLORS.length];
}

async function runDownloadQueue() {
    if (queueRunnerActive) return;
    queueRunnerActive = true;
    while (downloadQueue.length) {
        const task = downloadQueue[0];
        task.status = 'running';
        updateFloatingButton();
        await runDownloadTask(task);
        const result = { ...task };
        downloadQueue.shift();
        queueDisplayIndex = Math.max(0, queueDisplayIndex - 1);
        if (result.failed) toastr.warning(`成功 ${result.completed} 个，失败 ${result.failed} 个`, `${result.cardName} · 下载完成`);
        else toastr.success(`成功下载 ${result.completed} 个资源`, `${result.cardName} · 下载完成`);
        refreshAllCardsInline();
        updateFloatingButton();
    }
    queueRunnerActive = false;
    queueDisplayIndex = 0;
    updateFloatingButton();
}

async function runDownloadTask(task) {
    const { cardName, items, selected } = task;
    for (let index = 0; index < selected.length; index += 1) {
        const batch = selected.slice(index, index + 1);
        batch.forEach(item => item.status = 'downloading');
        try {
            const data = await api('/download', {
                method: 'POST',
                body: JSON.stringify({ card: cardName, resources: batch.map(item => ({ url: item.url, type: item.type })), ratePolicy: getRatePolicy() }),
            });
            for (const result of data.results ?? []) {
                const item = items.find(candidate => candidate.url === (result.resource?.source || result.url));
                if (!item) continue;
                if (result.ok) {
                    item.status = 'done';
                    item.error = null;
                    task.completed++;
                    await activateDownloadedResource(cardName, result.resource);
                }
                else {
                    item.status = 'error';
                    item.error = result.error;
                    item.statusLabel = result.error || '下载失败';
                    item.selected = false;
                    item.directFailed = true;
                    markSniffRecordFailed(cardName, item.url, item.error, item.type);
                    task.failed++;
                }
            }
        } catch (error) {
            batch.forEach(item => {
                item.status = 'error';
                item.error = error.message;
                item.statusLabel = error.message || '下载失败';
                item.selected = false;
                item.directFailed = true;
                markSniffRecordFailed(cardName, item.url, item.error, item.type);
                task.failed++;
            });
        }
        updateFloatingButton();
    }
}

function libraryBody(resources, cardName) {
    const existing = resources.filter(item => item.exists);
    const total = existing.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    return `
        <div class="fml-library-summary"><strong>${escapeHtml(cardName)}</strong><span>本地 ${existing.length} 个 · ${formatBytes(total)}</span></div>
        <div class="fml-type-selectors">
            ${MEDIA_TYPES.map(type => `<label><input class="fml-library-type-toggle" type="checkbox" data-type="${type}"><i class="fa-solid ${TYPE_ICONS[type]}"></i> ${TYPE_LABELS[type]} (${existing.filter(item => item.type === type).length})</label>`).join('')}
        </div>
        <div class="fml-resource-list">
            ${existing.length ? existing.map(item => `
                <label class="fml-resource-row" data-id="${item.id}" data-type="${item.type}">
                    <input class="fml-library-check" type="checkbox">
                    <i class="fa-solid ${TYPE_ICONS[item.type] || 'fa-file'} fml-type-icon"></i>
                    <span class="fml-resource-main"><span class="fml-resource-host">${escapeHtml(item.filename || item.id)}</span><span class="fml-resource-url" title="${escapeHtml(item.source)}">${escapeHtml(item.source)}</span></span>
                    <span class="fml-resource-status">${formatBytes(Number(item.size))}</span>
                </label>`).join('') : '<div class="fml-empty-state">当前角色卡没有已下载的本地资源。</div>'}
        </div>
        <footer class="fml-modal-footer fml-library-footer">
            <button id="fml-library-open" class="menu_button"><i class="fa-solid fa-folder-open"></i> 打开文件夹</button>
            <span class="fml-footer-spacer"></span>
            <button id="fml-delete-selected" class="menu_button fml-danger" disabled><i class="fa-solid fa-trash"></i> 删除所选</button>
            <button id="fml-delete-card" class="menu_button fml-danger" ${existing.length ? '' : 'disabled'}>删除当前卡全部资源</button>
            <button class="menu_button fml-close-library">关闭</button>
        </footer>`;
}

async function openLibraryModal(requestedCard = null) {
    if (downloadQueue.length) return toastr.info('资源下载队列运行期间不能删除或管理文件夹', '资源本地化');
    const cardName = typeof requestedCard === 'string' && requestedCard ? requestedCard : currentCard?.name;
    if (!cardName) return toastr.warning('请先选择一张角色卡', '资源本地化');
    if (!serverAvailable) {
        await checkServer();
        if (!serverAvailable) return toastr.error('服务端插件未连接，请重启酒馆后再试', '资源本地化');
    }
    const isCurrentCard = currentCard?.name === cardName;
    let resources;
    if (isCurrentCard) {
        resources = await loadLibrary(cardName);
    } else {
        const data = await api(`/library?card=${encodeURIComponent(cardName)}`, { method: 'GET', headers: {} });
        resources = Array.isArray(data.resources) ? data.resources : [];
    }
    const modal = createModal(`${cardName} · 本地资源管理`, libraryBody(resources, cardName), 'fml-library-modal');
    modal.querySelector('.fml-close-library').addEventListener('click', closeModal);
    modal.querySelector('#fml-library-open').addEventListener('click', () => openCardFolder(cardName));
    const updateDeleteButton = () => {
        modal.querySelector('#fml-delete-selected').disabled = modal.querySelectorAll('.fml-library-check:checked').length === 0;
    };
    modal.querySelector('.fml-resource-list').addEventListener('change', event => {
        if (event.target.classList.contains('fml-library-check')) updateDeleteButton();
    });
    modal.querySelectorAll('.fml-library-type-toggle').forEach(toggle => {
        toggle.addEventListener('change', () => {
            modal.querySelectorAll(`.fml-resource-row[data-type="${toggle.dataset.type}"] .fml-library-check`).forEach(check => check.checked = toggle.checked);
            updateDeleteButton();
        });
    });
    modal.querySelector('#fml-delete-selected').addEventListener('click', async () => {
        const ids = [...modal.querySelectorAll('.fml-library-check:checked')].map(check => check.closest('.fml-resource-row').dataset.id);
        if (!ids.length || !confirm(`确定删除选中的 ${ids.length} 个本地资源吗？删除后会自动使用在线地址。`)) return;
        await api('/delete', { method: 'POST', body: JSON.stringify({ card: cardName, ids }) });
        toastr.success(`已删除 ${ids.length} 个本地资源`, '资源本地化');
        if (currentCard) await loadLibrary(currentCard.name);
        openLibraryModal(cardName);
    });
    modal.querySelector('#fml-delete-card').addEventListener('click', async () => {
        if (!confirm(`确定删除“${cardName}”的全部本地资源吗？前端卡会回退到在线地址。`)) return;
        await api('/delete-card', { method: 'POST', body: JSON.stringify({ card: cardName }) });
        toastr.success(`已删除“${cardName}”的全部本地资源`, '资源本地化');
        if (currentCard) await loadLibrary(currentCard.name);
        openLibraryModal(cardName);
    });
}

async function openCardFolder(cardName) {
    if (!serverAvailable) return toastr.error('服务端插件未连接', '资源本地化');
    try {
        await api('/open', { method: 'POST', body: JSON.stringify({ card: cardName || null }) });
    } catch (error) {
        toastr.error(error.message, '无法打开文件夹');
    }
}

async function openCurrentFolder() {
    return openCardFolder(currentCard?.name || null);
}

function allCardsBody(cards) {
    const totalCount = cards.reduce((sum, card) => sum + card.count, 0);
    const totalSize = cards.reduce((sum, card) => sum + (Number(card.size) || 0), 0);
    return `
        <div class="fml-library-summary"><strong>${cards.length} 张角色卡</strong><span>本地 ${totalCount} 个资源 · ${formatBytes(totalSize)}</span></div>
        <div class="fml-card-resource-list">
            ${cards.length ? cards.map(card => `
                <section class="fml-card-resource-row" data-card="${escapeHtml(card.card)}">
                    <div class="fml-card-resource-info">
                        <strong title="${escapeHtml(card.card)}">${escapeHtml(card.card)}</strong>
                        <span><i class="fa-solid fa-image"></i> ${card.counts.image}　<i class="fa-solid fa-music"></i> ${card.counts.audio}　<i class="fa-solid fa-film"></i> ${card.counts.video}　·　${formatBytes(Number(card.size))}</span>
                    </div>
                    <div class="fml-card-resource-actions">
                        <button class="fml-card-icon-button fml-open-card-folder" title="打开文件夹" aria-label="打开文件夹"><i class="fa-solid fa-folder-open"></i></button>
                        <button class="fml-card-icon-button fml-danger fml-delete-all-card" title="删除全部资源" aria-label="删除全部资源"><i class="fa-solid fa-trash"></i></button>
                        <button class="fml-card-icon-button fml-review-card" title="审查资源" aria-label="审查资源"><i class="fa-solid fa-eye"></i></button>
                    </div>
                </section>`).join('') : '<div class="fml-empty-state">还没有任何角色卡的本地资源。</div>'}
        </div>
        <footer class="fml-modal-footer fml-library-footer">
            <button id="fml-open-resources-root" class="menu_button"><i class="fa-solid fa-folder-tree"></i> 打开资源根目录</button>
            <span class="fml-footer-spacer"></span>
            <button class="menu_button fml-close-all-cards">关闭</button>
        </footer>`;
}

function inlineCardsHtml(cards) {
    return cards.map(card => `
        <div class="fml-inline-card-row" data-card="${escapeHtml(card.card)}">
            <div class="fml-inline-card-info">
                <strong title="${escapeHtml(card.card)}">${escapeHtml(card.card)}</strong>
                <small><i class="fa-solid fa-image"></i> ${card.counts.image}　<i class="fa-solid fa-music"></i> ${card.counts.audio}　<i class="fa-solid fa-film"></i> ${card.counts.video}　·　${formatBytes(Number(card.size))}</small>
            </div>
            <div class="fml-card-resource-actions">
                <button class="fml-card-icon-button fml-open-card-folder" title="打开文件夹" aria-label="打开文件夹"><i class="fa-solid fa-folder-open"></i></button>
                <button class="fml-card-icon-button fml-danger fml-delete-all-card" title="删除全部资源" aria-label="删除全部资源"><i class="fa-solid fa-trash"></i></button>
                <button class="fml-card-icon-button fml-review-card" title="审查资源" aria-label="审查资源"><i class="fa-solid fa-eye"></i></button>
            </div>
        </div>`).join('');
}

async function refreshAllCardsInline() {
    const list = document.querySelector('#fml-all-cards-inline-list');
    const summary = document.querySelector('#fml-all-cards-summary');
    if (!list || !summary || !serverAvailable || document.hidden) return;
    if (allCardsRefreshPromise) return allCardsRefreshPromise;
    allCardsRefreshPromise = (async () => {
        try {
            const data = await api('/cards', { method: 'GET', headers: {} });
            const cards = Array.isArray(data.cards) ? data.cards : [];
            const count = cards.reduce((sum, card) => sum + card.count, 0);
            const size = cards.reduce((sum, card) => sum + (Number(card.size) || 0), 0);
            summary.textContent = cards.length ? `${cards.length} 张卡，共 ${count} 个资源（${formatBytes(size)}）· 自动刷新` : '暂无已下载的角色卡资源 · 自动刷新';
            list.innerHTML = cards.length ? inlineCardsHtml(cards) : '<div class="fml-inline-empty">下载成功的角色卡会自动显示在这里。</div>';
        } catch (error) {
            summary.textContent = '资源列表暂不可用，请重启酒馆加载服务端更新';
            list.innerHTML = '';
            console.debug('[FrontendMediaLocalizer] Silent card resource refresh failed:', error);
        }
    })().finally(() => { allCardsRefreshPromise = null; });
    return allCardsRefreshPromise;
}

async function handleInlineCardAction(event) {
    const row = event.target.closest('.fml-inline-card-row');
    if (!row) return;
    const card = row.dataset.card;
    if (event.target.closest('.fml-open-card-folder')) return openCardFolder(card);
    if (event.target.closest('.fml-review-card')) return openLibraryModal(card);
    if (!event.target.closest('.fml-delete-all-card')) return;
    if (downloadQueue.length) return toastr.info('下载队列运行期间不能删除资源', '资源本地化');
    if (!confirm(`确定删除“${card}”的全部本地资源吗？该卡会回退到在线地址。`)) return;
    await api('/delete-card', { method: 'POST', body: JSON.stringify({ card }) });
    if (currentCard) await loadLibrary(currentCard.name);
    await refreshAllCardsInline();
    toastr.success(`已删除“${card}”的全部本地资源`, '资源本地化');
}

async function openAllCardsModal() {
    if (downloadQueue.length) return toastr.info('资源下载队列运行期间不能删除或管理文件夹', '资源本地化');
    if (!serverAvailable) {
        await checkServer();
        if (!serverAvailable) return toastr.error('服务端插件未连接，请重启酒馆后再试', '资源本地化');
    }
    const data = await api('/cards', { method: 'GET', headers: {} });
    const cards = Array.isArray(data.cards) ? data.cards : [];
    const modal = createModal('所有角色卡 · 本地资源管理', allCardsBody(cards), 'fml-all-cards-modal');
    modal.querySelector('.fml-close-all-cards').addEventListener('click', closeModal);
    modal.querySelector('#fml-open-resources-root').addEventListener('click', () => api('/open', {
        method: 'POST',
        body: JSON.stringify({ card: null }),
    }).catch(error => toastr.error(error.message, '无法打开文件夹')));
    modal.querySelector('.fml-card-resource-list').addEventListener('click', async event => {
        const row = event.target.closest('.fml-card-resource-row');
        if (!row) return;
        const card = row.dataset.card;
        if (event.target.closest('.fml-open-card-folder')) {
            await openCardFolder(card);
            return;
        }
        if (event.target.closest('.fml-review-card')) {
            await openLibraryModal(card);
            return;
        }
        if (!event.target.closest('.fml-delete-all-card')) return;
        if (!confirm(`确定删除“${card}”的全部本地资源吗？该卡会回退到在线地址。`)) return;
        await api('/delete-card', { method: 'POST', body: JSON.stringify({ card }) });
        if (currentCard) await loadLibrary(currentCard.name);
        await refreshAllCardsInline();
        toastr.success(`已删除“${card}”的全部本地资源`, '资源本地化');
        openAllCardsModal();
    });
}

function bindRewriteEvent(eventName) {
    const handler = async messageId => {
        if (!serverStatusChecked || serverHealthPromise) await checkServer();
        await handleCardChange();
        rewriteMessage(messageId);
    };
    if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(eventName, handler);
    else eventSource.on(eventName, handler);
}

function initializeEvents() {
    if (lifecycleEventsInitialized) return;
    lifecycleEventsInitialized = true;
    bindRewriteEvent(event_types.CHARACTER_MESSAGE_RENDERED);
    bindRewriteEvent(event_types.USER_MESSAGE_RENDERED);
    bindRewriteEvent(event_types.MESSAGE_UPDATED);
    const handleChatChanged = async () => {
        if (!serverStatusChecked || serverHealthPromise) await checkServer();
        return handleCardChange({ force: true });
    };
    if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(event_types.CHAT_CHANGED, handleChatChanged);
    else eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.CHARACTER_EDITED, handleChatChanged);
    eventSource.on('message_iframe_render_ended', async iframeId => {
        if (!serverStatusChecked || serverHealthPromise) await checkServer();
        await handleCardChange();
        const iframe = document.getElementById(iframeId);
        if (getSettings().enabled && (isOfflineMode() || shouldUseLocalRoutes())) rewriteIframe(iframe);
        else restoreDocumentResources(iframe?.contentDocument);
        collectRuntimeResources(iframe);
    });
    document.addEventListener('error', handleLocalizedMediaError, true);
    document.addEventListener('load', handleMediaLoaded, true);
    document.addEventListener('loadeddata', handleMediaLoaded, true);
    document.addEventListener('loadedmetadata', handleMediaLoaded, true);
    document.addEventListener('canplay', handleMediaLoaded, true);
    document.addEventListener('play', handleMediaLoaded, true);
    document.addEventListener('playing', handleMediaLoaded, true);
}

getSettings();
installTopLevelAudioRouter();
initializeEvents();
void checkServer();

jQuery(async () => {
    const storedHandlePromise = readStoredHandle().catch(() => null);
    injectFloatingButton();
    injectSettingsPanel();
    resourceDirectoryHandle = await storedHandlePromise;
    updateHandleStatus();
    const handleViewportChange = () => {
        const button = document.querySelector('#fml-floating-button');
        const mode = floatingPositionMode();
        if (mode !== floatingViewportMode) applyFloatingPosition(button);
        else clampFloatingButton(button);
    };
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('scroll', handleViewportChange, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        refreshAllCardsInline();
        void refreshCurrentLibrarySilently();
    });
    if (!serverHealthTimer) serverHealthTimer = setInterval(() => void checkServer(), 5000);
    if (!currentLibraryPollTimer) currentLibraryPollTimer = setInterval(() => void refreshCurrentLibrarySilently(), 10000);
    await checkServer();
    await handleCardChange({ force: true });
    document.querySelectorAll('iframe').forEach(iframe => {
        if (getSettings().enabled && (isOfflineMode() || shouldUseLocalRoutes())) rewriteIframe(iframe);
        else restoreDocumentResources(iframe.contentDocument);
        collectRuntimeResources(iframe);
    });
    if (!serverAvailable && !backendInstallPrompted) {
        backendInstallPrompted = true;
        const message = backendUpdateRequired
            ? `检测到后端版本过旧，必须更新至 ${REQUIRED_BACKEND_VERSION} 后才能继续下载。`
            : '';
        setTimeout(() => openBackendInstaller(message), 250);
    }
    console.log('[FrontendMediaLocalizer] Extension initialized.');
});
