# Audio Grabber

Extensión de Chrome (Manifest V3) que detecta el audio y el video que carga la página y los descarga en su formato original o en MP3. Sin límites, sin cuentas y sin telemetría: solo descarga el propio medio.

## Instalación
1. Abre `chrome://extensions`.
2. Activa el **Modo desarrollador** (arriba a la derecha).
3. Pulsa **Cargar descomprimida** y selecciona esta carpeta (`audio-grabber`).
4. Fija el icono en la barra para tenerlo a mano.

## Uso
1. Abre la página y **reproduce** el audio o el video. La detección se basa en lo que el reproductor pide a la red.
2. El número del icono indica cuántos medios se detectaron.
3. Abre el panel. Cada medio aparece en una tarjeta con su selector de formato:
   - **MP3:** convierte el audio a MP3. Eliges la calidad ahí mismo (128/192/256/320 kbps). Si el archivo ya es MP3, se guarda tal cual.
   - **M4A / audio original:** extrae solo el audio sin recodificar, con la misma calidad que la fuente. Si el códec no cabe en M4A, lo pasa a AAC 192k.
   - **Video:** guarda el video completo. Si es HLS, eliges la resolución en el desplegable y se une en `.mp4`.
4. El botón grande descarga con la opción elegida; el progreso aparece debajo, con opción de cancelar.
5. **Descargar todo en MP3** aparece cuando hay 2 o más medios.
6. El panel **recuerda el último formato** que usaste para audio y para video, y lo deja preseleccionado la próxima vez.

En HLS, MP3 y M4A usan la pista de audio separada si existe; si no, la calidad más baja, porque el audio suele ser el mismo y así se descargan menos datos.

En **Ajustes** puedes cambiar:
- La calidad del MP3 (128–320 kbps).
- El tamaño mínimo para listar un archivo, para filtrar sonidos de interfaz.
- Si quieres que pregunte dónde guardar.

## Qué soporta
| Tipo | Original | MP3 |
|---|---|---|
| Archivos directos: mp3, m4a, aac, ogg, opus, wav, flac, mp4, webm, mov | Sí (descarga nativa de Chrome) | Sí (conversión con ffmpeg.wasm) |
| HLS `.m3u8` (TS, fMP4, audio empaquetado) | Sí (se une y se remuxea sin recodificar) | Sí |
| HLS cifrado con AES-128 (cifrado estándar, no DRM) | Sí | Sí |
| HLS con pista de audio separada | Sí (se combinan video y audio) | Sí |

## Qué NO soporta (a propósito o por diseño)
- **DRM** (Widevine, FairPlay, PlayReady, SAMPLE-AES): aparece como "Protegido" y no se descarga. Spotify, Netflix, Apple Music, Deezer y similares usan DRM.
- **YouTube**: se ignora.
- **DASH (`.mpd`)**: no está implementado. Los sitios que solo usan DASH no mostrarán nada útil.
- **Streams en vivo**: solo se baja lo que la playlist ofrece en ese momento (unos pocos segmentos).

## Limitaciones técnicas
- Todo se procesa **en memoria** (descarga + conversión). Va bien para audio y videos de hasta ~1–1,5 GB. Con archivos mayores el navegador puede quedarse sin memoria.
- El motor de conversión (ffmpeg.wasm, ~32 MB) se carga la primera vez que hace falta y tarda unos segundos. La conversión a MP3 corre en un solo hilo: calcula, a grandes rasgos, entre 1 y 3 minutos por hora de audio, según el equipo.
- Algunos CDNs exigen `Referer`/`Origin`. La extensión los replica con una regla temporal de `declarativeNetRequest` mientras dura la descarga. Si un sitio usa tokens que caducan muy rápido, recarga la página y descarga enseguida.
- Si al remuxear falla un HLS "Original", se guarda el stream crudo (`.ts`/`.aac`), que se reproduce igual en VLC o mpv.

## Estructura
| Archivo | Función |
|---|---|
| `manifest.json` | Permisos y CSP (`wasm-unsafe-eval` para ffmpeg) |
| `background.js` | Detección (webRequest), estado por pestaña, badge, reglas de Referer, orquestación de descargas |
| `offscreen.html/js` | Trabajo pesado: descarga de segmentos, descifrado, conversión, Blob URLs |
| `lib/m3u8.js` | Parser de playlists HLS (master/media, claves, init segments, detección de DRM) |
| `lib/hls-download.js` | Descarga de segmentos (concurrencia 4, reintentos, AES-128 con WebCrypto) |
| `lib/transcode.js` | Wrapper de ffmpeg.wasm (carga perezosa, cola serializada, cancelación) |
| `popup.html/css/js` | Interfaz |
| `vendor/` | ffmpeg.wasm, ver `vendor/LICENSES.md` |

## Depuración
- Service worker: `chrome://extensions` → Audio Grabber → **service worker** (Inspect).
- Offscreen (conversión): en la misma página aparece `offscreen.html` mientras hay un trabajo activo; ahí salen los logs de ffmpeg (nivel *Verbose*).
