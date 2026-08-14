import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import mime from 'mime-types';
import multer from 'multer';
import sanitize from 'sanitize-filename';

export const info = {
    id: 'frontend-media-localizer',
    name: 'Frontend Card Media Localizer',
    version: '1.6.0',
    description: 'Downloads and serves frontend-card image, audio, and video resources from the SillyTavern data directory.',
};

const MANIFEST_VERSION = 1;
const MAX_REDIRECTS = 5;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;
const DEFAULT_REMOTE_REQUEST_INTERVAL_MS = 1000;
const MIN_REMOTE_REQUEST_INTERVAL_MS = 100;
const MAX_REMOTE_REQUEST_INTERVAL_MS = 60 * 60 * 1000;
const SUPPORTED_TYPES = new Set(['image', 'audio', 'video']);
const SAFE_ID = /^[a-f0-9]{64}$/;

const remoteRequestSchedules = new Map();
let remoteRequestGate = Promise.resolve();

function clampInterval(value, fallback = DEFAULT_REMOTE_REQUEST_INTERVAL_MS) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(MAX_REMOTE_REQUEST_INTERVAL_MS, Math.max(MIN_REMOTE_REQUEST_INTERVAL_MS, Math.round(parsed))) : fallback;
}

function normalizeRatePolicy(value) {
    const rules = [];
    const seen = new Set();
    for (const item of Array.isArray(value?.rules) ? value.rules.slice(0, 100) : []) {
        const domain = String(item?.domain ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
        if (!domain || seen.has(domain) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) continue;
        seen.add(domain);
        rules.push({ domain, intervalMs: clampInterval(item?.intervalMs) });
    }
    rules.sort((left, right) => right.domain.length - left.domain.length);
    return { defaultIntervalMs: clampInterval(value?.defaultIntervalMs), rules };
}

function rateLimitForUrl(url, policy) {
    const hostname = new URL(url).hostname.toLowerCase();
    const rule = policy.rules.find(item => hostname === item.domain || hostname.endsWith(`.${item.domain}`));
    return { key: rule?.domain || hostname, intervalMs: rule?.intervalMs ?? policy.defaultIntervalMs };
}

async function waitForRemoteRequestSlot(url, policy) {
    const { key, intervalMs } = rateLimitForUrl(url, policy);
    const schedule = remoteRequestSchedules.get(key) ?? { lastStartedAt: 0 };
    const turn = remoteRequestGate.then(async () => {
        const delay = Math.max(0, schedule.lastStartedAt + intervalMs - Date.now());
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        schedule.lastStartedAt = Date.now();
    });
    remoteRequestGate = turn.catch(() => {});
    remoteRequestSchedules.set(key, schedule);
    await turn;
}

function resourcesRoot() {
    return path.resolve(globalThis.DATA_ROOT, 'resources');
}

function safeCardName(value) {
    const cleaned = sanitize(String(value ?? '').trim(), { replacement: '_' })
        .replace(/[. ]+$/g, '')
        .slice(0, 120);
    return cleaned || 'Unnamed Character';
}

function cardDirectory(card) {
    return path.join(resourcesRoot(), safeCardName(card));
}

function manifestPath(card) {
    return path.join(cardDirectory(card), 'manifest.json');
}

function emptyManifest(card) {
    return {
        version: MANIFEST_VERSION,
        card: safeCardName(card),
        updatedAt: new Date().toISOString(),
        resources: {},
    };
}

async function readManifest(card) {
    try {
        const value = JSON.parse(await fs.promises.readFile(manifestPath(card), 'utf8'));
        if (!value || typeof value !== 'object' || typeof value.resources !== 'object') {
            return emptyManifest(card);
        }
        return { ...emptyManifest(card), ...value, resources: value.resources ?? {} };
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('[FrontendMediaLocalizer] Failed to read manifest:', error.message);
        return emptyManifest(card);
    }
}

async function writeManifest(card, manifest) {
    const directory = cardDirectory(card);
    await fs.promises.mkdir(directory, { recursive: true });
    manifest.version = MANIFEST_VERSION;
    manifest.card = safeCardName(card);
    manifest.updatedAt = new Date().toISOString();
    const target = manifestPath(card);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8');
    await fs.promises.rename(temporary, target);
}

function resourceId(url) {
    return crypto.createHash('sha256').update(url).digest('hex');
}

function parseRemoteUrl(value) {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) resources are supported.');
    if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed.');
    return parsed;
}

function isPrivateIp(address) {
    if (net.isIPv4(address)) {
        const parts = address.split('.').map(Number);
        return parts[0] === 10
            || parts[0] === 127
            || parts[0] === 0
            || (parts[0] === 169 && parts[1] === 254)
            || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            || (parts[0] === 192 && parts[1] === 168)
            || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
            || parts[0] >= 224;
    }
    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase();
        return normalized === '::1'
            || normalized === '::'
            || normalized.startsWith('fc')
            || normalized.startsWith('fd')
            || normalized.startsWith('fe8')
            || normalized.startsWith('fe9')
            || normalized.startsWith('fea')
            || normalized.startsWith('feb')
            || normalized.startsWith('::ffff:127.')
            || normalized.startsWith('::ffff:10.')
            || normalized.startsWith('::ffff:192.168.');
    }
    return true;
}

async function assertSafeRemoteUrl(value) {
    const parsed = parseRemoteUrl(value);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('Local network addresses are not allowed.');
    }
    const addresses = net.isIP(hostname)
        ? [{ address: hostname }]
        : await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
        throw new Error('Private or unresolved network addresses are not allowed.');
    }
    return parsed;
}

async function fetchRemote(url, options = {}, timeoutMs = 15000, ratePolicy = normalizeRatePolicy()) {
    let current = String(url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        await assertSafeRemoteUrl(current);
        await waitForRemoteRequestSlot(current, ratePolicy);
        const response = await fetch(current, {
            ...options,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'User-Agent': 'SillyTavern-FrontendMediaLocalizer/1.0',
                'Accept': 'image/*,audio/*,video/*;q=0.9,*/*;q=0.1',
                ...(options.headers ?? {}),
            },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location) throw new Error('Remote redirect did not include a location.');
            current = new URL(location, current).href;
            continue;
        }
        return { response, finalUrl: current };
    }
    throw new Error('Too many redirects.');
}

function normalizeMime(value) {
    return String(value ?? '').split(';', 1)[0].trim().toLowerCase();
}

function typeFromMime(contentType) {
    const major = normalizeMime(contentType).split('/', 1)[0];
    return SUPPORTED_TYPES.has(major) ? major : null;
}

function isGenericBinaryMime(contentType) {
    const normalized = normalizeMime(contentType);
    return !normalized || normalized === 'application/octet-stream' || normalized === 'binary/octet-stream';
}

function typeFromUrl(value) {
    try {
        const extension = path.extname(new URL(value).pathname).toLowerCase();
        if (/^\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(extension)) return 'image';
        if (/^\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/.test(extension)) return 'audio';
        if (/^\.(mp4|webm|mov|mkv|m4v|avi|ogv)$/.test(extension)) return 'video';
    } catch { /* invalid URL is reported elsewhere */ }
    return null;
}

function extensionFor(url, contentType, type) {
    try {
        const candidate = path.extname(new URL(url).pathname).toLowerCase().replace(/[^.a-z0-9]/g, '');
        if (candidate && candidate.length <= 10) return candidate;
    } catch { /* use MIME fallback */ }
    const fromMime = mime.extension(normalizeMime(contentType));
    if (fromMime) return `.${fromMime}`;
    return type === 'image' ? '.img' : type === 'audio' ? '.audio' : '.video';
}

function makeFilename(url, id, contentType, type) {
    let base = 'resource';
    try {
        base = sanitize(path.basename(new URL(url).pathname, path.extname(new URL(url).pathname)), { replacement: '_' }) || base;
    } catch { /* keep fallback */ }
    base = base.slice(0, 70).replace(/[. ]+$/g, '') || 'resource';
    return `${base}-${id.slice(0, 12)}${extensionFor(url, contentType, type)}`;
}

function getReportedSize(response) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length >= 0) return length;
    const range = response.headers.get('content-range')?.match(/\/(\d+)$/);
    return range ? Number(range[1]) : null;
}

async function probeOne(item, ratePolicy) {
    const url = String(item?.url ?? '');
    const result = { url, id: resourceId(url), type: typeFromUrl(url) ?? item?.hint ?? null, size: null, contentType: null, error: null };
    try {
        parseRemoteUrl(url);
        let request = await fetchRemote(url, { method: 'HEAD' }, PROBE_TIMEOUT_MS, ratePolicy);
        result.contentType = normalizeMime(request.response.headers.get('content-type')) || null;
        result.type = typeFromMime(result.contentType) ?? result.type;
        result.size = getReportedSize(request.response);
        await request.response.body?.cancel();
        if (!request.response.ok || result.size === null || !result.type) {
            request = await fetchRemote(url, { method: 'GET', headers: { Range: 'bytes=0-0' } }, PROBE_TIMEOUT_MS, ratePolicy);
            result.contentType = normalizeMime(request.response.headers.get('content-type')) || result.contentType;
            result.type = typeFromMime(result.contentType) ?? result.type;
            result.size = getReportedSize(request.response) ?? result.size;
            await request.response.body?.cancel();
            if (!request.response.ok && request.response.status !== 206) throw new Error(`HTTP ${request.response.status}`);
        }
        if (result.contentType && !typeFromMime(result.contentType) && !isGenericBinaryMime(result.contentType)) {
            result.error = `Unsupported content type: ${result.contentType}`;
        }
        if (!SUPPORTED_TYPES.has(result.type)) result.error = 'Not an image, audio, or video resource.';
    } catch (error) {
        result.error = error?.name === 'TimeoutError' ? 'Size probe timed out.' : String(error.message ?? error);
    }
    return result;
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }));
    return results;
}

async function downloadOne(card, item, manifest, ratePolicy) {
    const url = String(item?.url ?? '');
    const id = resourceId(url);
    const existing = manifest.resources[id];
    if (existing?.relativePath) {
        const existingPath = path.join(cardDirectory(card), existing.relativePath);
        try {
            const stat = fs.statSync(existingPath);
            if (stat.isFile() && stat.size > 0) return { ...existing, id, size: stat.size, skipped: true };
        } catch { /* missing or invalid files are downloaded again */ }
    }

    const { response, finalUrl } = await fetchRemote(url, { method: 'GET' }, 10 * 60 * 1000, ratePolicy);
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
    }
    const contentType = normalizeMime(response.headers.get('content-type'));
    if (contentType && !typeFromMime(contentType) && !isGenericBinaryMime(contentType)) {
        await response.body.cancel();
        throw new Error(`Unsupported content type: ${contentType}`);
    }
    const type = typeFromMime(contentType) ?? typeFromUrl(finalUrl) ?? typeFromUrl(url) ?? item?.type;
    if (!SUPPORTED_TYPES.has(type)) {
        await response.body.cancel();
        throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
    }
    const reportedSize = getReportedSize(response);
    if (reportedSize !== null && reportedSize > MAX_RESOURCE_BYTES) {
        await response.body.cancel();
        throw new Error('Resource exceeds the 2 GiB per-file limit.');
    }

    const typeDirectory = path.join(cardDirectory(card), type);
    await fs.promises.mkdir(typeDirectory, { recursive: true });
    const filename = makeFilename(finalUrl, id, contentType, type);
    const relativePath = path.posix.join(type, filename);
    const targetPath = path.join(typeDirectory, filename);
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
    let bytes = 0;
    const counter = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_RESOURCE_BYTES) callback(new Error('Resource exceeds the 2 GiB per-file limit.'));
            else callback(null, chunk);
        },
    });
    try {
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
        if (bytes <= 0) throw new Error('Downloaded resource is empty.');
        await fs.promises.rm(targetPath, { force: true });
        await fs.promises.rename(temporaryPath, targetPath);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
    }

    const record = {
        id,
        source: url,
        finalUrl,
        type,
        contentType: contentType || mime.lookup(filename) || 'application/octet-stream',
        size: bytes,
        relativePath,
        filename,
        downloadedAt: new Date().toISOString(),
        status: 'downloaded',
    };
    manifest.resources[id] = record;
    return record;
}

async function importUploadedResource(card, body, file) {
    if (!file?.path || !Number.isFinite(file.size) || file.size <= 0) throw new Error('Uploaded resource is empty.');
    if (file.size > MAX_RESOURCE_BYTES) throw new Error('Resource exceeds the 2 GiB per-file limit.');
    const source = parseRemoteUrl(body?.source).href;
    const type = String(body?.type ?? '');
    if (!SUPPORTED_TYPES.has(type)) throw new Error('Unsupported media type.');
    const requestedName = sanitize(String(body?.filename || file.originalname || '').trim(), { replacement: '_' })
        .replace(/[. ]+$/g, '')
        .slice(0, 180);
    const contentType = normalizeMime(body?.contentType || file.mimetype)
        || normalizeMime(requestedName && mime.lookup(requestedName))
        || 'application/octet-stream';
    if (!typeFromMime(contentType) && !isGenericBinaryMime(contentType)) {
        throw new Error(`Unsupported content type: ${contentType}`);
    }
    const detectedType = typeFromMime(contentType)
        ?? (requestedName ? typeFromUrl(`https://local.invalid/${encodeURIComponent(requestedName)}`) : null)
        ?? typeFromUrl(source);
    if (detectedType && detectedType !== type) throw new Error('Uploaded file type does not match the requested media type.');

    const id = resourceId(source);
    const filename = makeFilename(source, id, contentType, type);
    const relativePath = path.posix.join(type, filename);
    const typeDirectory = path.resolve(cardDirectory(card), type);
    const parent = path.resolve(cardDirectory(card));
    const targetPath = path.resolve(typeDirectory, filename);
    if (!targetPath.startsWith(`${parent}${path.sep}`)) throw new Error('Invalid uploaded resource path.');
    await fs.promises.mkdir(typeDirectory, { recursive: true });
    const stagedPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
    await fs.promises.rename(file.path, stagedPath);
    try {
        const stat = await fs.promises.stat(stagedPath);
        if (!stat.isFile() || stat.size <= 0) throw new Error('Uploaded resource is empty.');
        if (stat.size > MAX_RESOURCE_BYTES) throw new Error('Resource exceeds the 2 GiB per-file limit.');
        await fs.promises.rm(targetPath, { force: true });
        await fs.promises.rename(stagedPath, targetPath);
        const record = {
            id,
            source,
            finalUrl: source,
            type,
            contentType,
            size: stat.size,
            relativePath,
            filename,
            downloadedAt: new Date().toISOString(),
            status: 'downloaded',
            importedBy: 'browser-blob-upload',
        };
        const manifest = await readManifest(card);
        manifest.resources[id] = record;
        await writeManifest(card, manifest);
        return record;
    } catch (error) {
        await fs.promises.rm(stagedPath, { force: true }).catch(() => {});
        throw error;
    }
}

function encodedSource(value) {
    return Buffer.from(value, 'utf8').toString('base64url');
}

function publicRecord(card, record) {
    const source = String(record.source ?? '');
    return {
        ...record,
        localUrl: `/api/plugins/${info.id}/file/${encodeURIComponent(safeCardName(card))}/${record.id}?source=${encodedSource(source)}`,
    };
}

function displayRoot() {
    const relative = path.relative(process.cwd(), resourcesRoot());
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative.replaceAll('\\', '/')
        : '<dataRoot>/resources';
}

async function openDirectory(target) {
    await fs.promises.mkdir(target, { recursive: true });
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/n,/e,', target] : [target];
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

export async function init(router) {
    await fs.promises.mkdir(resourcesRoot(), { recursive: true });
    const uploadDirectory = path.join(resourcesRoot(), '.upload-tmp');
    await fs.promises.mkdir(uploadDirectory, { recursive: true });
    const upload = multer({
        dest: uploadDirectory,
        limits: { fileSize: MAX_RESOURCE_BYTES, files: 1, fields: 8, fieldSize: 16 * 1024 },
    });

    router.get('/status', async (_request, response) => {
        try {
            await fs.promises.access(resourcesRoot(), fs.constants.R_OK | fs.constants.W_OK);
            response.json({ enabled: true, writable: true, version: info.version, root: displayRoot() });
        } catch (error) {
            response.status(500).json({ enabled: true, writable: false, version: info.version, root: displayRoot(), error: error.message });
        }
    });

    router.post('/probe', async (request, response) => {
        const resources = Array.isArray(request.body?.resources) ? request.body.resources.slice(0, 500) : [];
        const ratePolicy = normalizeRatePolicy(request.body?.ratePolicy);
        response.json({ resources: await mapLimit(resources, 1, item => probeOne(item, ratePolicy)) });
    });

    router.post('/download', async (request, response) => {
        const card = safeCardName(request.body?.card);
        const resources = Array.isArray(request.body?.resources) ? request.body.resources.slice(0, 12) : [];
        const ratePolicy = normalizeRatePolicy(request.body?.ratePolicy);
        const manifest = await readManifest(card);
        const results = await mapLimit(resources, 1, async item => {
            try {
                const record = await downloadOne(card, item, manifest, ratePolicy);
                return { ok: true, resource: publicRecord(card, record) };
            } catch (error) {
                return { ok: false, url: String(item?.url ?? ''), error: String(error.message ?? error) };
            }
        });
        await writeManifest(card, manifest);
        response.json({ card, results });
    });

    router.post('/import-blob', (request, response) => {
        upload.single('file')(request, response, async uploadError => {
            if (uploadError) {
                const status = uploadError?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
                return response.status(status).json({ ok: false, error: String(uploadError.message ?? uploadError) });
            }
            const temporaryPath = request.file?.path;
            try {
                const card = safeCardName(request.body?.card);
                const record = await importUploadedResource(card, request.body, request.file);
                response.json({ ok: true, card, resource: publicRecord(card, record) });
            } catch (error) {
                response.status(400).json({ ok: false, error: String(error.message ?? error) });
            } finally {
                if (temporaryPath) await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
            }
        });
    });

    router.post('/register-local', async (request, response) => {
        try {
            const card = safeCardName(request.body?.card);
            const source = parseRemoteUrl(request.body?.source).href;
            const type = String(request.body?.type ?? '');
            if (!SUPPORTED_TYPES.has(type)) throw new Error('Unsupported media type.');
            const filename = sanitize(String(request.body?.filename ?? '').trim(), { replacement: '_' }).replace(/[. ]+$/g, '').slice(0, 180);
            if (!filename || filename === '.' || filename === '..') throw new Error('Invalid filename.');
            const relativePath = path.posix.join(type, filename);
            const parent = path.resolve(cardDirectory(card));
            const target = path.resolve(cardDirectory(card), type, filename);
            if (!target.startsWith(`${parent}${path.sep}`)) throw new Error('Invalid local resource path.');
            const stat = await fs.promises.stat(target);
            if (!stat.isFile() || stat.size <= 0) throw new Error('The selected local resource file does not exist or is empty.');
            if (stat.size > MAX_RESOURCE_BYTES) throw new Error('Resource exceeds the 2 GiB per-file limit.');
            const contentType = normalizeMime(request.body?.contentType) || normalizeMime(mime.lookup(filename)) || 'application/octet-stream';
            const detectedType = typeFromMime(contentType) ?? typeFromUrl(`https://local.invalid/${encodeURIComponent(filename)}`);
            if (detectedType && detectedType !== type) throw new Error('Local file type does not match the requested media type.');
            const id = resourceId(source);
            const manifest = await readManifest(card);
            const record = {
                id,
                source,
                finalUrl: source,
                type,
                contentType,
                size: stat.size,
                relativePath,
                filename,
                downloadedAt: new Date().toISOString(),
                status: 'downloaded',
                importedBy: 'browser-directory-handle',
            };
            manifest.resources[id] = record;
            await writeManifest(card, manifest);
            response.json({ ok: true, card, resource: publicRecord(card, record) });
        } catch (error) {
            const status = error?.code === 'ENOENT' ? 404 : 400;
            response.status(status).json({ ok: false, error: String(error.message ?? error) });
        }
    });

    router.get('/library', async (request, response) => {
        const card = safeCardName(request.query?.card);
        const manifest = await readManifest(card);
        const records = [];
        let repaired = 0;
        for (const record of Object.values(manifest.resources)) {
            const parent = path.resolve(cardDirectory(card));
            const localPath = record.relativePath ? path.resolve(cardDirectory(card), record.relativePath) : null;
            let exists = false;
            if (localPath?.startsWith(`${parent}${path.sep}`)) {
                try {
                    const stat = fs.statSync(localPath);
                    exists = stat.isFile() && stat.size > 0;
                    if (exists && Number(record.size) !== stat.size) record.size = stat.size;
                } catch { exists = false; }
            }
            if (!exists && record.relativePath) {
                record.relativePath = null;
                record.status = 'online';
                record.missingDetectedAt = new Date().toISOString();
                repaired++;
            }
            records.push(publicRecord(card, { ...record, exists, status: exists ? 'downloaded' : 'online' }));
        }
        if (repaired > 0) await writeManifest(card, manifest);
        response.json({ card, root: displayRoot(), repaired, resources: records });
    });

    router.get('/cards', async (_request, response) => {
        const entries = await fs.promises.readdir(resourcesRoot(), { withFileTypes: true });
        const directories = entries
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(entry => entry.name);
        const cards = await mapLimit(directories, 10, async directory => {
            const manifest = await readManifest(directory);
            const counts = { image: 0, audio: 0, video: 0 };
            let size = 0;
            for (const record of Object.values(manifest.resources)) {
                if (!record?.relativePath || !SUPPORTED_TYPES.has(record.type)) continue;
                const target = path.resolve(cardDirectory(directory), record.relativePath);
                const parent = path.resolve(cardDirectory(directory));
                if (!target.startsWith(`${parent}${path.sep}`) || !fs.existsSync(target)) continue;
                counts[record.type]++;
                size += Number(record.size) || 0;
            }
            const count = counts.image + counts.audio + counts.video;
            return { card: safeCardName(manifest.card || directory), count, size, counts };
        });
        response.json({ cards: cards.filter(card => card.count > 0).sort((a, b) => a.card.localeCompare(b.card)) });
    });

    router.post('/delete', async (request, response) => {
        const card = safeCardName(request.body?.card);
        const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter(id => SAFE_ID.test(String(id))) : [];
        const manifest = await readManifest(card);
        let deleted = 0;
        for (const id of ids) {
            const record = manifest.resources[id];
            if (!record?.relativePath) continue;
            const target = path.resolve(cardDirectory(card), record.relativePath);
            if (!target.startsWith(`${path.resolve(cardDirectory(card))}${path.sep}`)) continue;
            await fs.promises.rm(target, { force: true });
            record.relativePath = null;
            record.status = 'online';
            record.deletedAt = new Date().toISOString();
            deleted++;
        }
        await writeManifest(card, manifest);
        response.json({ ok: true, deleted });
    });

    router.post('/delete-card', async (request, response) => {
        const card = safeCardName(request.body?.card);
        const manifest = await readManifest(card);
        for (const type of SUPPORTED_TYPES) {
            await fs.promises.rm(path.join(cardDirectory(card), type), { recursive: true, force: true });
        }
        for (const record of Object.values(manifest.resources)) {
            record.relativePath = null;
            record.status = 'online';
            record.deletedAt = new Date().toISOString();
        }
        await writeManifest(card, manifest);
        response.json({ ok: true });
    });

    router.post('/open', async (request, response) => {
        const hasCard = typeof request.body?.card === 'string' && request.body.card.trim();
        const target = hasCard ? cardDirectory(request.body.card) : resourcesRoot();
        try {
            await openDirectory(target);
            response.json({ ok: true });
        } catch (error) {
            response.status(500).json({ ok: false, error: error.message });
        }
    });

    router.get('/file/:card/:id', async (request, response) => {
        const card = safeCardName(request.params.card);
        const id = String(request.params.id);
        const strictOffline = String(request.query?.offline || '') === '1';
        if (!SAFE_ID.test(id)) return response.sendStatus(400);
        const manifest = await readManifest(card);
        const record = manifest.resources[id];
        if (record?.relativePath) {
            const target = path.resolve(cardDirectory(card), record.relativePath);
            const parent = path.resolve(cardDirectory(card));
            let validFile = false;
            if (target.startsWith(`${parent}${path.sep}`)) {
                try {
                    const stat = fs.statSync(target);
                    validFile = stat.isFile() && stat.size > 0;
                } catch { validFile = false; }
            }
            if (validFile) {
                response.setHeader('X-Content-Type-Options', 'nosniff');
                response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
                if (normalizeMime(record.contentType) === 'image/svg+xml') {
                    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
                }
                return response.sendFile(target);
            }
            record.relativePath = null;
            record.status = 'online';
            record.missingDetectedAt = new Date().toISOString();
            await writeManifest(card, manifest);
        }
        if (strictOffline) {
            response.setHeader('Cache-Control', 'no-store');
            return response.sendStatus(404);
        }
        let source = record?.source;
        if (!source && request.query?.source) {
            try { source = Buffer.from(String(request.query.source), 'base64url').toString('utf8'); } catch { /* invalid fallback */ }
        }
        try {
            source = parseRemoteUrl(source).href;
            response.setHeader('Cache-Control', 'no-store');
            return response.redirect(307, source);
        } catch {
            return response.sendStatus(404);
        }
    });
}
