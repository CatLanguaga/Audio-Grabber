/**
 * @file Thin wrapper around ffmpeg.wasm (single-thread core) for the offscreen document.
 *
 * Uses @ffmpeg/ffmpeg 0.12 (MIT) + @ffmpeg/core 0.12 (GPL-2.0-or-later, includes
 * libmp3lame), vendored under /vendor. The core (~32 MB of WASM) loads lazily on the
 * first conversion and is reused afterwards.
 */
import { FFmpeg } from '../vendor/ffmpeg/index.js';

/** @type {FFmpeg|null} */
let ffmpeg = null;
/** @type {Promise<FFmpeg>|null} */
let loading = null;
/** Progress callback for the current exec (ffmpeg reports globally). */
let progressCb = null;

/**
 * Get a loaded FFmpeg instance, loading the WASM core on first use.
 * @returns {Promise<FFmpeg>}
 */
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const f = new FFmpeg();
      f.on('progress', ({ progress }) => progressCb?.(Math.max(0, Math.min(1, progress))));
      f.on('log', ({ message }) => console.debug('[ffmpeg]', message));
      await f.load({
        coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm'),
      });
      ffmpeg = f;
      return f;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/**
 * Kill the running ffmpeg worker (used for cancel). The next call reloads the core.
 */
export function abortFFmpeg() {
  if (ffmpeg) ffmpeg.terminate();
  ffmpeg = null;
  loading = null;
}

/**
 * Run ffmpeg over in-memory inputs and return the output file.
 *
 * Input/output files live in ffmpeg's in-memory FS and are deleted afterwards
 * (even on failure) so memory is released between jobs.
 *
 * @param {{name:string,data:Uint8Array}[]} inputs Files to write before running.
 *   Note: data buffers are transferred to the worker and become unusable here.
 * @param {string[]} args ffmpeg CLI arguments (without the leading "ffmpeg").
 * @param {string} outName Output file name referenced in args.
 * @param {(p:number)=>void} [onProgress] 0..1 progress (approximate, from ffmpeg).
 * @returns {Promise<Uint8Array>} Output bytes.
 * @throws {Error} When ffmpeg exits with a non-zero code.
 */
export function runFFmpeg(inputs, args, outName, onProgress) {
  // Serialize: one ffmpeg instance, shared fixed file names, and progress is global.
  const run = queue.then(() => runFFmpegNow(inputs, args, outName, onProgress));
  queue = run.catch(() => {});
  return run;
}

/** Tail of the serialized ffmpeg job queue. */
let queue = Promise.resolve();

/**
 * Unserialized body of runFFmpeg (see there for parameters).
 * @private
 */
async function runFFmpegNow(inputs, args, outName, onProgress) {
  const f = await getFFmpeg();
  progressCb = onProgress || null;
  try {
    for (const i of inputs) await f.writeFile(i.name, i.data);
    const code = await f.exec(args);
    if (code !== 0) throw new Error(`ffmpeg terminó con código ${code}`);
    return await f.readFile(outName);
  } finally {
    progressCb = null;
    for (const name of [...inputs.map((i) => i.name), outName]) {
      try { await f.deleteFile(name); } catch { /* file may not exist */ }
    }
  }
}
