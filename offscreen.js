/**
 * @file Offscreen document: does the heavy lifting the service worker cannot
 * (long-running fetches, WASM workers, Blob URLs).
 *
 * Protocol (chrome.runtime messages, filtered by `target`):
 *  - in  {target:'offscreen', cmd:'ping'}               -> reply true (readiness check)
 *  - in  {target:'offscreen', cmd:'job', job}           -> starts a job, replies true
 *  - in  {target:'offscreen', cmd:'cancel', jobId}
 *  - in  {target:'offscreen', cmd:'revoke', blobUrl}    -> frees a finished Blob URL
 *  - out {target:'bg', cmd:'progress', jobId, phase, progress}
 *  - out {target:'bg', cmd:'done', jobId, blobUrl, ext}
 *  - out {target:'bg', cmd:'error', jobId, error}
 *
 * Job shape (built by background.js):
 *  { jobId, kind:'direct'|'hls', mode:'original'|'audio'|'mp3', bitrate:number,
 *    url?:string, srcExt?:string,                              // direct
 *    hls?:{mainUrl:string, audioUrl:string|null, audioOnly:boolean} } // hls
 */
import { downloadMediaPlaylist } from './lib/hls-download.js';
import { runFFmpeg, abortFFmpeg } from './lib/transcode.js';

/** jobId -> AbortController of running jobs. */
const running = new Map();
/** jobId -> last reported phase ('descargando' | 'convirtiendo'). */
const phases = new Map();

/**
 * Send a message to the service worker, ignoring "no receiver" errors
 * (the SW may be restarting; it re-reads state from storage).
 * @param {Object} msg
 */
function toBg(msg) {
  chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

/**
 * Build a throttled progress reporter (max ~4 messages/s per job).
 * @param {string} jobId
 * @returns {(phase:string, progress:number)=>void}
 */
function reporter(jobId) {
  let last = 0;
  return (phase, progress) => {
    phases.set(jobId, phase);
    const now = Date.now();
    if (now - last < 250 && progress < 1) return;
    last = now;
    toBg({ cmd: 'progress', jobId, phase, progress });
  };
}

/** ffmpeg arguments that encode the (first) audio stream to MP3. */
const mp3Args = (input, bitrate) =>
  ['-i', input, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-y', 'out.mp3'];

/**
 * Extract the audio track into .m4a. First tries a stream copy (no quality loss,
 * fast); if the codec cannot go into MP4 (e.g. Vorbis) it re-encodes to AAC 192k.
 * A copy of the input is kept for the fallback because runFFmpeg transfers buffers.
 * @param {string} name Input file name (extension helps ffmpeg probe).
 * @param {Uint8Array} data Input bytes.
 * @param {(p:number)=>void} conv Progress callback.
 * @returns {Promise<{bytes:Uint8Array, ext:string}>}
 */
async function extractAudio(name, data, conv) {
  const backup = data.slice();
  try {
    const bytes = await runFFmpeg([{ name, data }],
      ['-i', name, '-vn', '-map', '0:a:0', '-c:a', 'copy', '-y', 'out.m4a'], 'out.m4a', conv);
    return { bytes, ext: 'm4a' };
  } catch (e) {
    console.warn('Copia de audio falló, recodificando a AAC', e);
    const bytes = await runFFmpeg([{ name, data: backup }],
      ['-i', name, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-y', 'out.m4a'], 'out.m4a', conv);
    return { bytes, ext: 'm4a' };
  }
}

/**
 * Direct file job. "original" mode never reaches here (background downloads it
 * natively); this path converts to MP3 or extracts the audio ('audio' mode).
 * @param {Object} job
 * @param {AbortSignal} signal
 * @param {(phase:string,p:number)=>void} report
 * @returns {Promise<{bytes:Uint8Array, ext:string}>}
 */
async function runDirect(job, signal, report) {
  report('descargando', 0);
  const res = await fetch(job.url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) report('descargando', got / total);
  }
  const data = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }

  report('convirtiendo', 0);
  const name = `in.${job.srcExt || 'bin'}`;
  if (job.mode === 'audio') return extractAudio(name, data, (p) => report('convirtiendo', p));
  const bytes = await runFFmpeg([{ name, data }], mp3Args(name, job.bitrate), 'out.mp3',
    (p) => report('convirtiendo', p));
  return { bytes, ext: 'mp3' };
}

/**
 * HLS job: download playlist(s), then remux (original) or encode (mp3).
 * If remuxing fails in original mode, the raw concatenated stream is saved instead
 * (still playable in VLC/mpv) rather than losing the download.
 * @param {Object} job
 * @param {AbortSignal} signal
 * @param {(phase:string,p:number)=>void} report
 * @returns {Promise<{bytes:Uint8Array, ext:string}>}
 */
async function runHls(job, signal, report) {
  const { mainUrl, audioUrl, audioOnly } = job.hls;
  const parts = audioUrl ? 2 : 1;

  report('descargando', 0);
  const main = await downloadMediaPlaylist(mainUrl, {
    signal,
    onProgress: (d, t) => report('descargando', (d / t) / parts),
  });
  const audio = audioUrl
    ? await downloadMediaPlaylist(audioUrl, {
      signal,
      onProgress: (d, t) => report('descargando', 0.5 + (d / t) / 2),
    })
    : null;

  const conv = (p) => report('convirtiendo', p);
  report('convirtiendo', 0);
  const mainName = `main.${main.container}`;

  if (job.mode === 'mp3' || job.mode === 'audio') {
    // Only the audio is needed: a separate audio rendition wins if present.
    const src = audio || main;
    const name = audio ? `aud.${audio.container}` : mainName;
    if (job.mode === 'audio') return extractAudio(name, src.data, conv);
    const bytes = await runFFmpeg([{ name, data: src.data }], mp3Args(name, job.bitrate), 'out.mp3', conv);
    return { bytes, ext: 'mp3' };
  }

  const rawFallback = { bytes: main.data.slice(), ext: main.container === 'bin' ? 'ts' : main.container };
  try {
    if (audio) {
      const audName = `aud.${audio.container}`;
      const bytes = await runFFmpeg(
        [{ name: mainName, data: main.data }, { name: audName, data: audio.data }],
        ['-i', mainName, '-i', audName, '-map', '0:v:0?', '-map', '1:a:0', '-c', 'copy', '-y', 'out.mp4'],
        'out.mp4', conv);
      return { bytes, ext: 'mp4' };
    }
    const ext = audioOnly ? 'm4a' : 'mp4';
    const args = audioOnly
      ? ['-i', mainName, '-vn', '-c:a', 'copy', '-y', `out.${ext}`]
      : ['-i', mainName, '-c', 'copy', '-y', `out.${ext}`];
    const bytes = await runFFmpeg([{ name: mainName, data: main.data }], args, `out.${ext}`, conv);
    return { bytes, ext };
  } catch (e) {
    if (signal.aborted || audio) throw e;
    console.warn('Remux falló, se guarda el stream crudo', e);
    return rawFallback;
  }
}

/**
 * Run one job end-to-end and report the result to the service worker.
 * @param {Object} job See file header.
 */
async function runJob(job) {
  const ctrl = new AbortController();
  running.set(job.jobId, ctrl);
  const report = reporter(job.jobId);
  try {
    const { bytes, ext } = job.kind === 'hls'
      ? await runHls(job, ctrl.signal, report)
      : await runDirect(job, ctrl.signal, report);
    if (ctrl.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    const mime = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', aac: 'audio/aac', ts: 'video/mp2t' }[ext]
      || 'application/octet-stream';
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    toBg({ cmd: 'done', jobId: job.jobId, blobUrl, ext });
  } catch (e) {
    const error = ctrl.signal.aborted ? 'Cancelado' : (e?.message || String(e));
    toBg({ cmd: 'error', jobId: job.jobId, error });
  } finally {
    running.delete(job.jobId);
    phases.delete(job.jobId);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.cmd) {
    case 'ping':
      sendResponse(true);
      break;
    case 'job':
      runJob(msg.job);
      sendResponse(true);
      break;
    case 'cancel': {
      const ctrl = running.get(msg.jobId);
      if (ctrl) {
        ctrl.abort();
        // ffmpeg exec is synchronous inside its worker: killing it is the only way to stop it.
        // Only do it when this job is converting, so other jobs' downloads are untouched.
        if (phases.get(msg.jobId) === 'convirtiendo') abortFFmpeg();
      }
      break;
    }
    case 'revoke':
      URL.revokeObjectURL(msg.blobUrl);
      break;
  }
});
