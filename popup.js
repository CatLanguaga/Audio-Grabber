/**
 * @file Popup UI: one card per media detected in the active tab, each with its own
 * format picker (MP3 / original audio / video), MP3 bitrate or video quality, and a
 * download button; plus "download everything as MP3".
 *
 * State sources:
 *  - chrome.storage.session `tab_<id>` and `jobs` (written by background.js);
 *    re-rendered on storage.onChanged so progress updates live.
 *  - chrome.storage.local `settings` (defaults) and `prefs` (last format the user
 *    picked per media type, so the menu opens "the way I like it").
 *
 * Rendering is keyed by item id: cards are created once (keeping the user's
 * selections and focus) and only their job/progress area is refreshed afterwards.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const DEFAULT_SETTINGS = { minSizeKB: 100, bitrate: 192, saveAs: false };
const BITRATES = [128, 192, 256, 320];

/** Format key -> background download mode. */
const MODE = { mp3: 'mp3', audio: 'audio', video: 'original' };

const ICONS = {
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/></svg>',
  drm: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};

/** Phase -> text for the user. */
const PHASE_TEXT = {
  'en cola': 'En cola…', descargando: 'Descargando', convirtiendo: 'Convirtiendo',
  guardando: 'Guardando…', listo: '¡Listo!', error: 'Error',
};

/** Active tab id. */
let tabId = -1;
/** Defaults from settings. */
let settings = { ...DEFAULT_SETTINGS };
/** Last format chosen per media type: {audio:'mp3'|'audio', video:'mp3'|'audio'|'video'}. */
let prefs = { audio: 'mp3', video: 'mp3' };
/** itemId -> {format, bitrate, variant} current choices for each card. */
const choice = new Map();
/** itemId -> card element. */
const cards = new Map();
/** Latest items, for "download all". */
let currentItems = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a command to the service worker.
 * @param {string} cmd
 * @param {Object} [data]
 * @returns {Promise<any>}
 * @throws {Error} When the background reports an error.
 */
async function bg(cmd, data = {}) {
  const res = await chrome.runtime.sendMessage({ target: 'bg', cmd, ...data });
  if (!res?.ok) throw new Error(res?.error || 'Sin respuesta del service worker');
  return res.data;
}

/** @param {number|null} n Bytes. @returns {string} */
function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

/** @param {number|undefined} s Seconds. @returns {string} h:mm:ss or m:ss. */
function fmtDuration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
}

/** @param {{resolution:string|null,bandwidth:number}} v @returns {string} e.g. "720p · 2.5 Mbps". */
function variantLabel(v) {
  const res = v.resolution ? `${v.resolution.split('x')[1]}p` : 'Calidad';
  return v.bandwidth ? `${res} · ${(v.bandwidth / 1e6).toFixed(1)} Mbps` : res;
}

/**
 * Create an element with class and optional text.
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Show a message at the bottom for a few seconds.
 * @param {Error|string} e
 */
function toast(e) {
  const t = $('#toast');
  t.textContent = typeof e === 'string' ? e : e.message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4500);
}

// ---------------------------------------------------------------------------
// Formats per item
// ---------------------------------------------------------------------------

/**
 * Formats available for an item.
 * - Audio: MP3, plus the original audio unless the source already is MP3.
 * - Video: MP3, audio only (M4A, no re-encoding), full video.
 * @param {Object} item
 * @returns {{key:'mp3'|'audio'|'video', label:string, sub:string}[]}
 */
function formatsFor(item) {
  const isMp3File = item.kind === 'direct' && item.ext === 'mp3';
  if (item.mediaType === 'audio') {
    const list = [{ key: 'mp3', label: 'MP3', sub: isMp3File ? 'original' : 'convertir' }];
    if (!isMp3File) {
      list.push({ key: 'audio', label: item.kind === 'direct' ? item.ext.toUpperCase() : 'M4A', sub: 'original' });
    }
    return list;
  }
  return [
    { key: 'mp3', label: 'MP3', sub: 'solo audio' },
    { key: 'audio', label: 'M4A', sub: 'audio original' },
    { key: 'video', label: 'Video', sub: item.kind === 'direct' ? item.ext.toUpperCase() : 'MP4' },
  ];
}

/**
 * Current choice for an item, initialised from the remembered preferences.
 * @param {Object} item
 * @returns {{format:string, bitrate:number, variant:number}}
 */
function getChoice(item) {
  if (!choice.has(item.id)) {
    const keys = formatsFor(item).map((f) => f.key);
    const pref = prefs[item.mediaType === 'audio' ? 'audio' : 'video'];
    choice.set(item.id, {
      format: keys.includes(pref) ? pref : keys[0],
      bitrate: settings.bitrate,
      variant: 0,
    });
  }
  return choice.get(item.id);
}

/**
 * Text of the main button for the current choice.
 * @param {Object} item
 * @param {{format:string,bitrate:number,variant:number}} c
 * @returns {string}
 */
function goLabel(item, c) {
  if (c.format === 'mp3') {
    return item.kind === 'direct' && item.ext === 'mp3' ? 'Descargar MP3' : `Descargar MP3 · ${c.bitrate} kbps`;
  }
  if (c.format === 'audio') return 'Descargar audio original';
  const v = item.master?.variants[c.variant];
  return v?.resolution ? `Descargar video · ${v.resolution.split('x')[1]}p` : 'Descargar video';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * Rebuild the format-dependent parts of a card (picker state, options row, button label).
 * @param {HTMLElement} card
 * @param {Object} item
 */
function refreshControls(card, item) {
  const c = getChoice(item);
  for (const b of card.querySelectorAll('.fmt')) b.setAttribute('aria-checked', String(b.dataset.key === c.format));

  const opts = $('.options', card);
  opts.replaceChildren();
  if (c.format === 'mp3') {
    if (item.kind === 'direct' && item.ext === 'mp3') {
      opts.append(el('span', 'hint', 'Ya es MP3: se guarda tal cual, sin recodificar.'));
    } else {
      opts.append(el('span', 'opt-label', 'Calidad'));
      for (const r of BITRATES) {
        const b = el('button', 'rate', `${r}`);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(r === c.bitrate));
        b.title = `${r} kbps`;
        b.onclick = () => { c.bitrate = r; refreshControls(card, item); };
        opts.append(b);
      }
      opts.append(el('span', 'hint', 'kbps'));
    }
  } else if (c.format === 'audio') {
    opts.append(el('span', 'hint', 'Sin recodificar: misma calidad que la fuente.'));
  } else if (item.master?.variants.length > 1) {
    const sel = el('select', 'quality');
    item.master.variants.forEach((v, i) => sel.add(new Option(variantLabel(v), String(i))));
    sel.value = String(c.variant);
    sel.onchange = () => { c.variant = Number(sel.value); refreshControls(card, item); };
    opts.append(sel);
  }
  $('.go-label', card).textContent = goLabel(item, c);
}

/**
 * Start the download for an item with its current choice, and remember the format.
 * @param {Object} item
 * @returns {Promise<void>}
 */
async function download(item) {
  const c = getChoice(item);
  const type = item.mediaType === 'audio' ? 'audio' : 'video';
  if (prefs[type] !== c.format) {
    prefs = { ...prefs, [type]: c.format };
    chrome.storage.local.set({ prefs });
  }
  await bg('download', { tabId, itemId: item.id, mode: MODE[c.format], variantIndex: c.variant, bitrate: c.bitrate });
}

/**
 * Friendly title for a card. HLS playlists are usually named "master.m3u8",
 * "index.m3u8"…, which says nothing, so they get "Stream de audio/video · host".
 * @param {Object} item
 * @returns {string}
 */
function displayName(item) {
  if (item.kind !== 'hls') return item.name;
  let host = '';
  try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  return `Stream de ${item.mediaType === 'audio' ? 'audio' : 'video'}${host ? ` · ${host}` : ''}`;
}

/**
 * Create the card for an item (once).
 * @param {Object} item
 * @returns {HTMLElement}
 */
function createCard(item) {
  const card = $('#tpl-card').content.firstElementChild.cloneNode(true);
  const type = item.drm ? 'drm' : item.mediaType;
  card.classList.toggle('drm', Boolean(item.drm));

  const kind = $('.kind', card);
  kind.classList.add(type);
  kind.innerHTML = ICONS[type];

  const name = $('.name', card);
  name.textContent = displayName(item);
  name.title = item.url;

  const chips = [];
  if (item.kind === 'hls') chips.push('HLS');
  if (item.kind === 'direct') chips.push(item.ext.toUpperCase(), fmtSize(item.size));
  if (item.master) chips.push(`${item.master.variants.length} calidad${item.master.variants.length > 1 ? 'es' : ''}`);
  if (item.duration) chips.push(fmtDuration(item.duration));
  if (item.live) chips.push('EN VIVO');
  const chipBox = $('.chips', card);
  for (const t of chips.filter(Boolean)) chipBox.append(el('span', 'chip', t));
  if (item.drm) chipBox.append(el('span', 'chip warn', 'Protegido con DRM'));

  const picker = $('.formats', card);
  if (item.drm) {
    picker.remove();
    $('.options', card).append(el('span', 'hint', 'Este contenido está protegido y no se puede descargar.'));
    const go = $('.btn-go', card);
    go.disabled = true;
    $('.go-label', go).textContent = 'No disponible';
    return card;
  }
  const formats = formatsFor(item);
  for (const f of formats) {
    const b = el('button', 'fmt');
    b.dataset.key = f.key;
    b.setAttribute('role', 'radio');
    b.append(el('b', '', f.label), el('small', '', f.sub));
    b.onclick = () => { getChoice(item).format = f.key; refreshControls(card, item); };
    picker.append(b);
  }
  if (formats.length === 1) picker.hidden = true;

  $('.btn-go', card).onclick = () => download(item).catch(toast);
  refreshControls(card, item);
  return card;
}

/**
 * Build the DOM for one job row.
 * @param {string} jobId
 * @param {Object} job
 * @returns {HTMLElement}
 */
function jobRow(jobId, job) {
  const row = el('div', `job${job.phase === 'error' ? ' error' : ''}${job.phase === 'listo' ? ' done' : ''}`);
  const what = job.mode === 'mp3' ? `MP3 ${job.bitrate || ''}`.trim() : job.mode === 'audio' ? 'Audio' : 'Original';
  const pct = job.progress > 0 && job.progress < 1 ? ` ${Math.round(job.progress * 100)}%` : '';
  row.append(el('span', 'status', `${what} · ${PHASE_TEXT[job.phase] || job.phase}${pct}${job.error ? ` — ${job.error}` : ''}`));
  if (!job.finishedAt) {
    const cancel = el('button', 'cancel', 'Cancelar');
    cancel.onclick = () => bg('cancel', { jobId }).catch(toast);
    row.append(cancel);
    const indeterminate = job.phase === 'en cola' || job.phase === 'guardando' || !job.progress;
    const bar = el('div', `bar${indeterminate ? ' indeterminate' : ''}`);
    const fill = el('i');
    if (!indeterminate) fill.style.width = `${Math.round(job.progress * 100)}%`;
    bar.append(fill);
    row.append(bar);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Sync cards and jobs with storage. */
async function render() {
  const key = `tab_${tabId}`;
  const data = await chrome.storage.session.get([key, 'jobs']);
  const items = (data[key]?.items || []).slice().reverse(); // newest first
  currentItems = items;
  const jobs = Object.entries(data.jobs || {}).filter(([, j]) => j.tabId === tabId);

  const list = $('#list');
  const ids = new Set(items.map((i) => i.id));
  for (const [id, card] of cards) if (!ids.has(id)) { card.remove(); cards.delete(id); choice.delete(id); }
  items.forEach((item, idx) => {
    let card = cards.get(item.id);
    if (!card) { card = createCard(item); cards.set(item.id, card); }
    if (list.children[idx] !== card) list.insertBefore(card, list.children[idx] || null);

    const mine = jobs.filter(([, j]) => j.itemId === item.id);
    $('.jobs', card).replaceChildren(...mine.map(([id, j]) => jobRow(id, j)));
    const busy = mine.some(([, j]) => !j.finishedAt);
    if (!item.drm) $('.btn-go', card).disabled = busy;
  });

  $('#empty').hidden = items.length > 0;
  const downloadable = items.filter((i) => !i.drm);
  $('#footer').hidden = downloadable.length < 2;
  $('#btn-all-label').textContent = `Descargar todo en MP3 (${downloadable.length})`;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* chrome:// etc. */ }
  const n = items.length;
  $('#subtitle').textContent = n
    ? `${n} medio${n > 1 ? 's' : ''} detectado${n > 1 ? 's' : ''}${host ? ` en ${host}` : ''}`
    : (host ? `Escuchando ${host}…` : 'Abre una página con audio o video');
}

// ---------------------------------------------------------------------------
// Settings & startup
// ---------------------------------------------------------------------------

/** Load settings/prefs and wire the settings panel. */
async function initSettings() {
  const stored = await chrome.storage.local.get(['settings', 'prefs']);
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  prefs = { ...prefs, ...(stored.prefs || {}) };
  $('#set-bitrate').value = String(settings.bitrate);
  $('#set-minsize').value = String(settings.minSizeKB);
  $('#set-saveas').checked = settings.saveAs;
  const save = () => {
    settings = {
      bitrate: Number($('#set-bitrate').value),
      minSizeKB: Number($('#set-minsize').value),
      saveAs: $('#set-saveas').checked,
    };
    chrome.storage.local.set({ settings });
  };
  for (const id of ['#set-bitrate', '#set-minsize', '#set-saveas']) $(id).onchange = save;
  $('#btn-settings').onclick = () => {
    const panel = $('#settings');
    panel.hidden = !panel.hidden;
    $('#btn-settings').setAttribute('aria-expanded', String(!panel.hidden));
  };
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? -1;
  await initSettings();

  $('#btn-clear').onclick = () => bg('clear', { tabId }).then(render).catch(toast);
  $('#btn-all').onclick = async () => {
    const targets = currentItems.filter((i) => !i.drm);
    for (const item of targets) {
      const c = getChoice(item);
      try {
        await bg('download', { tabId, itemId: item.id, mode: 'mp3', variantIndex: c.variant, bitrate: c.bitrate });
      } catch (e) { toast(e); }
    }
  };

  await render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && (changes.jobs || changes[`tab_${tabId}`])) render();
  });
})();
