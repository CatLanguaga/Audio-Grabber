/**
 * @file Minimal HLS (.m3u8) playlist parser.
 *
 * Supports the subset needed to download VOD and live-window streams:
 *  - Master playlists: #EXT-X-STREAM-INF variants and #EXT-X-MEDIA audio renditions.
 *  - Media playlists: #EXTINF segments, #EXT-X-BYTERANGE, #EXT-X-KEY (AES-128),
 *    #EXT-X-MAP (fMP4 init segment), #EXT-X-MEDIA-SEQUENCE, #EXT-X-ENDLIST.
 *
 * DRM detection: SAMPLE-AES / SAMPLE-AES-CTR methods or any KEYFORMAT other than
 * "identity" (Widevine, FairPlay, PlayReady) mark the playlist as protected. Those
 * streams are NOT downloadable and the extension refuses them on purpose.
 *
 * Shared by background.js (detection) and offscreen.js (download), so it must stay
 * free of DOM / chrome.* APIs.
 */

/**
 * Parse an HLS attribute list (`KEY=value,KEY2="quoted, value"`).
 * @param {string} str Text after the tag colon.
 * @returns {Record<string,string>} Attribute map, quotes removed.
 */
export function parseAttributes(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Resolve a possibly relative URI against the playlist URL.
 * @param {string} uri URI found in the playlist.
 * @param {string} base Absolute URL of the playlist.
 * @returns {string} Absolute URL.
 */
function resolve(uri, base) {
  return new URL(uri, base).href;
}

/**
 * Decide whether an #EXT-X-KEY / #EXT-X-SESSION-KEY describes DRM.
 * Plain AES-128 with the default "identity" key format is standard HLS encryption,
 * not DRM, and is supported.
 * @param {Record<string,string>} attrs Parsed key attributes.
 * @returns {boolean} True when the key is DRM-protected.
 */
function isDrmKey(attrs) {
  const method = (attrs.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return false;
  if (method.startsWith('SAMPLE-AES')) return true;
  const fmt = attrs.KEYFORMAT;
  return Boolean(fmt && fmt !== 'identity');
}

/**
 * Parse a byte range "length[@offset]".
 * @param {string} str Raw value.
 * @param {number} nextOffset Offset to use when "@offset" is omitted (continues the previous range).
 * @returns {{offset:number,length:number}}
 */
function parseByteRange(str, nextOffset) {
  const [len, off] = str.split('@');
  return { length: Number(len), offset: off !== undefined ? Number(off) : nextOffset };
}

/**
 * @typedef {Object} Variant
 * @property {string} url Media playlist URL.
 * @property {number} bandwidth Peak bandwidth in bits/s (0 if unknown).
 * @property {string|null} resolution e.g. "1280x720".
 * @property {string|null} codecs CODECS attribute.
 * @property {string|null} audioGroup AUDIO group id the variant references.
 *
 * @typedef {Object} AudioRendition
 * @property {string} groupId GROUP-ID.
 * @property {string} name NAME.
 * @property {string|null} language LANGUAGE.
 * @property {string|null} url Playlist URL; null means audio is muxed into the variant.
 * @property {boolean} isDefault DEFAULT=YES.
 *
 * @typedef {Object} Segment
 * @property {string} url Segment URL.
 * @property {number} duration Seconds.
 * @property {number} seq Media sequence number (used as AES IV when none given).
 * @property {{offset:number,length:number}|null} byterange
 * @property {{method:string,uri:string,iv:string|null}|null} key AES-128 key info.
 * @property {{url:string,byterange:{offset:number,length:number}|null}|null} map fMP4 init segment.
 */

/**
 * Parse an m3u8 playlist.
 * @param {string} text Playlist body.
 * @param {string} baseUrl Absolute URL it was fetched from.
 * @returns {{type:'master',variants:Variant[],audios:AudioRendition[],drm:boolean}
 *          |{type:'media',segments:Segment[],duration:number,live:boolean,drm:boolean}}
 * @throws {Error} When the text is not an HLS playlist.
 */
export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('No es una playlist HLS');
  }

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const audios = [];
    let drm = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(l.slice(18));
        // The variant URI is the next non-tag line.
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j < lines.length) {
          variants.push({
            url: resolve(lines[j], baseUrl),
            bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
            resolution: a.RESOLUTION || null,
            codecs: a.CODECS || null,
            audioGroup: a.AUDIO || null,
          });
          i = j;
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(l.slice(13));
        if (a.TYPE === 'AUDIO') {
          audios.push({
            groupId: a['GROUP-ID'] || '',
            name: a.NAME || a.LANGUAGE || 'audio',
            language: a.LANGUAGE || null,
            url: a.URI ? resolve(a.URI, baseUrl) : null,
            isDefault: a.DEFAULT === 'YES',
          });
        }
      } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
        if (isDrmKey(parseAttributes(l.slice(19)))) drm = true;
      }
    }
    variants.sort((x, y) => y.bandwidth - x.bandwidth); // best first
    return { type: 'master', variants, audios, drm };
  }

  const segments = [];
  let seq = 0;
  let duration = 0;
  let pendingDuration = null;
  let pendingRange = null;
  let key = null;
  let map = null;
  let drm = false;
  let live = true;
  /** Next implicit byte-range offset per resource URL. */
  const nextOffset = new Map();

  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(l.slice(22)) || 0;
    } else if (l.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = l.slice(17);
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(l.slice(11));
      if (isDrmKey(a)) drm = true;
      const method = (a.METHOD || 'NONE').toUpperCase();
      key = method === 'AES-128' && a.URI
        ? { method, uri: resolve(a.URI, baseUrl), iv: a.IV || null }
        : null;
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(l.slice(11));
      const url = resolve(a.URI, baseUrl);
      map = { url, byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (l.startsWith('#EXT-X-ENDLIST')) {
      live = false;
    } else if (!l.startsWith('#')) {
      const url = resolve(l, baseUrl);
      let byterange = null;
      if (pendingRange) {
        byterange = parseByteRange(pendingRange, nextOffset.get(url) || 0);
        nextOffset.set(url, byterange.offset + byterange.length);
      }
      const d = pendingDuration ?? 0;
      segments.push({ url, duration: d, seq, byterange, key, map });
      duration += d;
      seq++;
      pendingDuration = null;
      pendingRange = null;
    }
  }
  return { type: 'media', segments, duration, live, drm };
}

/**
 * Pick the playlists to download from a master playlist.
 *
 * - audioOnly=true: prefer a separate audio rendition (DEFAULT one, or the first with
 *   a URI); otherwise the lowest-bandwidth variant (audio usually identical across
 *   variants, and it downloads the least video data).
 * - audioOnly=false: the requested variant, plus its separate audio rendition when the
 *   variant references an AUDIO group whose rendition has its own URI.
 *
 * @param {{variants:Variant[],audios:AudioRendition[]}} master Parsed master playlist.
 * @param {boolean} audioOnly Whether only audio is wanted.
 * @param {number} [variantIndex=0] Index into master.variants (sorted best first).
 * @returns {{mainUrl:string, audioUrl:string|null, audioOnly:boolean}}
 *   mainUrl: playlist to download; audioUrl: extra audio playlist to mux (or null);
 *   audioOnly: true when mainUrl is known to contain audio only.
 */
export function pickPlaylists(master, audioOnly, variantIndex = 0) {
  const withUri = master.audios.filter((a) => a.url);
  if (audioOnly) {
    const rendition = withUri.find((a) => a.isDefault) || withUri[0];
    if (rendition) return { mainUrl: rendition.url, audioUrl: null, audioOnly: true };
    const lowest = master.variants[master.variants.length - 1];
    return { mainUrl: lowest.url, audioUrl: null, audioOnly: false };
  }
  const v = master.variants[Math.min(variantIndex, master.variants.length - 1)];
  let audioUrl = null;
  if (v.audioGroup) {
    const group = withUri.filter((a) => a.groupId === v.audioGroup);
    const r = group.find((a) => a.isDefault) || group[0];
    if (r) audioUrl = r.url;
  }
  return { mainUrl: v.url, audioUrl, audioOnly: false };
}
