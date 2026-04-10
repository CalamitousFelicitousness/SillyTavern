import { describe, test, expect } from '@jest/globals';
import { validateVectorStore, SIMILARITY_METHODS, VECTOR_ENGINES } from '../src/vectors/vector-store.js';

describe('vector-store interface', () => {
    describe('SIMILARITY_METHODS', () => {
        test('should define cosine similarity method', () => {
            expect(SIMILARITY_METHODS.COSINE).toBe('cosine');
        });

        test('should define L2 similarity method', () => {
            expect(SIMILARITY_METHODS.L2).toBe('l2');
        });

        test('should define inner product similarity method', () => {
            expect(SIMILARITY_METHODS.INNER_PRODUCT).toBe('inner_product');
        });
    });

    describe('VECTOR_ENGINES', () => {
        test('should define vectra engine', () => {
            expect(VECTOR_ENGINES.VECTRA).toBe('vectra');
        });

        test('should define pglite engine', () => {
            expect(VECTOR_ENGINES.PGLITE).toBe('pglite');
        });
    });

    describe('validateVectorStore', () => {
        const createValidStore = () => ({
            isIndexCreated: async () => true,
            createIndex: async () => {},
            deleteIndex: async () => {},
            beginUpdate: async () => {},
            endUpdate: async () => {},
            upsertItem: async () => {},
            deleteItem: async () => {},
            queryItems: async () => [],
            listItems: async () => [],
            listItemsByMetadata: async () => [],
            folderPath: '/tmp/test',
        });

        test('should not throw for a valid store implementation', () => {
            const store = createValidStore();
            expect(() => validateVectorStore(store)).not.toThrow();
        });

        test('should throw if isIndexCreated is missing', () => {
            const store = createValidStore();
            delete store.isIndexCreated;
            expect(() => validateVectorStore(store)).toThrow('isIndexCreated');
        });

        test('should throw if createIndex is missing', () => {
            const store = createValidStore();
            delete store.createIndex;
            expect(() => validateVectorStore(store)).toThrow('createIndex');
        });

        test('should throw if deleteIndex is missing', () => {
            const store = createValidStore();
            delete store.deleteIndex;
            expect(() => validateVectorStore(store)).toThrow('deleteIndex');
        });

        test('should throw if beginUpdate is missing', () => {
            const store = createValidStore();
            delete store.beginUpdate;
            expect(() => validateVectorStore(store)).toThrow('beginUpdate');
        });

        test('should throw if endUpdate is missing', () => {
            const store = createValidStore();
            delete store.endUpdate;
            expect(() => validateVectorStore(store)).toThrow('endUpdate');
        });

        test('should throw if upsertItem is missing', () => {
            const store = createValidStore();
            delete store.upsertItem;
            expect(() => validateVectorStore(store)).toThrow('upsertItem');
        });

        test('should throw if deleteItem is missing', () => {
            const store = createValidStore();
            delete store.deleteItem;
            expect(() => validateVectorStore(store)).toThrow('deleteItem');
        });

        test('should throw if queryItems is missing', () => {
            const store = createValidStore();
            delete store.queryItems;
            expect(() => validateVectorStore(store)).toThrow('queryItems');
        });

        test('should throw if listItems is missing', () => {
            const store = createValidStore();
            delete store.listItems;
            expect(() => validateVectorStore(store)).toThrow('listItems');
        });

        test('should throw if listItemsByMetadata is missing', () => {
            const store = createValidStore();
            delete store.listItemsByMetadata;
            expect(() => validateVectorStore(store)).toThrow('listItemsByMetadata');
        });

        test('should throw if a method is not a function', () => {
            const store = createValidStore();
            store.queryItems = 'not a function';
            expect(() => validateVectorStore(store)).toThrow('queryItems');
        });

        test('should not throw if folderPath is missing (not a method)', () => {
            const store = createValidStore();
            delete store.folderPath;
            expect(() => validateVectorStore(store)).not.toThrow();
        });
    });
});
