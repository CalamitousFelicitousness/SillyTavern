import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test, expect, beforeAll } from '@jest/globals';

// Importing the module installs the codec fetch shim as a side effect.
/** @type {import('../src/jimp.js')} */
let mod;

/** 1x1 PNG. Decoding it exercises the WASM codec the shim exists to load. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Jest runs with tests/ as cwd, so resolve against the repo root explicitly.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codecWasmUrl = pathToFileURL(path.join(repoRoot, 'node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
const outsideCodecUrl = pathToFileURL(path.join(repoRoot, 'package.json'));

beforeAll(async () => {
    mod = await import('../src/jimp.js');
});

describe('jsquash codec fetch shim', () => {
    test('serves a codec wasm file that undici would refuse', async () => {
        const response = await fetch(codecWasmUrl);
        expect(response.ok).toBe(true);
        const bytes = new Uint8Array(await response.arrayBuffer());
        // \0asm magic number
        expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
    });

    test('accepts the href string form emscripten passes', async () => {
        const response = await fetch(codecWasmUrl.href);
        expect(response.ok).toBe(true);
    });

    test('leaves non-codec file URLs refused', async () => {
        await expect(fetch(outsideCodecUrl)).rejects.toThrow();
    });

    test('leaves non-file protocols to the native fetch', async () => {
        // Rejects on DNS rather than being intercepted, which is the point.
        await expect(fetch('http://invalid.invalid.test/')).rejects.toThrow();
    });

    test('marks the patched fetch so it cannot be wrapped twice', () => {
        expect(fetch[Symbol.for('sillytavern.jsquashFetchPatched')]).toBe(true);
    });
});

describe('Jimp WASM formats', () => {
    test('decodes PNG, which fails without the shim', async () => {
        const image = await mod.Jimp.read(Buffer.from(TINY_PNG, 'base64'));
        expect(image.bitmap.width).toBe(1);
        expect(image.bitmap.height).toBe(1);
    });

    test('exposes the WASM-backed mime types', () => {
        expect(mod.JimpMime.png).toBe('image/png');
        expect(mod.JimpMime.jpeg).toBe('image/jpeg');
    });
});
