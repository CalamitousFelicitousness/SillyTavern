/**
 * @module vectra-store
 * @description Vectra-based implementation of the IVectorStore interface.
 * Wraps vectra's LocalIndex to conform to the common vector storage interface.
 */

import vectra from 'vectra';

/**
 * Creates a VectraStore instance that wraps vectra's LocalIndex.
 * @implements {import('./vector-store.js').IVectorStore}
 */
export class VectraStore {
    /**
     * @param {string} folderPath - Path to the directory for storing the index
     */
    constructor(folderPath) {
        this.folderPath = folderPath;
        /** @type {vectra.LocalIndex} */
        this._index = new vectra.LocalIndex(folderPath);
    }

    /**
     * Checks if the index has been created.
     * @returns {Promise<boolean>}
     */
    async isIndexCreated() {
        return this._index.isIndexCreated();
    }

    /**
     * Creates the index.
     * @returns {Promise<void>}
     */
    async createIndex() {
        await this._index.createIndex();
    }

    /**
     * Deletes the index entirely.
     * @returns {Promise<void>}
     */
    async deleteIndex() {
        await this._index.deleteIndex();
    }

    /**
     * Begins a batch update transaction.
     * @returns {Promise<void>}
     */
    async beginUpdate() {
        await this._index.beginUpdate();
    }

    /**
     * Commits a batch update transaction.
     * @returns {Promise<void>}
     */
    async endUpdate() {
        await this._index.endUpdate();
    }

    /**
     * Inserts or updates a vector item.
     * @param {import('./vector-store.js').VectorItem} item
     * @returns {Promise<void>}
     */
    async upsertItem(item) {
        await this._index.upsertItem(item);
    }

    /**
     * Deletes a vector item by ID.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteItem(id) {
        await this._index.deleteItem(id);
    }

    /**
     * Queries items by vector similarity. Vectra only supports cosine similarity.
     * @param {number[]} vector - The query vector
     * @param {number} topK - Number of results to return
     * @param {string} [_similarityMethod] - Ignored for vectra (always cosine)
     * @returns {Promise<import('./vector-store.js').VectorQueryResult[]>}
     */
    async queryItems(vector, topK, _similarityMethod) {
        return this._index.queryItems(vector, topK);
    }

    /**
     * Lists all items in the index.
     * @returns {Promise<import('./vector-store.js').VectorListItem[]>}
     */
    async listItems() {
        return this._index.listItems();
    }

    /**
     * Lists items matching a metadata filter.
     * @param {Object} filter - Metadata filter (e.g., { hash: { '$in': [1, 2, 3] } })
     * @returns {Promise<import('./vector-store.js').VectorListItem[]>}
     */
    async listItemsByMetadata(filter) {
        return this._index.listItemsByMetadata(filter);
    }
}
