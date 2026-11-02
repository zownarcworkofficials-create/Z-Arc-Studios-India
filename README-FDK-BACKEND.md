# Server-side FFmpeg + FDK AAC backend

This adds a server-side conversion path for AAC. The browser uploads the source
file, the server runs the source-built FFmpeg with `libfdk_aac`, and the browser
receives only the resulting `.m4a`.

The compiled FFmpeg binary is never served to the browser. Other formats keep
using the existing in-browser conversion path.

## 1. Read the license warning

Read [LICENSING-FDK.md](LICENSING-FDK.md). The build uses `--enable-nonfree` and
the FDK AAC library. It is not redistributable and does not eliminate AAC
patent/royalty obligations.

## 2. Build on the Linux server from source

Do not install a distro FFmpeg package. Install only build tools (git, make,
compiler, autotools, pkg-config, nasm), then:

```bash
git clone <your-repo> my-web
cd my-web
chmod +x scripts/build-ffmpeg-fdk.sh scripts/verify-fdk.sh
sudo PREFIX=/opt/ffmpeg-fdk ./scripts/build-ffmpeg-fdk.sh
```

The script:

1. Pulls the FDK AAC source from `mstorsjo/fdk-aac` (the maintained mirror used by most FFmpeg builds; override `FDK_REPO` if your legal team requires a different approved source).
2. Pulls official FFmpeg source.
3. Configures with `--enable-libfdk-aac --enable-nonfree`.
4. Builds and installs to `/opt/ffmpeg-fdk`.
5. Runs `ffmpeg -codecs` and fails unless `libfdk_aac` is registered.

Verify separately at any time:

```bash
FFMPEG_BIN=/opt/ffmpeg-fdk/bin/ffmpeg ./scripts/verify-fdk.sh
```

Expected output includes:

```text
OK: libfdk_aac is registered and the encoder is available.
```

## 3. Start the backend

The server uses only Node.js built-in modules; no npm dependencies are needed.

```bash
FFMPEG_BIN=/opt/ffmpeg-fdk/bin/ffmpeg \
  node server/index.js
```

Then open:

```text
http://127.0.0.1:8787/
```

If `libfdk_aac` is missing or the configured `FFMPEG_BIN` cannot be run, the
server still binds the port so the frontend receives a useful error instead of
a network failure. In that degraded state `/api/health` and `/api/convert`
return `503` with the exact reason, and the console prints the failed
verification. Fix the build and restart the process before converting audio.

The Node server serves the static site and the `/api/convert` endpoint on the
same origin. It also allows the site to run on another local port (for example
the existing Python server on `8790`) and call `http://127.0.0.1:8787`.

For a production deployment where the static site and API are on different
origins, set the backend origin before the main inline script:

```html
<script>window.AUDIO_BACKEND_URL = 'https://api.example.com';</script>
```

Use `window.AUDIO_BACKEND_URL = null` only for temporary client-side testing;
that bypasses the FDK backend.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `FFMPEG_BIN` | `/opt/ffmpeg-fdk/bin/ffmpeg` | FDK-enabled FFmpeg |
| `FFPROBE_BIN` | sibling `ffprobe` | Duration/bitrate probe |
| `STATIC_DIR` | repository root | Website directory |
| `MAX_UPLOAD_BYTES` | `536870912` | 512 MiB upload limit |
| `JOB_TIMEOUT_MS` | `900000` | 15 minute job timeout |
| `ALLOWED_ORIGIN` | `*` | CORS origin |
| `SKIP_FDK_CHECK` | unset | `1` starts without FDK for UI-only testing |

Health check:

```bash
curl -s http://127.0.0.1:8787/api/health
```

The endpoint returns `503` if `libfdk_aac` is not available.

## 4. How AAC modes map to FDK

`libfdk_aac` exposes only CBR and quality VBR in FFmpeg:

- **CBR:** `-c:a libfdk_aac -vbr 0 -b:a <bitrate>k`
- **VBR:** `-c:a libfdk_aac -vbr 5` (the requested template)
- **ABR:** mapped to CBR at the selected average; FDK has no native ABR switch.
- **CVBR:** mapped to CBR at the selected average; FDK has no native CVBR switch.

This mapping is exposed in `/api/health` and in the `X-FDK-Mode` response header.
The UI still shows all four modes; the server reports the actual FDK mode.

FDK VBR is only available for the AAC-LC profile. The backend rejects VBR for
HE-AAC/HE-AACv2/LD/ELD. The current UI exposes AAC-LC, but the backend profile
map supports `AACLC`, `AACHE`, `AACHEV2`, `AACLD`, and `AACELD` for future UI
work.

## 5. API

```http
POST /api/convert?filename=track.flac&mode=VARIABLE&bitrate=224&rate=44100&profile=AACLC
Content-Type: application/octet-stream

<raw file bytes>
```

Response:

- `200` with `audio/mp4`
- `Content-Disposition: attachment`
- `X-Actual-Bitrate` (kbps, when ffprobe is available)
- `X-FDK-Mode: vbr-5` or `cbr`

Errors are plain text with a non-2xx status.

## 6. What is not changed

- The FFmpeg binary and FDK library stay outside `STATIC_DIR`.
- The backend does not write the binary into the browser or a download.
- Other output formats still use the existing in-browser engine.
- A full migration of every format to the server is a separate change.
