import path from 'node:path';
import crypto from 'node:crypto';

import fetch from 'node-fetch';
import FormData from 'form-data';
import storage from 'node-persist';
import { ResizeStrategy } from '@jimp/plugin-resize';

import { Jimp, JimpMime } from './jimp.js';

// DeepSeek Files API: upload an image once, reference it as { type: 'file', file_id }.
// Token cost is identical to inline base64; the win is not re-uploading the whole
// chat history on every turn. https://api-docs.deepseek.com/guides/files_api
//
// Lives at the host root. POST /beta/files is a 404, unlike /beta/chat/completions.

/** Only purpose DeepSeek accepts. 'vision' and 'assistants' are rejected with a 400. */
const UPLOAD_PURPOSE = 'user_data';

/** DeepSeek's maximum retention. Self-expiry keeps us under the 10k file / 25 GiB account cap. */
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Re-upload this far ahead of expiry so a reference cannot lapse mid-request. */
const EXPIRY_MARGIN_MS = 60 * 60 * 1000;

/** detail is ignored on file parts, so detail:'low' is emulated by downscaling before upload. */
const LOW_DETAIL_MAX_SIDE = 512;

/** Files API ceiling. Larger images stay inline and hit the 32 MiB request limit instead. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const CACHE_DIRECTORY = 'deepseek-files';

/** Formats DeepSeek accepts, mapped to the extension sent as the multipart filename. */
const UPLOADABLE_MIME_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

/**
 * Bases that answered 404 to an upload. Reverse proxies rarely implement /files,
 * and retrying per image would add a dead round-trip to every request.
 * @type {Set<string>}
 */
const unsupportedBases = new Set();

/** @type {Promise<import('node-persist').LocalStorage>?} */
let cachePromise = null;

/**
 * Hash to file_id cache, shared by all users of this instance.
 * @returns {Promise<import('node-persist').LocalStorage>}
 */
function getCache() {
    if (!cachePromise) {
        cachePromise = (async () => {
            const instance = storage.create({
                dir: path.join(globalThis.DATA_ROOT, '_cache', CACHE_DIRECTORY),
                ttl: false,
                forgiveParseErrors: true,
                expiredInterval: 0,
            });
            await instance.init();
            return instance;
        })();
    }

    return cachePromise;
}

/**
 * Derives the Files API base from the chat completions base.
 * @param {string} apiUrl Chat completions base URL
 * @returns {string?} Base URL for /files, or null if unusable
 */
export function getFilesBaseUrl(apiUrl) {
    if (!apiUrl) {
        return null;
    }

    return String(apiUrl).replace(/\/+$/, '').replace(/\/beta$/, '') || null;
}

/**
 * Splits a data URL into its MIME type and decoded bytes.
 * @param {string} url Data URL
 * @returns {{ buffer: Buffer, mime: string }?} Parsed payload, or null if not a data URL
 */
export function parseDataUrl(url) {
    const match = typeof url === 'string' && url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) {
        return null;
    }

    return { buffer: Buffer.from(match[2], 'base64'), mime: match[1].toLowerCase() };
}

/**
 * Scopes cache entries to a credential without storing it. A file_id issued for one
 * DeepSeek account is meaningless to another, so keys must not be shared across keys.
 * @param {string} apiKey API key
 * @returns {string} Opaque scope prefix
 */
function getCredentialScope(apiKey) {
    return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Shrinks an image to emulate detail:'low', which file parts ignore.
 * Matches the token cost of an inline low-detail image (verified: 363 -> 151).
 * @param {Buffer} buffer Source image
 * @param {string} mime Source MIME type
 * @returns {Promise<{ buffer: Buffer, mime: string }?>} Downscaled image, or null if it could not be resized
 */
async function downscaleToLowDetail(buffer, mime) {
    try {
        const image = await Jimp.read(buffer);
        const longestSide = Math.max(image.bitmap.width, image.bitmap.height);

        if (longestSide <= LOW_DETAIL_MAX_SIDE) {
            return { buffer, mime };
        }

        const scale = LOW_DETAIL_MAX_SIDE / longestSide;
        image.resize({
            w: Math.round(image.bitmap.width * scale),
            h: Math.round(image.bitmap.height * scale),
            mode: ResizeStrategy.BILINEAR,
        });

        return { buffer: await image.getBuffer(JimpMime.png), mime: 'image/png' };
    } catch (error) {
        // Jimp's WASM codecs (png/jpeg/webp/avif) load via fetch() on a file: URL,
        // which undici rejects. Caller keeps the image inline rather than uploading
        // a full-size copy that would silently cost 2.4x the tokens.
        console.warn('DeepSeek: low-detail downscale failed, keeping image inline.', error);
        return null;
    }
}

/**
 * Uploads one image to the Files API.
 * @param {string} base Files API base URL
 * @param {string} apiKey API key
 * @param {Buffer} buffer Image bytes
 * @param {string} mime Image MIME type
 * @returns {Promise<{ id: string, expires_at?: number }?>} Uploaded file, or null on failure
 */
async function uploadFile(base, apiKey, buffer, mime) {
    const formData = new FormData();
    formData.append('purpose', UPLOAD_PURPOSE);
    // Bracket spelling is the only one DeepSeek honors. expires_after=N and expires_in=N
    // both return 200 with no expires_at, silently storing the file permanently.
    formData.append('expires_after[anchor]', 'created_at');
    formData.append('expires_after[seconds]', String(RETENTION_SECONDS));
    formData.append('file', buffer, {
        filename: `image.${UPLOADABLE_MIME_TYPES[mime]}`,
        contentType: mime,
    });

    const result = await fetch(`${base}/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...formData.getHeaders(),
        },
        body: formData,
    });

    if (!result.ok) {
        const text = await result.text();
        console.warn(`DeepSeek Files API upload failed: ${result.status} ${text}`);

        // A missing route means this base has no Files API at all; anything else
        // (quota, auth, transient) may succeed for the next image.
        if (result.status === 404) {
            unsupportedBases.add(base);
        }

        return null;
    }

    return await result.json();
}

/**
 * Resolves one image content part to a file_id, uploading it if not already cached.
 * @param {object} part Content part of type image_url
 * @param {string} base Files API base URL
 * @param {string} apiKey API key
 * @returns {Promise<string?>} File id, or null to leave the part inline
 */
async function resolveFileId(part, base, apiKey) {
    const parsed = parseDataUrl(part.image_url?.url);

    // Remote URLs are fetched by DeepSeek itself, so there is nothing to upload.
    if (!parsed) {
        return null;
    }

    let { buffer, mime } = parsed;

    if (!UPLOADABLE_MIME_TYPES[mime]) {
        return null;
    }

    // Uploading a full-size copy under detail:'low' would override the user's
    // setting, so if it cannot be shrunk it stays inline and DeepSeek downscales it.
    if (part.image_url?.detail === 'low') {
        const downscaled = await downscaleToLowDetail(buffer, mime);

        if (!downscaled) {
            return null;
        }

        ({ buffer, mime } = downscaled);
    }

    if (buffer.length > MAX_UPLOAD_BYTES) {
        return null;
    }

    // Keyed on the bytes actually uploaded, so a downscaled copy and its original
    // are distinct entries, and a failed downscale correctly reuses the original.
    const key = `${getCredentialScope(apiKey)}-${crypto.createHash('sha256').update(buffer).digest('hex')}`;
    const cache = await getCache();
    const cached = await cache.getItem(key);

    if (cached?.id && (!cached.expires_at || (cached.expires_at * 1000) - Date.now() > EXPIRY_MARGIN_MS)) {
        return cached.id;
    }

    const uploaded = await uploadFile(base, apiKey, buffer, mime);

    if (!uploaded?.id) {
        return null;
    }

    await cache.setItem(key, { id: uploaded.id, expires_at: uploaded.expires_at ?? null });
    return uploaded.id;
}

/**
 * Replaces inline image parts with Files API references.
 * Call after sanitizeDeepSeekImages, which only recognizes image_url parts.
 * Any failure leaves the part inline, so generation never depends on this succeeding.
 * @param {object[]} messages Array of messages, mutated in place
 * @param {object} options Request context
 * @param {string} options.apiKey DeepSeek API key
 * @param {string} options.apiUrl Chat completions base URL
 * @returns {Promise<void>}
 */
export async function convertDeepSeekImagesToFiles(messages, { apiKey, apiUrl }) {
    if (!Array.isArray(messages) || !apiKey) {
        return;
    }

    const base = getFilesBaseUrl(apiUrl);

    if (!base || unsupportedBases.has(base)) {
        return;
    }

    try {
        for (const message of messages) {
            if (!Array.isArray(message.content)) {
                continue;
            }

            for (const part of message.content) {
                if (part?.type !== 'image_url') {
                    continue;
                }

                // Sequential on purpose: duplicate images in one request then hit the
                // cache instead of racing into two uploads of the same bytes.
                const fileId = await resolveFileId(part, base, apiKey);

                if (!fileId) {
                    continue;
                }

                part.type = 'file';
                part.file_id = fileId;
                delete part.image_url;
            }
        }
    } catch (error) {
        console.warn('DeepSeek: Files API conversion failed, sending images inline.', error);
    }
}
