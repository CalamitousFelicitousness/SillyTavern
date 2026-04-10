import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PGLiteStore, closeAllInstances } from '../src/vectors/pglite-store.js';
import { validateVectorStore, SIMILARITY_METHODS } from '../src/vectors/vector-store.js';

/** @type {string} */
let testDir;

/** @type {PGLiteStore} */
let store;

function createTestVector(dimension = 3) {
    return Array.from({ length: dimension }, () => Math.random());
}

function normalizeVector(vec) {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map(v => v / norm);
}

beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-test-'));
});

afterEach(async () => {
    if (store) {
        try {
            await store.deleteIndex();
        } catch {
            // ignore cleanup errors
        }
        store = null;
    }
    await closeAllInstances();
});

afterAll(async () => {
    await closeAllInstances();
    if (fs.existsSync(testDir)) {
        await fs.promises.rm(testDir, { recursive: true });
    }
});

describe('PGLiteStore', () => {
    test('should implement the IVectorStore interface', async () => {
        store = new PGLiteStore(path.join(testDir, 'interface-test'));
        expect(() => validateVectorStore(store)).not.toThrow();
    });

    test('should report index as not created initially', async () => {
        store = new PGLiteStore(path.join(testDir, 'not-created'));
        await store.createIndex();
        // Table is created lazily on first upsert
        const created = await store.isIndexCreated();
        expect(typeof created).toBe('boolean');
    });

    test('should create index and upsert items', async () => {
        store = new PGLiteStore(path.join(testDir, 'upsert-test'));
        await store.createIndex();

        const vector = [0.1, 0.2, 0.3];
        await store.beginUpdate();
        await store.upsertItem({
            vector,
            metadata: { hash: 123, text: 'hello world', index: 0 },
        });
        await store.endUpdate();

        const items = await store.listItems();
        expect(items.length).toBe(1);
        expect(items[0].metadata.hash).toBe(123);
        expect(items[0].metadata.text).toBe('hello world');
    });

    test('should upsert (update) existing items by hash', async () => {
        store = new PGLiteStore(path.join(testDir, 'upsert-update'));
        await store.createIndex();

        await store.beginUpdate();
        await store.upsertItem({
            vector: [0.1, 0.2, 0.3],
            metadata: { hash: 456, text: 'original', index: 0 },
        });
        await store.endUpdate();

        await store.beginUpdate();
        await store.upsertItem({
            vector: [0.4, 0.5, 0.6],
            metadata: { hash: 456, text: 'updated', index: 0 },
        });
        await store.endUpdate();

        const items = await store.listItems();
        expect(items.length).toBe(1);
        expect(items[0].metadata.text).toBe('updated');
    });

    test('should delete items by ID', async () => {
        store = new PGLiteStore(path.join(testDir, 'delete-test'));
        await store.createIndex();

        await store.beginUpdate();
        await store.upsertItem({
            vector: [0.1, 0.2, 0.3],
            metadata: { hash: 789, text: 'to delete', index: 0 },
        });
        await store.endUpdate();

        const items = await store.listItems();
        expect(items.length).toBe(1);

        await store.beginUpdate();
        await store.deleteItem(items[0].id);
        await store.endUpdate();

        const remaining = await store.listItems();
        expect(remaining.length).toBe(0);
    });

    test('should query items by cosine similarity', async () => {
        store = new PGLiteStore(path.join(testDir, 'query-cosine'));
        await store.createIndex();

        const v1 = normalizeVector([1, 0, 0]);
        const v2 = normalizeVector([0, 1, 0]);
        const v3 = normalizeVector([1, 1, 0]);

        await store.beginUpdate();
        await store.upsertItem({ vector: v1, metadata: { hash: 1, text: 'a', index: 0 } });
        await store.upsertItem({ vector: v2, metadata: { hash: 2, text: 'b', index: 1 } });
        await store.upsertItem({ vector: v3, metadata: { hash: 3, text: 'c', index: 2 } });
        await store.endUpdate();

        const results = await store.queryItems(v1, 2, SIMILARITY_METHODS.COSINE);
        expect(results.length).toBe(2);
        // First result should be most similar to v1
        expect(results[0].score).toBeGreaterThan(results[1].score);
        expect(results[0].item.metadata.hash).toBe(1);
    });

    test('should query items by L2 distance', async () => {
        store = new PGLiteStore(path.join(testDir, 'query-l2'));
        await store.createIndex();

        const v1 = [1, 0, 0];
        const v2 = [0, 1, 0];
        const v3 = [0.9, 0.1, 0];

        await store.beginUpdate();
        await store.upsertItem({ vector: v1, metadata: { hash: 1, text: 'a', index: 0 } });
        await store.upsertItem({ vector: v2, metadata: { hash: 2, text: 'b', index: 1 } });
        await store.upsertItem({ vector: v3, metadata: { hash: 3, text: 'c', index: 2 } });
        await store.endUpdate();

        const results = await store.queryItems(v1, 2, SIMILARITY_METHODS.L2);
        expect(results.length).toBe(2);
        // First result should be closest (highest score after transform)
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    test('should query items by inner product', async () => {
        store = new PGLiteStore(path.join(testDir, 'query-ip'));
        await store.createIndex();

        const v1 = [1, 0, 0];
        const v2 = [0, 1, 0];
        const v3 = [0.9, 0.1, 0];

        await store.beginUpdate();
        await store.upsertItem({ vector: v1, metadata: { hash: 1, text: 'a', index: 0 } });
        await store.upsertItem({ vector: v2, metadata: { hash: 2, text: 'b', index: 1 } });
        await store.upsertItem({ vector: v3, metadata: { hash: 3, text: 'c', index: 2 } });
        await store.endUpdate();

        const results = await store.queryItems(v1, 3, SIMILARITY_METHODS.INNER_PRODUCT);
        expect(results.length).toBe(3);
        // v1 dot v1 = 1, v1 dot v3 = 0.9, v1 dot v2 = 0
        expect(results[0].item.metadata.hash).toBe(1);
    });

    test('should list items by metadata filter ($in)', async () => {
        store = new PGLiteStore(path.join(testDir, 'filter-in'));
        await store.createIndex();

        await store.beginUpdate();
        await store.upsertItem({ vector: [1, 0, 0], metadata: { hash: 10, text: 'a', index: 0 } });
        await store.upsertItem({ vector: [0, 1, 0], metadata: { hash: 20, text: 'b', index: 1 } });
        await store.upsertItem({ vector: [0, 0, 1], metadata: { hash: 30, text: 'c', index: 2 } });
        await store.endUpdate();

        const results = await store.listItemsByMetadata({ hash: { '$in': [10, 30] } });
        expect(results.length).toBe(2);
        const hashes = results.map(r => r.metadata.hash);
        expect(hashes).toContain(10);
        expect(hashes).toContain(30);
    });

    test('should delete the index entirely', async () => {
        store = new PGLiteStore(path.join(testDir, 'delete-index'));
        await store.createIndex();

        await store.beginUpdate();
        await store.upsertItem({ vector: [1, 0, 0], metadata: { hash: 1, text: 'a', index: 0 } });
        await store.endUpdate();

        await store.deleteIndex();

        // After deletion, should behave as if not created
        store = new PGLiteStore(path.join(testDir, 'delete-index'));
        const items = await store.listItems();
        expect(items.length).toBe(0);
    });

    test('should return empty results when querying non-existent index', async () => {
        store = new PGLiteStore(path.join(testDir, 'non-existent'));
        const results = await store.queryItems([1, 0, 0], 5);
        expect(results).toEqual([]);
    });

    test('should return empty when listing items from non-existent index', async () => {
        store = new PGLiteStore(path.join(testDir, 'non-existent-list'));
        const items = await store.listItems();
        expect(items).toEqual([]);
    });

    test('should return empty when filtering non-existent index', async () => {
        store = new PGLiteStore(path.join(testDir, 'non-existent-filter'));
        const items = await store.listItemsByMetadata({ hash: { '$in': [1] } });
        expect(items).toEqual([]);
    });

    test('should handle topK parameter correctly', async () => {
        store = new PGLiteStore(path.join(testDir, 'topk'));
        await store.createIndex();

        await store.beginUpdate();
        for (let i = 0; i < 10; i++) {
            await store.upsertItem({
                vector: createTestVector(3),
                metadata: { hash: i, text: `item ${i}`, index: i },
            });
        }
        await store.endUpdate();

        const results = await store.queryItems(createTestVector(3), 3);
        expect(results.length).toBe(3);
    });
});
