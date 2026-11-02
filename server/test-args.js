'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const {
    buildAacArgs,
    normalizeMode,
    normalizeProfile,
    sanitizeFilename,
    readBodyToFile
} = require('./index');

const vbr = buildAacArgs({
    input: 'input.flac',
    output: 'output.m4a',
    mode: 'VARIABLE',
    bitrate: 224,
    rate: 44100,
    profile: 'AACLC'
}).join(' ');
assert(vbr.includes('-c:a libfdk_aac'), 'VBR must use libfdk_aac');
assert(vbr.includes('-vbr 5'), 'VBR must use -vbr 5');
assert(!vbr.includes('-b:a'), 'VBR must not pass -b:a');
assert(vbr.includes('-profile:a aac_low'), 'VBR must use AAC-LC');

const cbr = buildAacArgs({
    input: 'input.flac',
    output: 'output.m4a',
    mode: 'CONSTANT',
    bitrate: 192,
    rate: 48000,
    profile: 'AACLC'
}).join(' ');
assert(cbr.includes('-vbr 0'), 'CBR must disable FDK VBR');
assert(cbr.includes('-b:a 192k'), 'CBR must pass the requested bitrate');

for (const mode of ['AVERAGE', 'CONSTRAINED']) {
    const args = buildAacArgs({
        input: 'input.flac',
        output: 'output.m4a',
        mode,
        bitrate: 128,
        rate: 44100,
        profile: 'AACLC'
    }).join(' ');
    assert(args.includes('-vbr 0'), mode + ' is mapped to FDK CBR');
    assert(args.includes('-b:a 128k'), mode + ' must keep the bitrate target');
}

assert.throws(() => {
    buildAacArgs({
        input: 'input.flac',
        output: 'output.m4a',
        mode: 'VARIABLE',
        bitrate: 128,
        rate: 44100,
        profile: 'AACHE'
    });
}, /only available for AAC-LC/);

assert.strictEqual(normalizeProfile('he-aac'), 'AACHE');
assert.strictEqual(normalizeProfile('he-aac-v2'), 'AACHEV2');
assert.strictEqual(normalizeProfile('aac_eld'), 'AACELD');
assert.strictEqual(normalizeMode('vbr'), 'VARIABLE');
assert(!/[\\/]/.test(sanitizeFilename('../../evil.flac')), 'filename must not contain path separators');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdk-backend-test-'));
    try {
        const file = path.join(dir, 'upload.bin');
        const req = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
        req.headers = { 'content-length': '11' };
        const total = await readBodyToFile(req, file, 100);
        assert.strictEqual(total, 11);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello world');

        const tooBig = path.join(dir, 'too-big.bin');
        const req2 = Readable.from([Buffer.alloc(200, 1)]);
        req2.headers = { 'content-length': '200' };
        await assert.rejects(
            () => readBodyToFile(req2, tooBig, 100),
            /larger than the configured limit/
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('OK: AAC backend argument tests passed.');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
