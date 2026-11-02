'use strict';

/*
 * Server-side audio conversion API using a source-built FFmpeg with
 * Fraunhofer FDK AAC (libfdk_aac).
 *
 * IMPORTANT: The FFmpeg binary used here is a --enable-nonfree build. It must
 * stay on the server. This server never serves or exposes the binary, only
 * converted audio files. See LICENSING-FDK.md.
 *
 * Run:
 *   FFMPEG_BIN=/opt/ffmpeg-fdk/bin/ffmpeg node server/index.js
 *
 * Environment:
 *   PORT                 HTTP port (default 8787)
 *   HOST                 bind address (default 127.0.0.1)
 *   FFMPEG_BIN           path to the FDK-enabled ffmpeg
 *   FFPROBE_BIN          path to ffprobe (default: sibling of FFMPEG_BIN)
 *   STATIC_DIR           website directory (default: repository root)
 *   MAX_UPLOAD_BYTES     upload limit (default 512 MiB)
 *   JOB_TIMEOUT_MS       conversion timeout (default 15 minutes)
 *   ALLOWED_ORIGIN       CORS origin (default *)
 *   SKIP_FDK_CHECK=1     start without libfdk_aac (development only)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/ffmpeg-fdk/bin/ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || path.join(path.dirname(FFMPEG_BIN), 'ffprobe');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..'));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 15 * 60 * 1000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SKIP_FDK_CHECK = process.env.SKIP_FDK_CHECK === '1';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.txt': 'text/plain; charset=utf-8'
};

const PROFILE_MAP = {
    AACLC: 'aac_low',
    AACHE: 'aac_he',
    AACHEV2: 'aac_he_v2',
    AACLD: 'aac_ld',
    AACELD: 'aac_eld'
};

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

let fdkState = {
    ok: false,
    registered: false,
    encoder: false,
    checkedAt: null,
    error: null
};

function run(command, args, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let stdout = '';
        let stderr = '';
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true
        });

        function finish(fn, value) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        }

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (error) => finish(reject, error));
        child.on('close', (code, signal) => {
            finish(resolve, { code, signal, stdout, stderr });
        });

        if (opts.timeoutMs > 0) {
            timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (error) { /* ignore */ }
                finish(reject, new Error('Process timed out after ' +
                    Math.round(opts.timeoutMs / 1000) + ' seconds'));
            }, opts.timeoutMs);
        }
    });
}

function sanitizeFilename(name) {
    const base = String(name || 'input')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 180);
    return base || 'input';
}

function inputExtension(name) {
    const match = /\.([a-z0-9]{1,10})$/i.exec(name || '');
    return match ? '.' + match[1].toLowerCase() : '.bin';
}

function normalizeMode(value) {
    const mode = String(value || 'VARIABLE').toUpperCase();
    return ['CONSTANT', 'AVERAGE', 'CONSTRAINED', 'VARIABLE'].indexOf(mode) !== -1
        ? mode
        : 'VARIABLE';
}

function normalizeProfile(value) {
    const raw = String(value || 'AACLC').toUpperCase().replace(/[-_\s]/g, '');
    if (raw === 'LC' || raw === 'AACLC') return 'AACLC';
    if (raw === 'HE' || raw === 'AACHE' || raw === 'HEAAC') return 'AACHE';
    if (raw === 'HEV2' || raw === 'AACHEV2' || raw === 'HEAACV2') return 'AACHEV2';
    if (raw === 'LD' || raw === 'AACLD') return 'AACLD';
    if (raw === 'ELD' || raw === 'AACELD') return 'AACELD';
    return 'AACLC';
}

function clampInteger(value, min, max, fallback) {
    const number = parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function buildAacArgs(options) {
    const input = options.input;
    const output = options.output;
    const mode = normalizeMode(options.mode);
    const bitrate = clampInteger(options.bitrate, 6, 512, 128);
    const rate = clampInteger(options.rate, 8000, 96000, 44100);
    const profile = normalizeProfile(options.profile);
    const fdkProfile = PROFILE_MAP[profile];

    if (!input || !output) throw new HttpError(500, 'buildAacArgs needs input and output paths');
    if (!fdkProfile) throw new HttpError(400, 'Unsupported AAC profile: ' + profile);

    const args = [
        '-hide_banner', '-nostdin', '-v', 'error', '-y',
        '-i', input,
        '-map', '0:a:0', '-vn',
        '-ar', String(rate),
        '-c:a', 'libfdk_aac',
        '-profile:a', fdkProfile
    ];

    // libfdk_aac has exactly two rate-control families in FFmpeg:
    //   -vbr 0 = CBR (with -b:a)
    //   -vbr 1..5 = quality VBR (AAC-LC only)
    // It has no native ABR or CVBR switch. ABR/CVBR requests use CBR at the
    // selected average; VBR uses the requested VBR 5 template.
    if (mode === 'VARIABLE') {
        if (fdkProfile !== 'aac_low') {
            throw new HttpError(400, 'libfdk_aac VBR is only available for AAC-LC. Choose AAC-LC or use CBR/ABR/CVBR.');
        }
        args.push('-vbr', '5');
    } else {
        args.push('-vbr', '0', '-b:a', bitrate + 'k');
    }

    args.push('-movflags', '+faststart', output);
    return args;
}

function readBodyToFile(req, target, limit) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > limit) {
            reject(new HttpError(413, 'Upload is larger than the configured limit'));
            req.resume();
            return;
        }

        const out = fs.createWriteStream(target);
        let total = 0;
        let finished = false;

        function fail(error) {
            if (finished) return;
            finished = true;
            req.unpipe(out);
            out.destroy();
            req.resume();
            reject(error);
        }

        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
                fail(new HttpError(413, 'Upload is larger than the configured limit'));
            }
        });
        req.on('error', fail);
        req.on('aborted', () => fail(new HttpError(400, 'Upload aborted')));
        out.on('error', fail);
        out.on('finish', () => {
            if (finished) return;
            finished = true;
            resolve(total);
        });
        req.pipe(out);
    });
}

async function probeDuration(file) {
    try {
        const result = await run(FFPROBE_BIN, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=nw=1:nk=1',
            file
        ], { timeoutMs: 20000 });
        const value = parseFloat(String(result.stdout).trim());
        return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
        return 0;
    }
}

async function probeStreamBitrateKbps(file) {
    try {
        const result = await run(FFPROBE_BIN, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=bit_rate',
            '-of', 'default=nw=1:nk=1',
            file
        ], { timeoutMs: 20000 });
        const value = parseInt(String(result.stdout).trim(), 10);
        return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : 0;
    } catch (error) {
        return 0;
    }
}

async function verifyFdk() {
    const state = {
        ok: false,
        registered: false,
        encoder: false,
        checkedAt: new Date().toISOString(),
        error: null
    };

    try {
        const codecs = await run(FFMPEG_BIN, ['-hide_banner', '-codecs'], {
            timeoutMs: 20000
        });
        const text = String(codecs.stdout) + String(codecs.stderr);
        state.registered = /(^|\n)[^\n]*\blibfdk_aac\b/m.test(text);
        if (!state.registered) {
            state.error = 'libfdk_aac is not listed by ffmpeg -codecs';
            return state;
        }

        const help = await run(FFMPEG_BIN, ['-hide_banner', '-h', 'encoder=libfdk_aac'], {
            timeoutMs: 20000
        });
        state.encoder = help.code === 0 &&
            /libfdk_aac/.test(String(help.stdout) + String(help.stderr));
        state.ok = state.encoder;
        if (!state.encoder) state.error = 'ffmpeg lists libfdk_aac but cannot open the encoder';
    } catch (error) {
        state.error = error && error.message ? error.message : String(error);
    }

    return state;
}

function applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Actual-Bitrate, X-FDK-Mode');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendError(res, statusCode, message) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const body = Buffer.from(String(message || 'Request failed') + '\n', 'utf8');
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sendJson(res, statusCode, value) {
    const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

async function handleConvert(req, res, requestUrl) {
    let tempDir = null;
    try {
        if (!fdkState.ok) {
            throw new HttpError(503, 'libfdk_aac is not available. Run scripts/verify-fdk.sh on the server.');
        }

        const params = requestUrl.searchParams;
        const filename = sanitizeFilename(params.get('filename') || 'input');
        const ext = inputExtension(filename);
        const mode = normalizeMode(params.get('mode'));
        const bitrate = clampInteger(params.get('bitrate'), 6, 512, 128);
        const rate = clampInteger(params.get('rate'), 8000, 96000, 44100);
        const profile = normalizeProfile(params.get('profile'));

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdk-aac-'));
        const inputPath = path.join(tempDir, 'input' + ext);
        const outputPath = path.join(tempDir, 'output.m4a');
        const uploadedBytes = await readBodyToFile(req, inputPath, MAX_UPLOAD_BYTES);
        if (!uploadedBytes) throw new HttpError(400, 'Empty upload');

        const args = buildAacArgs({
            input: inputPath,
            output: outputPath,
            mode: mode,
            bitrate: bitrate,
            rate: rate,
            profile: profile
        });

        const result = await run(FFMPEG_BIN, args, { timeoutMs: JOB_TIMEOUT_MS });
        if (result.code !== 0) {
            const detail = String(result.stderr || result.stdout || '').trim();
            throw new HttpError(500, 'FFmpeg failed: ' +
                (detail || ('exit code ' + result.code)));
        }

        const stat = fs.statSync(outputPath);
        if (!stat.size) throw new HttpError(500, 'FFmpeg produced an empty output file');

        const duration = await probeDuration(outputPath);
        let actualKbps = mode === 'VARIABLE'
            ? 0
            : await probeStreamBitrateKbps(outputPath);
        if (!actualKbps && duration > 0) {
            actualKbps = Math.round(stat.size * 8 / duration / 1000);
        }

        const base = path.basename(filename, path.extname(filename)) || 'audio';
        const downloadName = base + '-fdk-aac.m4a';
        res.writeHead(200, {
            'Content-Type': 'audio/mp4',
            'Content-Length': stat.size,
            'Content-Disposition': 'attachment; filename="' +
                downloadName.replace(/["\\]/g, '_') + '"',
            'X-Actual-Bitrate': String(actualKbps || ''),
            'X-FDK-Mode': mode === 'VARIABLE' ? 'vbr-5' : 'cbr',
            'Cache-Control': 'no-store'
        });

        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(outputPath);
            stream.on('error', reject);
            res.on('close', resolve);
            res.on('finish', resolve);
            stream.pipe(res);
        });
    } catch (error) {
        const status = error instanceof HttpError ? error.statusCode : 500;
        if (!res.headersSent) {
            sendError(res, status, error && error.message ? error.message : String(error));
        } else {
            res.destroy();
        }
    } finally {
        if (tempDir) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
        }
    }
}

async function serveStatic(req, res, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch (error) {
        sendError(res, 400, 'Invalid URL encoding');
        return;
    }

    if (decoded === '/' || decoded === '') decoded = '/index.html';
    if (decoded === '/server' || decoded.startsWith('/server/') ||
        decoded === '/scripts' || decoded.startsWith('/scripts/')) {
        sendError(res, 404, 'Not found');
        return;
    }
    if (decoded.split('/').some((part) => part.startsWith('.'))) {
        sendError(res, 404, 'Not found');
        return;
    }

    const filePath = path.resolve(STATIC_DIR, '.' + decoded);
    const relative = path.relative(STATIC_DIR, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        sendError(res, 403, 'Forbidden');
        return;
    }

    let stat;
    try {
        stat = await fs.promises.stat(filePath);
    } catch (error) {
        sendError(res, 404, 'Not found');
        return;
    }
    if (!stat.isFile()) {
        sendError(res, 404, 'Not found');
        return;
    }

    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ||
        'application/octet-stream';
    res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=300'
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
}

const server = http.createServer((req, res) => {
    applyCors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    let requestUrl;
    try {
        requestUrl = new URL(req.url, 'http://localhost');
    } catch (error) {
        sendError(res, 400, 'Invalid URL');
        return;
    }

    if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, fdkState.ok ? 200 : 503, {
            ok: fdkState.ok,
            fdkRegistered: fdkState.registered,
            fdkEncoder: fdkState.encoder,
            ffmpeg: FFMPEG_BIN,
            checkedAt: fdkState.checkedAt,
            error: fdkState.error,
            nonfree: true,
            rateControl: {
                CBR: 'libfdk_aac -vbr 0 -b:a',
                ABR: 'mapped to CBR (libfdk_aac has no native ABR switch)',
                CVBR: 'mapped to CBR (libfdk_aac has no native CVBR switch)',
                VBR: 'libfdk_aac -vbr 5'
            }
        });
        return;
    }

    if (requestUrl.pathname === '/api/convert' && req.method === 'POST') {
        handleConvert(req, res, requestUrl);
        return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, requestUrl.pathname).catch((error) => {
            sendError(res, 500, error && error.message ? error.message : String(error));
        });
        return;
    }

    sendError(res, 405, 'Method not allowed');
});

async function start() {
    if (SKIP_FDK_CHECK) {
        fdkState = {
            ok: false,
            registered: false,
            encoder: false,
            checkedAt: new Date().toISOString(),
            error: 'FDK check skipped (SKIP_FDK_CHECK=1)'
        };
        console.warn('WARNING: SKIP_FDK_CHECK=1; /api/convert will return 503.');
    } else {
        fdkState = await verifyFdk();
        if (!fdkState.ok) {
            console.error('ERROR: libfdk_aac verification failed: ' + fdkState.error);
            console.error('Starting in degraded mode so the API can report the problem.');
            console.error('Run scripts/verify-fdk.sh on the server, then restart this process.');
            console.error('/api/health and /api/convert will return 503 until then.');
        } else {
            console.log('OK: libfdk_aac is registered and the encoder is available.');
        }
    }

    server.listen(PORT, HOST, () => {
        console.log('FDK AAC conversion server listening on http://' + HOST + ':' + PORT);
        console.log('Static site: ' + STATIC_DIR);
        console.log('FFmpeg: ' + FFMPEG_BIN);
        console.log('NOTE: this is a --enable-nonfree build; keep the binary server-side.');
    });
}

if (require.main === module) {
    start().catch((error) => {
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
    });
}

module.exports = {
    buildAacArgs,
    normalizeMode,
    normalizeProfile,
    sanitizeFilename,
    readBodyToFile,
    verifyFdk,
    server,
    start
};
