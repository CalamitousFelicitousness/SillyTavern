import { describe, test, expect, beforeAll } from '@jest/globals';

/** @type {import('../src/deepseek-files.js')} */
let mod;

beforeAll(async () => {
    mod = await import('../src/deepseek-files.js');
});

describe('getFilesBaseUrl', () => {
    test('strips the /beta suffix used by chat completions', () => {
        expect(mod.getFilesBaseUrl('https://api.deepseek.com/beta')).toBe('https://api.deepseek.com');
    });

    test('strips a trailing slash before the /beta suffix', () => {
        expect(mod.getFilesBaseUrl('https://api.deepseek.com/beta/')).toBe('https://api.deepseek.com');
    });

    test('leaves a reverse proxy path intact', () => {
        expect(mod.getFilesBaseUrl('https://proxy.test/v1')).toBe('https://proxy.test/v1');
    });

    test('only strips /beta at the end', () => {
        expect(mod.getFilesBaseUrl('https://proxy.test/beta/v1')).toBe('https://proxy.test/beta/v1');
    });

    test('returns null for empty input', () => {
        expect(mod.getFilesBaseUrl('')).toBeNull();
        expect(mod.getFilesBaseUrl(null)).toBeNull();
        expect(mod.getFilesBaseUrl(undefined)).toBeNull();
    });
});

describe('parseDataUrl', () => {
    test('decodes a base64 data URL', () => {
        const result = mod.parseDataUrl('data:image/png;base64,aGVsbG8=');
        expect(result?.mime).toBe('image/png');
        expect(result?.buffer.toString()).toBe('hello');
    });

    test('lowercases the mime type', () => {
        expect(mod.parseDataUrl('data:IMAGE/PNG;base64,aGVsbG8=')?.mime).toBe('image/png');
    });

    test('returns null for remote URLs', () => {
        expect(mod.parseDataUrl('https://example.com/a.png')).toBeNull();
    });

    test('returns null for non-base64 data URLs', () => {
        expect(mod.parseDataUrl('data:text/plain,hello')).toBeNull();
    });

    test('returns null for non-string input', () => {
        expect(mod.parseDataUrl(null)).toBeNull();
        expect(mod.parseDataUrl(undefined)).toBeNull();
        expect(mod.parseDataUrl({})).toBeNull();
    });
});

describe('convertDeepSeekImagesToFiles', () => {
    test('does nothing without an API key', async () => {
        const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }];
        await mod.convertDeepSeekImagesToFiles(messages, { apiKey: '', apiUrl: 'https://api.deepseek.com/beta' });
        expect(messages[0].content[0].type).toBe('image_url');
    });

    test('does nothing without a usable base URL', async () => {
        const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }];
        await mod.convertDeepSeekImagesToFiles(messages, { apiKey: 'k', apiUrl: '' });
        expect(messages[0].content[0].type).toBe('image_url');
    });

    test('handles non-array input gracefully', async () => {
        await expect(mod.convertDeepSeekImagesToFiles(null, { apiKey: 'k', apiUrl: 'https://x/beta' })).resolves.toBeUndefined();
        await expect(mod.convertDeepSeekImagesToFiles('string', { apiKey: 'k', apiUrl: 'https://x/beta' })).resolves.toBeUndefined();
    });
});
