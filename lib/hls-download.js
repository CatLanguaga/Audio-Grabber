/**
 * @file HLS segment downloader (runs in the offscreen document).
 *
 * Fetches a media playlist, downloads every segment with bounded concurrency and
 * retries, decrypts AES-128 segments with WebCrypto, prepends fMP4 init segments
 * (#EXT-X-MAP) and returns one contiguous byte buffer ready for ffmpeg.
 *
 * Everything is kept in memory: fine for audio and medium videos, not for multi-GB
 * streams.
 */
import { parseM3U8 } from './m3u8.js';

/**
 * Fetch a URL as bytes, with retries and optional Range.
 * Cookies are sent (credentials: 'include'); Referer/Origin are injected by the
 * temporary declarativeNetRequest rule background.js installs for the job.
 * @param {string} url Resource URL.
 * @param {Object} [opts]
 * @param {{offset:number,length:number}|null} [opts.range] Byte range to request.
 * @param {AbortSignal} [opts.signal] Cancels the request.
 * @param {number} [opts.retries=3] Extra attempts on network/5xx errors.
 * @returns {Promise<Uint8Array>}
 * @throws {Error} On 4xx, abort, or after the last retry.
 */
export async function fetchBytes(url, { range = null, signal, retries = 3 } = {}) {
  const headers = {};
  if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers, credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} en ${new URL(url).pathname}`);
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= retries || e.retryable === false) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

/**
 * Fetch a playlist as text.
 * @param {string} url Playlist URL.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function fetchText(url, signal) {
  return new TextDecoder().decode(await fetchBytes(url, { signal }));
}

/**
 * Build the 16-byte AES IV: explicit hex IV, or the media sequence number big-endian
 * (HLS spec default when the key tag has no IV attribute).
 * @param {string|null} hexIv "0x..." value from #EXT-X-KEY, or null.
 * @param {number} seq Segment media sequence number.
 * @returns {Uint8Array}
 */
function buildIv(hexIv, seq) {
  const iv = new Uint8Array(16);
  if (hexIv) {
    const hex = hexIv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seq);
  }
  return iv;
}

/**
 * Guess the container of the concatenated data from its first bytes, so ffmpeg gets
 * a sensible input file extension.
 * @param {Uint8Array} b Data.
 * @returns {'ts'|'mp4'|'aac'|'mp3'|'bin'}
 */
export function sniffContainer(b) {
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'ts';
  const tag = String.fromCharCode(b[4], b[5], b[6], b[7]);
  if (['ftyp', 'styp', 'moof', 'moov', 'sidx'].includes(tag)) return 'mp4';
  let off = 0;
  // Packed audio segments start with an ID3 tag (timestamp); skip it.
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    off = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  }
  if (b[off] === 0xff && (b[off + 1] & 0xf6) === 0xf0) return 'aac';
  if (b[off] === 0xff && (b[off + 1] & 0xe0) === 0xe0) return 'mp3';
  return 'bin';
}

/**
 * Download a full HLS media playlist into one buffer.
 * @param {string} playlistUrl Media playlist URL (not a master playlist).
 * @param {Object} opts
 * @param {AbortSignal} opts.signal Cancels all pending requests.
 * @param {(done:number,total:number)=>void} [opts.onProgress] Called after each segment.
 * @param {number} [opts.concurrency=4] Parallel segment requests.
 * @returns {Promise<{data:Uint8Array, container:string, live:boolean}>}
 * @throws {Error} On DRM, master playlists, empty playlists, or network failure.
 */
export async function downloadMediaPlaylist(playlistUrl, { signal, onProgress, concurrency = 4 }) {
  const pl = parseM3U8(await fetchText(playlistUrl, signal), playlistUrl);
  if (pl.type !== 'media') throw new Error('Se esperaba una media playlist');
  if (pl.drm) throw new Error('Contenido protegido con DRM: no se puede descargar');
  if (!pl.segments.length) throw new Error('Playlist vacía');

  const keyCache = new Map(); // key URI -> Promise<CryptoKey>
  const getKey = (uri) => {
    if (!keyCache.has(uri)) {
      keyCache.set(uri, fetchBytes(uri, { signal }).then((raw) =>
        crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
    }
    return keyCache.get(uri);
  };

  const n = pl.segments.length;
  const parts = new Array(n);
  let next = 0;
  let done = 0;

  /** Worker loop: takes the next segment index until none remain. */
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const s = pl.segments[i];
      let data = await fetchBytes(s.url, { range: s.byterange, signal });
      if (s.key) {
        const key = await getKey(s.key.uri);
        data = new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv: buildIv(s.key.iv, s.seq) }, key, data)); // removes PKCS7 padding
      }
      parts[i] = data;
      done++;
      onProgress?.(done, n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));

  // Insert init segments (fMP4) where the #EXT-X-MAP changes (normally only once, at the start).
  const chunks = [];
  let lastMap = null;
  for (let i = 0; i < n; i++) {
    const map = pl.segments[i].map;
    const mapKey = map ? `${map.url}|${map.byterange?.offset}` : null;
    if (map && mapKey !== lastMap) {
      chunks.push(await fetchBytes(map.url, { range: map.byterange, signal }));
      lastMap = mapKey;
    }
    chunks.push(parts[i]);
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const data = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }
  return { data, container: sniffContainer(data), live: pl.live };
}
