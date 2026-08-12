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
const BACKEND_PLUGIN_FOLDER = 'frontend-media-localizer';
const BACKEND_TEMPLATE_FILES = ['index.mjs', 'package.json'];
const MEDIA_TYPES = ['image', 'audio', 'video'];
const TYPE_LABELS = { image: '图片', audio: '音频', video: '视频' };
const TYPE_ICONS = { image: 'fa-image', audio: 'fa-music', video: 'fa-film' };
const QUEUE_COLORS = ['#62a9ed', '#f39c5a', '#58bd7b', '#ae7bea', '#ed6fa5', '#46c7c7', '#e3bd4f', '#e36b6b'];
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\]+/gi;

const defaults = {
    enabled: true,
    showFloatingButton: true,
};

let currentCard = null;
let currentCandidates = new Map();
let currentLibrary = [];
let routeMap = new Map();
let routeRegex = null;
let serverAvailable = false;
let activeModal = null;
let cardChangeSequence = 0;
let downloadQueue = [];
let queueRunnerActive = false;
let queueDisplayIndex = 0;
let allCardsRefreshPromise = null;
let allCardsPollTimer = null;
let backendInstallPrompted = false;

function getSettings() {
    if (!extension_settings[EXTENSION_KEY] || typeof extension_settings[EXTENSION_KEY] !== 'object') {
        extension_settings[EXTENSION_KEY] = structuredClone(defaults);
    }
    for (const [key, value] of Object.entries(defaults)) {
        if (extension_settings[EXTENSION_KEY][key] === undefined) extension_settings[EXTENSION_KEY][key] = value;
    }
    return extension_settings[EXTENSION_KEY];
}

function saveSettings() {
    saveSettingsDebounced();
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
        if (url.origin === location.origin && url.pathname.startsWith(API_BASE)) return null;
        return url.href;
    } catch {
        return null;
    }
}

function inferType(url, context = '') {
    let pathname = '';
    try { pathname = new URL(url).pathname.toLowerCase(); } catch { return null; }
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

async function checkServer() {
    try {
        const status = await api('/status', { method: 'GET', headers: {} });
        serverAvailable = Boolean(status.enabled && status.writable);
        updateSettingsStatus(status);
        refreshAllCardsInline();
        return status;
    } catch (error) {
        serverAvailable = false;
        updateSettingsStatus({ enabled: false, error: error.message });
        return null;
    }
}

function updateSettingsStatus(status) {
    const indicator = document.querySelector('#fml-server-status');
    if (indicator) {
        indicator.className = `fml-status ${status?.writable ? 'is-ok' : 'is-error'}`;
        indicator.textContent = status?.writable ? '服务端已连接，可读写' : '服务端未连接，请重启酒馆';
        indicator.title = status?.error || '';
    }
    const installer = document.querySelector('#fml-backend-install-row');
    if (installer) installer.hidden = Boolean(status?.enabled && status?.writable);
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
    return `
        <div class="fml-installer-copy">
            <p>完整的资源下载功能需要酒馆服务端后端。它尚未被检测到。</p>
            <p>点击安装后，请在系统选择框中选中 <code>SillyTavern/plugins</code> 文件夹。扩展会在其中写入 <code>frontend-media-localizer</code> 后端文件。</p>
            <p>安装完成后必须重启酒馆；若重启后仍未连接，请在 <code>config.yaml</code> 中启用 <code>enableServerPlugins: true</code>。</p>
            <div class="fml-installer-result">${escapeHtml(message)}</div>
        </div>
        <footer class="fml-modal-footer">
            <button class="menu_button fml-close-installer">稍后处理</button>
            <button class="menu_button fml-install-backend"><i class="fa-solid fa-download"></i> 选择 plugins 文件夹并安装</button>
        </footer>`;
}

function openBackendInstaller(message = '') {
    const modal = createModal('安装资源本地化后端', backendInstallerBody(message), 'fml-backend-installer-modal');
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
            result.textContent = '后端文件已写入。请完全重启酒馆，然后本扩展会自动连接。';
            installButton.hidden = true;
        } catch (error) {
            if (error?.name === 'AbortError') result.textContent = '未选择文件夹，安装已取消。';
            else result.textContent = `安装失败：${error.message || error}`;
        } finally {
            installButton.disabled = false;
        }
    });
}

async function getActiveCard() {
    if (this_chid === undefined || !characters[this_chid]) return null;
    await unshallowCharacter(this_chid).catch(() => {});
    const character = characters[this_chid];
    if (!character) return null;
    return { name: character.name || character.avatar?.replace(/\.png$/i, '') || 'Unnamed Character', character };
}

async function loadLibrary(cardName = currentCard?.name) {
    if (!cardName || !serverAvailable) {
        currentLibrary = [];
        setRouteMap([]);
        return [];
    }
    const data = await api(`/library?card=${encodeURIComponent(cardName)}`, { method: 'GET', headers: {} });
    currentLibrary = Array.isArray(data.resources) ? data.resources : [];
    setRouteMap(currentLibrary);
    updateFloatingButton();
    updateSettingsSummary();
    return currentLibrary;
}

function setRouteMap(resources) {
    routeMap = new Map(resources.filter(item => item.source && item.localUrl).map(item => [item.source, item.localUrl]));
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
}

function rewriteText(text) {
    if (!routeRegex || typeof text !== 'string') return text;
    routeRegex.lastIndex = 0;
    return text.replace(routeRegex, match => routeMap.get(match) || match);
}

function rewriteMessage(messageId) {
    if (!getSettings().enabled || !routeMap.size) return;
    const hasMessageId = messageId !== null && messageId !== undefined && Number.isFinite(Number(messageId));
    const selector = hasMessageId ? `#chat > .mes[mesid="${Number(messageId)}"]` : '#chat > .mes';
    document.querySelectorAll(`${selector} pre code`).forEach(code => {
        const original = code.textContent || '';
        const rewritten = rewriteText(original);
        if (rewritten !== original) code.textContent = rewritten;
    });
}

function rewriteAllMessages() {
    rewriteMessage(null);
}

function rewriteIframe(iframe) {
    if (!iframe?.contentDocument || !routeMap.size) return;
    const documentRef = iframe.contentDocument;
    documentRef.querySelectorAll('img[src], audio[src], video[src], source[src], video[poster]').forEach(element => {
        for (const attribute of ['src', 'poster']) {
            const value = element.getAttribute(attribute);
            const replacement = value && routeMap.get(value);
            if (replacement) element.setAttribute(attribute, replacement);
        }
    });
    documentRef.querySelectorAll('[style]').forEach(element => {
        const value = element.getAttribute('style');
        const replacement = rewriteText(value);
        if (replacement !== value) element.setAttribute('style', replacement);
    });
}

function collectRuntimeResources(iframe) {
    if (!iframe?.contentWindow) return;
    let entries = [];
    try { entries = iframe.contentWindow.performance.getEntriesByType('resource'); } catch { return; }
    for (const entry of entries) {
        if (!['img', 'audio', 'video'].includes(entry.initiatorType) && !inferType(entry.name)) continue;
        const url = normalizeCandidate(entry.name);
        if (!url || currentCandidates.has(url)) continue;
        const type = inferType(url, entry.initiatorType);
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
    updateFloatingButton();
}

async function handleCardChange() {
    const sequence = ++cardChangeSequence;
    const card = await getActiveCard();
    if (sequence !== cardChangeSequence) return;
    currentCard = card;
    currentCandidates = card ? collectRemoteResources(card.character) : new Map();
    currentLibrary = [];
    setRouteMap([]);
    if (card && serverAvailable) await loadLibrary(card.name).catch(error => toastr.error(error.message, '资源本地化'));
    if (sequence !== cardChangeSequence) return;
    rewriteAllMessages();
    updateFloatingButton();
    updateSettingsSummary();
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
    button.hidden = !(settings.enabled && settings.showFloatingButton && (hasQueue || (currentCard && detected > 0)));
    button.classList.toggle('is-downloading', hasQueue);
    button.classList.toggle('has-pending', !hasQueue && pending > 0);
    const icon = button.querySelector('.fml-floating-icon');
    const progress = button.querySelector('.fml-floating-progress');
    const progressPercent = button.querySelector('.fml-progress-percent');
    const progressCount = button.querySelector('.fml-progress-count');
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
    if (icon) icon.hidden = hasQueue;
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
    const button = document.createElement('button');
    button.id = 'fml-floating-button';
    button.className = 'fml-floating-button';
    button.hidden = true;
    button.innerHTML = `
        <i class="fa-solid fa-box-archive fml-floating-icon"></i>
        <span class="fml-floating-progress" hidden>
            <strong class="fml-progress-percent">0%</strong>
            <small class="fml-progress-count">0/0</small>
        </span>
        <span class="fml-floating-badge" hidden>0</span>`;
    button.addEventListener('click', () => {
        if (downloadQueue.length) {
            const currentCardQueued = currentCard && downloadQueue.some(task => task.cardName === currentCard.name);
            if (currentCard && !currentCardQueued && unresolvedCandidates().length) {
                openScanModal();
                return;
            }
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
    });
    document.body.append(button);
}

function injectSettingsPanel() {
    if (document.querySelector('#fml-settings')) return;
    const container = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings_container');
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
                    <label class="fml-check-row"><span>启用资源本地化</span><input id="fml-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}></label>
                    <label class="fml-check-row"><span>显示悬浮球</span><input id="fml-show-floating" type="checkbox" ${settings.showFloatingButton ? 'checked' : ''}></label>
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

    panel.querySelector('#fml-enabled').addEventListener('change', async event => {
        settings.enabled = event.target.checked;
        saveSettings();
        updateFloatingButton();
        if (settings.enabled) rewriteAllMessages();
        await rerenderFrontendFrames();
    });
    panel.querySelector('#fml-show-floating').addEventListener('change', event => {
        settings.showFloatingButton = event.target.checked;
        saveSettings();
        updateFloatingButton();
    });
    panel.querySelector('#fml-scan-now').addEventListener('click', openScanModal);
    panel.querySelector('#fml-manage-now').addEventListener('click', () => openLibraryModal());
    panel.querySelector('#fml-open-folder').addEventListener('click', openCurrentFolder);
    panel.querySelector('#fml-manage-all-cards').addEventListener('click', openAllCardsModal);
    panel.querySelector('#fml-all-cards-inline-list').addEventListener('click', handleInlineCardAction);
    panel.querySelector('#fml-install-backend-settings').addEventListener('click', () => openBackendInstaller());
    updateSettingsSummary();
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

function renderCandidateRow(item) {
    const type = MEDIA_TYPES.includes(item.type) ? item.type : 'unknown';
    const host = (() => { try { return new URL(item.url).hostname; } catch { return ''; } })();
    const status = item.downloaded ? '已下载' : item.error ? item.error : item.status === 'probing' ? '正在估算……' : item.status === 'downloading' ? '正在下载……' : item.status === 'done' ? '已完成' : formatBytes(item.size);
    return `
        <label class="fml-resource-row ${item.downloaded ? 'is-downloaded' : ''}" data-url="${escapeHtml(item.url)}" data-type="${type}">
            <input class="fml-resource-check" type="checkbox" ${item.selected && MEDIA_TYPES.includes(item.type) && !item.downloaded ? 'checked' : ''} ${!MEDIA_TYPES.includes(item.type) || item.downloaded ? 'disabled' : ''}>
            <i class="fa-solid ${TYPE_ICONS[item.type] || 'fa-circle-question'} fml-type-icon"></i>
            <span class="fml-resource-main"><span class="fml-resource-host">${escapeHtml(host)}</span><span class="fml-resource-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span></span>
            <span class="fml-resource-status ${item.error ? 'is-error' : ''}">${escapeHtml(status)}</span>
        </label>`;
}

function scanModalBody(items, pendingCount) {
    return `
        <div class="fml-scan-summary"><strong>待处理 <span id="fml-pending-count">${pendingCount}</span> 个，共 ${items.length} 个资源</strong><span id="fml-estimated-total">大小估算中，下载可以立即开始</span></div>
        <div class="fml-type-selectors">
            ${MEDIA_TYPES.map(type => `<label><input class="fml-type-toggle" type="checkbox" data-type="${type}" checked><i class="fa-solid ${TYPE_ICONS[type]}"></i> ${TYPE_LABELS[type]} <span data-count-for="${type}">0</span></label>`).join('')}
            <label class="fml-show-all-toggle"><input id="fml-only-pending-resources" type="checkbox" checked><i class="fa-solid fa-filter"></i> 仅显示未下载/失败</label>
        </div>
        <div class="fml-resource-list">${items.map(renderCandidateRow).join('')}</div>
        <footer class="fml-modal-footer">
            <span id="fml-selection-summary">尚未完成估算</span>
            <button class="menu_button fml-cancel">取消</button>
            <button id="fml-download-selected" class="menu_button fml-primary" disabled><i class="fa-solid fa-download"></i> 下载所选资源</button>
        </footer>`;
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
    modal.querySelector('.fml-resource-list').addEventListener('change', event => {
        if (!event.target.classList.contains('fml-resource-check')) return;
        const row = event.target.closest('.fml-resource-row');
        const item = items.find(candidate => candidate.url === row.dataset.url);
        if (item) item.selected = event.target.checked;
        updateScanSummary(modal, items);
    });
    modal.querySelector('#fml-download-selected').addEventListener('click', () => downloadSelected(modal, items));
    refreshScanModal(modal, items);
    await probeCandidates(modal, pendingItems, items);
}

function refreshScanModal(modal, items) {
    const list = modal.querySelector('.fml-resource-list');
    if (!list) return;
    const showAll = modal.dataset.showAll === 'true';
    list.innerHTML = items
        .filter(item => (showAll || !item.downloaded) && (MEDIA_TYPES.includes(item.type) || item.status === 'probing'))
        .map(renderCandidateRow)
        .join('');
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
        const probing = items.some(item => item.status === 'probing');
        if (unknown && knownSize === 0) total.textContent = `${probing ? '正在估算' : '大小未知'}（${unknown} 个）`;
        else total.textContent = `预计 ${formatBytes(knownSize)}${unknown ? `，${unknown} 个大小未知` : ''}${probing ? '，仍在估算' : ''}`;
    }
    const summary = modal.querySelector('#fml-selection-summary');
    if (summary) summary.textContent = `已选择 ${selected.length} / ${mediaItems.length}`;
    const button = modal.querySelector('#fml-download-selected');
    if (button) button.disabled = selected.length === 0 || items.some(item => item.status === 'downloading');
}

async function probeCandidates(modal, items, allItems = items) {
    const batches = [];
    for (let index = 0; index < items.length; index += 500) batches.push(items.slice(index, index + 500));
    for (const batch of batches) {
        if (!modal.isConnected) return;
        batch.forEach(item => item.status = 'probing');
        refreshScanModal(modal, allItems);
        try {
            const data = await api('/probe', {
                method: 'POST',
                body: JSON.stringify({ resources: batch.map(item => ({ url: item.url, hint: item.hint })) }),
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
    for (let index = 0; index < selected.length; index += 6) {
        const batch = selected.slice(index, index + 6);
        batch.forEach(item => item.status = 'downloading');
        try {
            const data = await api('/download', {
                method: 'POST',
                body: JSON.stringify({ card: cardName, resources: batch.map(item => ({ url: item.url, type: item.type })) }),
            });
            for (const result of data.results ?? []) {
                const item = items.find(candidate => candidate.url === (result.resource?.source || result.url));
                if (!item) continue;
                if (result.ok) { item.status = 'done'; item.error = null; task.completed++; }
                else { item.status = 'error'; item.error = result.error; item.selected = false; task.failed++; }
            }
        } catch (error) {
            batch.forEach(item => {
                item.status = 'error';
                item.error = error.message;
                item.selected = false;
                task.failed++;
            });
        }
        updateFloatingButton();
    }
    try {
        if (currentCard?.name === cardName) {
            await loadLibrary(cardName);
            rewriteAllMessages();
            await rerenderFrontendFrames();
        }
    } catch (error) {
        console.error('[FrontendMediaLocalizer] Failed to refresh localized routes:', error);
    }
}

async function rerenderFrontendFrames() {
    const ids = [...new Set([...document.querySelectorAll('#chat > .mes:has(pre code)')].map(element => Number(element.getAttribute('mesid'))).filter(Number.isFinite))];
    for (const id of ids) await eventSource.emit(event_types.MESSAGE_UPDATED, id);
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
    const handler = messageId => rewriteMessage(messageId);
    if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(eventName, handler);
    else eventSource.on(eventName, handler);
}

function initializeEvents() {
    bindRewriteEvent(event_types.CHARACTER_MESSAGE_RENDERED);
    bindRewriteEvent(event_types.USER_MESSAGE_RENDERED);
    bindRewriteEvent(event_types.MESSAGE_UPDATED);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(handleCardChange, 50);
    });
    eventSource.on(event_types.CHARACTER_EDITED, () => setTimeout(handleCardChange, 100));
    eventSource.on('message_iframe_render_ended', iframeId => {
        const iframe = document.getElementById(iframeId);
        rewriteIframe(iframe);
        collectRuntimeResources(iframe);
    });
}

jQuery(async () => {
    getSettings();
    injectFloatingButton();
    injectSettingsPanel();
    initializeEvents();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAllCardsInline(); });
    await checkServer();
    await handleCardChange();
    if (!serverAvailable && !backendInstallPrompted) {
        backendInstallPrompted = true;
        setTimeout(() => openBackendInstaller(), 250);
    }
    console.log('[FrontendMediaLocalizer] Extension initialized.');
});
