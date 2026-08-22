import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createJimp } from '@jimp/core';

// Optimized image formats
import webp from '@jimp/wasm-webp';
import png from '@jimp/wasm-png';
import jpeg from '@jimp/wasm-jpeg';
import avif from '@jimp/wasm-avif';

// Other image formats
import bmp, { msBmp } from '@jimp/js-bmp';
import gif from '@jimp/js-gif';
import tiff from '@jimp/js-tiff';

// Plugins
import * as blit from '@jimp/plugin-blit';
import * as circle from '@jimp/plugin-circle';
import * as color from '@jimp/plugin-color';
import * as contain from '@jimp/plugin-contain';
import * as cover from '@jimp/plugin-cover';
import * as crop from '@jimp/plugin-crop';
import * as displace from '@jimp/plugin-displace';
import * as fisheye from '@jimp/plugin-fisheye';
import * as flip from '@jimp/plugin-flip';
import * as mask from '@jimp/plugin-mask';
import * as resize from '@jimp/plugin-resize';
import * as rotate from '@jimp/plugin-rotate';
import * as threshold from '@jimp/plugin-threshold';
import * as quantize from '@jimp/plugin-quantize';

const defaultPlugins = [
    blit.methods,
    circle.methods,
    color.methods,
    contain.methods,
    cover.methods,
    crop.methods,
    displace.methods,
    fisheye.methods,
    flip.methods,
    mask.methods,
    resize.methods,
    rotate.methods,
    threshold.methods,
    quantize.methods,
];

/** Marks the patched fetch so a re-import cannot wrap it twice. */
const CODEC_FETCH_PATCHED = Symbol.for('sillytavern.jsquashFetchPatched');

// @jsquash codecs load their .wasm via fetch() on a file: URL, which undici
// refuses ("not implemented... yet..."), breaking png/jpeg/webp/avif in Node.
// wasm-bindgen passes a URL, emscripten passes new URL(...).href as a string.
// Scoped to codec .wasm paths so the file: rejection in the private request
// filter still holds everywhere else. https://github.com/jimp-dev/jimp/issues/1366
const CODEC_WASM_PATH = /[\\/]node_modules[\\/]@jsquash[\\/].+\.wasm$/;

/** Emscripten re-inits per decode, so avoid re-reading the same file. @type {Map<string, Buffer>} */
const codecWasmCache = new Map();

if (!globalThis.fetch[CODEC_FETCH_PATCHED]) {
    const nativeFetch = globalThis.fetch;

    const toFileUrl = (input) => {
        try {
            if (input instanceof URL) {
                return input;
            }
            return typeof input === 'string' && input.startsWith('file:') ? new URL(input) : null;
        } catch {
            return null;
        }
    };

    const patched = async function (input, init) {
        const url = toFileUrl(input);

        if (url?.protocol === 'file:') {
            const filePath = fileURLToPath(url);

            if (CODEC_WASM_PATH.test(filePath)) {
                if (!codecWasmCache.has(filePath)) {
                    codecWasmCache.set(filePath, fs.readFileSync(filePath));
                }

                return new Response(codecWasmCache.get(filePath), {
                    status: 200,
                    headers: { 'Content-Type': 'application/wasm' },
                });
            }
        }

        return nativeFetch(input, init);
    };

    patched[CODEC_FETCH_PATCHED] = true;
    globalThis.fetch = patched;
}

// A custom jimp that uses WASM for optimized formats and JS for the rest
const Jimp = createJimp({
    formats: [webp, png, jpeg, avif, bmp, msBmp, gif, tiff],
    plugins: [...defaultPlugins],
});

const JimpMime = {
    bmp: bmp().mime,
    gif: gif().mime,
    jpeg: jpeg().mime,
    png: png().mime,
    tiff: tiff().mime,
};

export default Jimp;

export { Jimp, JimpMime };
