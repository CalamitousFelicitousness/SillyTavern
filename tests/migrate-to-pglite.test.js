import { describe, test, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateVectraToPglite, migrateCollection } from '../src/vectors/migrate-to-pglite.js';
import { PGLiteStore, closeAllInstances } from '../src/vectors/pglite-store.js';

/** @type {string} */
let testDir;

beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
});

afterEach(async () => {
    await closeAllInstances();
});

afterAll(async () => {
    await closeAllInstances();
    if (fs.existsSync(testDir)) {
        await fs.promises.rm(testDir, { recursive: true });
    }
});

describe('migrateCollection', () => {
    test('should return 0 for non-existent vectra index', async () => {
        const indexPath = path.join(testDir, 'nonexistent-collection');
        fs.mkdirSync(indexPath, { recursive: true });

        const count = await migrateCollection(indexPath);
        expect(count).toBe(0);
    });

    test('should skip migration if pglite already has data', async () => {
        const indexPath = path.join(testDir, 'already-migrated');

        // Pre-create pglite data
        const pgliteStore = new PGLiteStore(indexPath);
        await pgliteStore.createIndex();
        await pgliteStore.beginUpdate();
        await pgliteStore.upsertItem({
            vector: [1, 0, 0],
            metadata: { hash: 999, text: 'existing', index: 0 },
        });
        await pgliteStore.endUpdate();

        const count = await migrateCollection(indexPath);
        expect(count).toBe(0);
    });
});

describe('migrateVectraToPglite', () => {
    test('should return empty result for non-existent vectors directory', async () => {
        const vectorsDir = path.join(testDir, 'no-vectors-dir');
        const result = await migrateVectraToPglite(vectorsDir, ['transformers', 'openai']);

        expect(result.totalCollections).toBe(0);
        expect(result.migratedCollections).toBe(0);
        expect(result.totalItems).toBe(0);
        expect(result.errors).toEqual([]);
    });

    test('should handle empty source directories gracefully', async () => {
        const vectorsDir = path.join(testDir, 'empty-sources');
        const sourcePath = path.join(vectorsDir, 'transformers');
        fs.mkdirSync(sourcePath, { recursive: true });

        const result = await migrateVectraToPglite(vectorsDir, ['transformers']);

        expect(result.totalCollections).toBe(0);
        expect(result.migratedCollections).toBe(0);
    });

    test('should scan nested source/collection/model directory structure', async () => {
        const vectorsDir = path.join(testDir, 'scan-structure');
        // Create structure: vectors/source/collection/model/
        const modelPath = path.join(vectorsDir, 'openai', 'chat_123', 'text-embedding-ada-002');
        fs.mkdirSync(modelPath, { recursive: true });

        const result = await migrateVectraToPglite(vectorsDir, ['openai']);

        // Should find 1 collection (even if vectra index doesn't exist there)
        expect(result.totalCollections).toBe(1);
        // No vectra index means migrateCollection returns 0 items
        expect(result.migratedCollections).toBe(1);
        expect(result.totalItems).toBe(0);
    });

    test('should collect errors without stopping', async () => {
        const vectorsDir = path.join(testDir, 'error-handling');
        // Create a file where directory is expected to force an error
        const sourcePath = path.join(vectorsDir, 'transformers', 'bad_collection', 'model');
        fs.mkdirSync(sourcePath, { recursive: true });
        // Create a file that looks like a collection entry but can't be processed
        fs.writeFileSync(path.join(vectorsDir, 'transformers', 'bad_collection', 'model', 'corrupt_file'), 'bad data');

        const result = await migrateVectraToPglite(vectorsDir, ['transformers']);

        // Should have attempted 1 collection
        expect(result.totalCollections).toBe(1);
    });
});
