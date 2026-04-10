/**
 * @module vector-store
 * @description Defines the interface for vector storage operations.
 * All vector storage backends (vectra, pglite, etc.) must implement this interface.
 */

/**
 * @typedef {Object} VectorItem
 * @property {number[]} vector - The embedding vector
 * @property {Object} metadata - The metadata associated with the vector
 * @property {number} metadata.hash - The hash of the text content
 * @property {string} metadata.text - The original text
 * @property {number} metadata.index - The position/index
 */

/**
 * @typedef {Object} VectorQueryResult
 * @property {number} score - Similarity score (0-1)
 * @property {Object} item - The matched item
 * @property {string} item.id - The unique item ID
 * @property {number[]} item.vector - The embedding vector
 * @property {Object} item.metadata - The metadata
 */

/**
 * @typedef {Object} VectorListItem
 * @property {string} id - The unique item ID
 * @property {number[]} vector - The embedding vector
 * @property {Object} metadata - The metadata
 */

/**
 * Supported similarity search methods.
 * @readonly
 * @enum {string}
 */
export const SIMILARITY_METHODS = {
    COSINE: 'cosine',
    L2: 'l2',
    INNER_PRODUCT: 'inner_product',
};

/**
 * Supported vector storage engines.
 * @readonly
 * @enum {string}
 */
export const VECTOR_ENGINES = {
    VECTRA: 'vectra',
    PGLITE: 'pglite',
};

/**
 * @interface IVectorStore
 * @description Interface that all vector storage backends must implement.
 * Based on the vectra LocalIndex API for backward compatibility.
 */

/**
 * @typedef {Object} IVectorStore
 * @property {() => Promise<boolean>} isIndexCreated - Checks if the index/collection has been created
 * @property {() => Promise<void>} createIndex - Creates the index/collection
 * @property {() => Promise<void>} deleteIndex - Deletes the index/collection entirely
 * @property {() => Promise<void>} beginUpdate - Begins a batch update transaction
 * @property {() => Promise<void>} endUpdate - Commits a batch update transaction
 * @property {(item: VectorItem) => Promise<void>} upsertItem - Inserts or updates a vector item
 * @property {(id: string) => Promise<void>} deleteItem - Deletes a vector item by ID
 * @property {(vector: number[], topK: number, similarityMethod?: string) => Promise<VectorQueryResult[]>} queryItems - Queries items by vector similarity
 * @property {() => Promise<VectorListItem[]>} listItems - Lists all items in the index
 * @property {(filter: Object) => Promise<VectorListItem[]>} listItemsByMetadata - Lists items matching a metadata filter
 * @property {string} folderPath - The path to the index storage
 */

/**
 * Validates that an object implements the IVectorStore interface.
 * @param {Object} store - The object to validate
 * @throws {Error} If the object does not implement all required methods
 */
export function validateVectorStore(store) {
    const requiredMethods = [
        'isIndexCreated',
        'createIndex',
        'deleteIndex',
        'beginUpdate',
        'endUpdate',
        'upsertItem',
        'deleteItem',
        'queryItems',
        'listItems',
        'listItemsByMetadata',
    ];

    for (const method of requiredMethods) {
        if (typeof store[method] !== 'function') {
            throw new Error(`Vector store is missing required method: ${method}`);
        }
    }
}
