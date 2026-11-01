/**
 * @file Service worker: media detection, per-tab state, job orchestration.
 *
 * Responsibilities:
 *  1. Watch network responses (webRequest) and record audio/video resources per tab:
 *     direct files (mp3, m4a, mp4, webm...) and HLS playlists (.m3u8).
 *  2. Keep that list in chrome.storage.session (survives SW restarts) and show a badge.
 *  3. Run downloads requested from the popup:
 *     - direct file, original format -> chrome.downloads directly;
 *     - anything that needs fetching/joining/converting -> offscreen document.
 *  4. Inject the page's Referer/Origin into the extension's own requests via a
 *     temporary declarativeNetRequest session rule (many CDNs reject requests without them).
 *
 * Deliberately NOT supported: DRM-protected streams and YouTube.
 *
 * Storage layout (chrome.storage.session):
 *  - `tab_<id>`: {items: Item[], hidden: string[]}  (hidden = playlist URLs that belong
 *     to an already-detected master playlist, so they are not listed twice)
 *  - `jobs`: Record<jobId, Job>
 * chrome.storage.local:
 *  - `settings`: {minSizeKB, bitrate, saveAs}
 */
import { parseM3U8, pickPlaylists } from './lib/m3u8.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File extension -> media kind. */
const MEDIA_EXT = {
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio',
  wav: 'audio', flac: 'audio', weba: 'audio',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video',
  m3u8: 'hls',
};
/** MIME types that identify an HLS playlist. */
const HLS_MIME = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
/** Streaming segment extensions: never listed on their own. */
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'aac_seg']);
/** Out of scope on purpose. */
const BLOCKED_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$/i;
/** MIME -> extension, used when the URL has none. */
const MIME_EXT = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
  'audio/webm': 'weba', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const DEFAULT_SETTINGS = { minSizeKB: 100, bitrate: 192, saveAs: false };
const RESOURCE_TYPES = ['media', 'xmlhttprequest', 'other', 'object'];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Read user settings merged over defaults.
 * @returns {Promise<{minSizeKB:number,bitrate:number,saveAs:boolean}>}
 */
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------------------------------------------------------------------------
// Per-tab state
// ---------------------------------------------------------------------------

/** tabId -> Promise<TabState>. In-memory cache so concurrent handlers share one object. */
const tabCache = new Map();
/** tabId -> Set of URLs currently being probed (HLS fetch in flight). Memory only. */
const pending = new Map();
/** tabId -> debounce timer for persisting. */
const saveTimers = new Map();

/**
 * Load (once) the state of a tab.
 * @param {number} tabId
 * @returns {Promise<{items:Object[], hidden:string[]}>}
 */
function loadTab(tabId) {
  if (!tabCache.has(tabId)) {
    const key = `tab_${tabId}`;
    tabCache.set(tabId, chrome.storage.session.get(key)
      .then((r) => r[key] || { items: [], hidden: [] }));
  }
  return tabCache.get(tabId);
}

/**
 * Persist a tab's state (debounced 150 ms) and refresh its badge.
 * @param {number} tabId
 */
function saveTab(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(async () => {
    saveTimers.delete(tabId);
    const state = await loadTab(tabId);
    await chrome.storage.session.set({ [`tab_${tabId}`]: state });
    const n = state.items.length;
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  }, 150));
}

/**
 * Forget everything detected in a tab (navigation, close, or "clear" button).
 * @param {number} tabId
 */
async function clearTab(tabId) {
  tabCache.set(tabId, Promise.resolve({ items: [], hidden: [] }));
  pending.delete(tabId);
  await chrome.storage.session.remove(`tab_${tabId}`);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** requestId -> {referer, origin} captured from the page's request headers. */
const reqHeaders = new Map();

/**
 * Get a header value (case-insensitive).
 * @param {chrome.webRequest.HttpHeader[]|undefined} headers
 * @param {string} name Lower-case header name.
 * @returns {string|null}
 */
function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

/**
 * Lower-case extension of the URL path's last segment ('' if none).
 * @param {URL} u
 * @returns {string}
 */
function urlExt(u) {
  const last = u.pathname.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classify a response as HLS, direct media, or ignore.
 * @param {URL} u Request URL.
 * @param {string} mime Lower-case Content-Type without parameters.
 * @returns {{kind:'hls'}|{kind:'direct', mediaType:'audio'|'video', ext:string}|null}
 */
function classify(u, mime) {
  const ext = urlExt(u);
  if (HLS_MIME.includes(mime) || ext === 'm3u8') return { kind: 'hls' };
  if (SEGMENT_EXT.has(ext) || mime === 'video/mp2t' || mime === 'video/iso.segment') return null;
  const isAv = mime.startsWith('audio/') || mime.startsWith('video/');
  const extType = MEDIA_EXT[ext];
  if (!isAv && !extType) return null;
  // Fragmented-stream chunks (DASH etc.) that slip through with mp4 MIME types.
  if (/(seg|chunk|frag|init)[-_]?\d+/i.test(u.pathname) && !extType) return null;
  const mediaType = extType && extType !== 'hls' ? extType : (mime.startsWith('audio/') ? 'audio' : 'video');
  return { kind: 'direct', mediaType, ext: (extType ? ext : MIME_EXT[mime]) || (mediaType === 'audio' ? 'm4a' : 'mp4') };
}

/**
 * Human-readable name from Content-Disposition or the URL path.
 * @param {URL} u
 * @param {string|null} disposition Content-Disposition header.
 * @returns {string}
 */
function displayName(u, disposition) {
  const m = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  const last = u.pathname.split('/').pop() || u.hostname;
  try { return decodeURIComponent(last); } catch { return last; }
}

// Capture Referer/Origin the page sent, to replay them when downloading.
chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;
  const referer = header(d.requestHeaders, 'referer');
  const origin = header(d.requestHeaders, 'origin');
  if (referer || origin) reqHeaders.set(d.requestId, { referer, origin });
}, { urls: ['<all_urls>'], types: RESOURCE_TYPES }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const sent = reqHeaders.get(d.requestId);
  reqHeaders.delete(d.requestId);
  if (d.tabId < 0 || (d.statusCode !== 200 && d.statusCode !== 206)) return;
  if (d.initiator?.startsWith('chrome-extension://')) return;

  let u;
  try { u = new URL(d.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol) || BLOCKED_HOST.test(u.hostname)) return;
  if (d.initiator) {
    try { if (BLOCKED_HOST.test(new URL(d.initiator).hostname)) return; } catch { /* opaque */ }
  }

  const mime = (header(d.responseHeaders, 'content-type') || '').split(';')[0].trim().toLowerCase();
  const kind = classify(u, mime);
  if (!kind) return;

  // Total size: Content-Range "bytes a-b/total" (206) or Content-Length (200).
  const range = header(d.responseHeaders, 'content-range');
  const total = range ? Number(range.split('/')[1]) : Number(header(d.responseHeaders, 'content-length'));
  const size = Number.isFinite(total) && total > 0 ? total : null;

  handleMedia(d.tabId, {
    url: d.url,
    mime,
    size,
    name: displayName(u, header(d.responseHeaders, 'content-disposition')),
    referer: sent?.referer || d.initiator || null,
    origin: sent?.origin || null,
    ...kind,
  }).catch((e) => console.warn('handleMedia', e));
}, { urls: ['<all_urls>'], types: RESOURCE_TYPES }, ['responseHeaders']);

chrome.webRequest.onErrorOccurred.addListener((d) => reqHeaders.delete(d.requestId),
  { urls: ['<all_urls>'], types: RESOURCE_TYPES });

// New top-level page in a tab -> its old media list no longer applies.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId >= 0) clearTab(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  tabCache.delete(tabId);
});

/**
 * Record a detected resource in the tab state (deduplicated).
 * HLS playlists are fetched and parsed here to know qualities, duration and DRM.
 * @param {number} tabId
 * @param {Object} info Fields gathered in onHeadersReceived plus classify() result.
 */
async function handleMedia(tabId, info) {
  const state = await loadTab(tabId);
  const busy = pending.get(tabId) || new Set();
  pending.set(tabId, busy);
  if (busy.has(info.url) || state.hidden.includes(info.url) || state.items.some((i) => i.url === info.url)) return;

  const item = {
    id: crypto.randomUUID().slice(0, 8),
    url: info.url,
    name: info.name,
    referer: info.referer,
    origin: info.origin,
    detectedAt: Date.now(),
  };

  if (info.kind === 'direct') {
    const { minSizeKB } = await getSettings();
    if (info.size !== null && info.size < minSizeKB * 1024) return;
    Object.assign(item, { kind: 'direct', mediaType: info.mediaType, ext: info.ext, mime: info.mime, size: info.size });
  } else {
    busy.add(info.url);
    try {
      const pl = await withHeaderRule({ referer: info.referer, origin: info.origin }, async () => {
        const res = await fetch(info.url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseM3U8(await res.text(), res.url || info.url);
      });
      if (pl.type === 'master') {
        if (!pl.variants.length) return;
        const children = [...pl.variants.map((v) => v.url), ...pl.audios.filter((a) => a.url).map((a) => a.url)];
        state.hidden.push(...children);
        // A variant playlist may have been listed before its master arrived: drop it.
        state.items = state.items.filter((i) => !children.includes(i.url));
        Object.assign(item, {
          kind: 'hls', mediaType: 'video', drm: pl.drm,
          master: { variants: pl.variants, audios: pl.audios },
          hasAudioRendition: pl.audios.some((a) => a.url),
        });
        // A master with only audio codecs is an audio stream.
        if (pl.variants.every((v) => v.codecs && !/avc|hvc|hev|vp0?9|av01/i.test(v.codecs))) item.mediaType = 'audio';
      } else {
        if (!pl.segments.length) return;
        Object.assign(item, {
          kind: 'hls', mediaType: 'video', drm: pl.drm, duration: pl.duration, live: pl.live,
        });
      }
    } catch (e) {
      console.warn('No se pudo leer la playlist', info.url, e);
      return;
    } finally {
      busy.delete(info.url);
    }
    // Re-check: the master may have hidden this URL while we were fetching.
    if (state.hidden.includes(info.url) || state.items.some((i) => i.url === info.url)) return;
  }

  state.items.push(item);
  saveTab(tabId);
}

// ---------------------------------------------------------------------------
// Referer / Origin injection (declarativeNetRequest session rules)
// ---------------------------------------------------------------------------

/**
 * Add a session rule that sets Referer/Origin on non-tab requests (tabId -1: requests
 * from this extension's service worker, offscreen document and chrome.downloads).
 * Scoped by time: callers must remove it when their job ends.
 * Side effect to be aware of: while active, it also applies to other non-tab requests
 * to the same domains (or all domains when `domains` is omitted).
 * @param {{referer:string|null, origin:string|null}} h Headers to set.
 * @param {string[]} [domains] Restrict to these request hosts; omit for any host (HLS
 *   segments often come from different CDN hosts than the playlist).
 * @returns {Promise<number|null>} Rule id, or null when there was nothing to set.
 */
async function addHeaderRule(h, domains) {
  const requestHeaders = [];
  if (h.referer) requestHeaders.push({ header: 'referer', operation: 'set', value: h.referer });
  if (h.origin) requestHeaders.push({ header: 'origin', operation: 'set', value: h.origin });
  if (!requestHeaders.length) return null;
  const id = 1 + Math.floor(Math.random() * 2 ** 30);
  const condition = { tabIds: [chrome.tabs.TAB_ID_NONE] };
  if (domains?.length) condition.requestDomains = domains;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders }, condition }],
  });
  return id;
}

/**
 * Remove a rule created by addHeaderRule (no-op for null).
 * @param {number|null} id
 */
async function removeHeaderRule(id) {
  if (id) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

/**
 * Run `fn` with a temporary Referer/Origin rule active.
 * @template T
 * @param {{referer:string|null, origin:string|null}} h
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withHeaderRule(h, fn) {
  const id = await addHeaderRule(h);
  try { return await fn(); } finally { await removeHeaderRule(id); }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** @type {Promise<Record<string,Object>>|null} */
let jobsPromise = null;
let jobsTimer = null;

/**
 * Load jobs (once per SW lifetime), dropping finished ones older than a minute.
 * @returns {Promise<Record<string,Object>>}
 */
function loadJobs() {
  if (!jobsPromise) {
    jobsPromise = chrome.storage.session.get('jobs').then(({ jobs = {} }) => {
      const now = Date.now();
      for (const [id, j] of Object.entries(jobs)) {
        if (j.finishedAt && now - j.finishedAt > 60_000) delete jobs[id];
      }
      return jobs;
    });
  }
  return jobsPromise;
}

/** Persist jobs (debounced) so the popup sees progress via storage.onChanged. */
function saveJobs() {
  clearTimeout(jobsTimer);
  jobsTimer = setTimeout(async () => chrome.storage.session.set({ jobs: await loadJobs() }), 100);
}

/**
 * Merge fields into a job and persist. Finished jobs are removed 20 s later.
 * @param {string} jobId
 * @param {Object} patch
 * @returns {Promise<Object|undefined>} The updated job.
 */
async function patchJob(jobId, patch) {
  const jobs = await loadJobs();
  if (!jobs[jobId]) return undefined;
  Object.assign(jobs[jobId], patch);
  if (patch.phase === 'listo' || patch.phase === 'error') {
    jobs[jobId].finishedAt = Date.now();
    setTimeout(async () => { delete (await loadJobs())[jobId]; saveJobs(); }, 20_000);
  }
  saveJobs();
  return jobs[jobId];
}

/**
 * Make a string safe as a file name (Windows rules), max 120 chars.
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
  return (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 120) || 'descarga';
}

let creatingOffscreen = null;

/** Create the offscreen document if it does not exist yet. */
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS', 'WORKERS'],
    justification: 'Descargar segmentos HLS y convertir audio con ffmpeg.wasm',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

/**
 * Deliver a message to the offscreen document, retrying until its listener is up.
 * @param {Object} msg Message without `target`.
 * @throws {Error} If the document never answers (~3 s).
 */
async function toOffscreen(msg) {
  for (let i = 0; i < 30; i++) {
    try {
      if (await chrome.runtime.sendMessage({ target: 'offscreen', ...msg })) return;
    } catch { /* receiver not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('El documento offscreen no responde');
}

/** Close the offscreen document (frees ~100 MB of ffmpeg) when no job needs it. */
async function maybeCloseOffscreen() {
  const jobs = await loadJobs();
  const busy = Object.values(jobs).some((j) => j.viaOffscreen && !j.finishedAt);
  if (!busy) await chrome.offscreen.closeDocument().catch(() => {});
}

/**
 * Start a download requested by the popup.
 *
 * Modes:
 *  - 'original': file as-is (direct) or joined HLS remuxed to mp4/m4a.
 *  - 'audio':    audio track only, without re-encoding when possible (.m4a).
 *  - 'mp3':      audio encoded to MP3 at `bitrate` kbps.
 *
 * @param {{tabId:number, itemId:string, mode:'original'|'audio'|'mp3', variantIndex?:number, bitrate?:number}} req
 *   bitrate overrides the default from settings for this download only.
 * @returns {Promise<string>} jobId.
 * @throws {Error} Unknown item, DRM, or offscreen failure.
 */
async function startDownload({ tabId, itemId, mode, variantIndex = 0, bitrate }) {
  const state = await loadTab(tabId);
  const item = state.items.find((i) => i.id === itemId);
  if (!item) throw new Error('Elemento no encontrado');
  if (item.drm) throw new Error('Contenido protegido con DRM');

  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const base = sanitize(tab?.title || item.name.replace(/\.[^.]+$/, ''));
  const jobId = crypto.randomUUID();
  const headersToSet = { referer: item.referer, origin: item.origin };
  const jobs = await loadJobs();

  // Cases where the source file already is what was asked for: let Chrome download it directly.
  const native = item.kind === 'direct' && (
    mode === 'original'
    || (mode === 'mp3' && item.ext === 'mp3')
    || (mode === 'audio' && item.mediaType === 'audio'));
  jobs[jobId] = {
    tabId, itemId, mode, bitrate: Number(bitrate) || settings.bitrate, base, saveAs: settings.saveAs, viaOffscreen: !native,
    phase: native ? 'guardando' : 'en cola', progress: 0, startedAt: Date.now(),
  };
  saveJobs();

  if (native) {
    const ruleId = await addHeaderRule(headersToSet, [new URL(item.url).hostname]);
    try {
      const downloadId = await chrome.downloads.download({
        url: item.url, filename: `${base}.${item.ext}`, saveAs: settings.saveAs, conflictAction: 'uniquify',
      });
      await patchJob(jobId, { downloadId, ruleId });
    } catch (e) {
      await removeHeaderRule(ruleId);
      await patchJob(jobId, { phase: 'error', error: e.message });
    }
    return jobId;
  }

  const ruleId = await addHeaderRule(headersToSet);
  await patchJob(jobId, { ruleId });
  const job = { jobId, kind: item.kind, mode, bitrate: Number(bitrate) || settings.bitrate };
  if (item.kind === 'direct') {
    Object.assign(job, { url: item.url, srcExt: item.ext });
  } else {
    job.hls = item.master
      ? pickPlaylists(item.master, mode !== 'original', variantIndex)
      : { mainUrl: item.url, audioUrl: null, audioOnly: item.mediaType === 'audio' };
  }
  try {
    await ensureOffscreen();
    await toOffscreen({ cmd: 'job', job });
  } catch (e) {
    await removeHeaderRule(ruleId);
    await patchJob(jobId, { phase: 'error', error: e.message });
  }
  return jobId;
}

/**
 * Cancel a running job (native download or offscreen work).
 * @param {string} jobId
 */
async function cancelJob(jobId) {
  const job = (await loadJobs())[jobId];
  if (!job || job.finishedAt) return;
  if (job.downloadId !== undefined) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
  } else {
    await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'cancel', jobId }).catch(() => {});
  }
}

/**
 * Handle messages from the offscreen document.
 * @param {Object} msg {cmd:'progress'|'done'|'error', jobId, ...}
 */
async function onOffscreenMessage(msg) {
  const jobs = await loadJobs();
  const job = jobs[msg.jobId];
  if (!job) {
    if (msg.cmd === 'done') toOffscreen({ cmd: 'revoke', blobUrl: msg.blobUrl }).catch(() => {});
    return;
  }
  if (msg.cmd === 'progress') {
    await patchJob(msg.jobId, { phase: msg.phase, progress: msg.progress });
  } else if (msg.cmd === 'error') {
    await removeHeaderRule(job.ruleId);
    await patchJob(msg.jobId, { phase: 'error', error: msg.error });
    maybeCloseOffscreen();
  } else if (msg.cmd === 'done') {
    await removeHeaderRule(job.ruleId);
    try {
      const downloadId = await chrome.downloads.download({
        url: msg.blobUrl, filename: `${job.base}.${msg.ext}`, saveAs: job.saveAs, conflictAction: 'uniquify',
      });
      await patchJob(msg.jobId, { phase: 'guardando', progress: 1, downloadId, blobUrl: msg.blobUrl, ruleId: null });
    } catch (e) {
      // e.g. the user closed the "Save as" dialog.
      toOffscreen({ cmd: 'revoke', blobUrl: msg.blobUrl }).catch(() => {});
      await patchJob(msg.jobId, { phase: 'error', error: e.message });
      maybeCloseOffscreen();
    }
  }
}

// Download finished/failed -> close the job, free the Blob URL and the header rule.
chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const jobs = await loadJobs();
  const entry = Object.entries(jobs).find(([, j]) => j.downloadId === delta.id && !j.finishedAt);
  if (!entry) return;
  const [jobId, job] = entry;
  await removeHeaderRule(job.ruleId);
  if (job.blobUrl) toOffscreen({ cmd: 'revoke', blobUrl: job.blobUrl }).catch(() => {});
  if (state === 'complete') {
    await patchJob(jobId, { phase: 'listo', progress: 1 });
  } else {
    const err = delta.error?.current;
    await patchJob(jobId, { phase: 'error', error: err === 'USER_CANCELED' ? 'Cancelado' : `Descarga interrumpida (${err || '?'})` });
  }
  if (job.viaOffscreen) maybeCloseOffscreen();
});

// ---------------------------------------------------------------------------
// Messaging (popup + offscreen)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'bg') return undefined;
  const reply = (p) => {
    p.then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the channel open for the async reply
  };
  switch (msg.cmd) {
    case 'download': return reply(startDownload(msg));
    case 'cancel': return reply(cancelJob(msg.jobId));
    case 'clear': return reply(clearTab(msg.tabId));
    case 'progress':
    case 'done':
    case 'error':
      onOffscreenMessage(msg);
      return undefined;
    default: return undefined;
  }
});

// Stale header rules from a previous SW/browser session.
chrome.runtime.onStartup.addListener(async () => {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (rules.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
});
