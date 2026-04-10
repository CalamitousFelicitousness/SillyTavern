/**
 * @module pglite-store
 * @description PGlite-based implementation of the IVectorStore interface.
 * Uses PGlite with pgvector extension for vector similarity search,
 * stored in a local file-based database.
 */

import path from 'node:path';
import fs from 'node:fs';

import { SIMILARITY_METHODS } from './vector-store.js';

/** @type {Map<string, import('@electric-sql/pglite').PGlite>} */
const instanceCache = new Map();

/**
 * Gets or creates a PGlite instance for the given database path.
 * PGlite instances are cached to avoid re-opening the same database.
 * @param {string} dbPath - The directory path for the database
 * @returns {Promise<import('@electric-sql/pglite').PGlite>}
 */
async function getOrCreateInstance(dbPath) {
    if (instanceCache.has(dbPath)) {
        return instanceCache.get(dbPath);
    }

    // Dynamic import to avoid issues with top-level ESM module resolution
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector');

    fs.mkdirSync(dbPath, { recursive: true });

    const db = await PGlite.create({
        dataDir: dbPath,
        extensions: { vector },
    });

    await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
    instanceCache.set(dbPath, db);
    return db;
}

/**
 * Closes and removes a cached PGlite instance.
 * @param {string} dbPath - The database path
 */
async function closeInstance(dbPath) {
    const db = instanceCache.get(dbPath);
    if (db) {
        await db.close();
        instanceCache.delete(dbPath);
    }
}

/**
 * Closes all cached PGlite instances. Useful for cleanup.
 */
export async function closeAllInstances() {
    for (const [dbPath, db] of instanceCache) {
        await db.close();
        instanceCache.delete(dbPath);
    }
}

/**
 * Table name used for storing vectors within each PGlite database.
 */
const VECTORS_TABLE = 'vectors';

/**
 * PGlite-based vector store that mimics the vectra LocalIndex API.
 * Each collection maps to a separate PGlite database directory.
 * @implements {import('./vector-store.js').IVectorStore}
 */
export class PGLiteStore {
    /**
     * @param {string} folderPath - Path to the directory for storing the PGlite database
     */
    constructor(folderPath) {
        this.folderPath = folderPath;
        /** @type {string} */
        this._dbPath = path.join(folderPath, 'pglite_data');
        /** @type {import('@electric-sql/pglite').PGlite | null} */
        this._db = null;
        /** @type {boolean} */
        this._inTransaction = false;
        /** @type {number | null} */
        this._vectorDimension = null;
    }

    /**
     * Gets the PGlite database instance, creating it if necessary.
     * @returns {Promise<import('@electric-sql/pglite').PGlite>}
     */
    async _getDb() {
        if (!this._db) {
            this._db = await getOrCreateInstance(this._dbPath);
        }
        return this._db;
    }

    /**
     * Detects the vector dimension from existing data or a provided vector.
     * @param {number[]} [sampleVector] - An optional sample vector to detect dimension
     * @returns {Promise<number>} The vector dimension
     */
    async _getVectorDimension(sampleVector) {
        if (this._vectorDimension) {
            return this._vectorDimension;
        }

        if (sampleVector) {
            this._vectorDimension = sampleVector.length;
            return this._vectorDimension;
        }

        const db = await this._getDb();
        const result = await db.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = '${VECTORS_TABLE}' AND column_name = 'embedding'`,
        );

        if (result.rows.length > 0) {
            // Try to get dimension from existing data
            const dimResult = await db.query(`SELECT vector_dims(embedding) as dim FROM ${VECTORS_TABLE} LIMIT 1`);
            if (dimResult.rows.length > 0) {
                this._vectorDimension = Number(dimResult.rows[0].dim);
            }
        }

        return this._vectorDimension || 0;
    }

    /**
     * Ensures the vectors table exists with the correct dimension.
     * @param {number} dimension - The vector dimension
     * @returns {Promise<void>}
     */
    async _ensureTable(dimension) {
        const db = await this._getDb();
        await db.exec(`
            CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
                id TEXT PRIMARY KEY,
                embedding vector(${dimension}),
                metadata JSONB NOT NULL DEFAULT '{}'
            );
        `);
    }

    /**
     * Checks if the index has been created.
     * @returns {Promise<boolean>}
     */
    async isIndexCreated() {
        try {
            const db = await this._getDb();
            const result = await db.query(
                `SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = '${VECTORS_TABLE}'
                ) AS table_exists`,
            );
            return result.rows[0]?.table_exists === true;
        } catch {
            return false;
        }
    }

    /**
     * Creates the index. For PGlite, the table is created lazily on first upsert
     * since we need to know the vector dimension.
     * @returns {Promise<void>}
     */
    async createIndex() {
        // Table creation is deferred until we know the vector dimension
        await this._getDb();
    }

    /**
     * Deletes the index entirely.
     * @returns {Promise<void>}
     */
    async deleteIndex() {
        await closeInstance(this._dbPath);
        this._db = null;
        this._vectorDimension = null;

        if (fs.existsSync(this._dbPath)) {
            await fs.promises.rm(this._dbPath, { recursive: true });
        }
    }

    /**
     * Begins a batch update transaction.
     * @returns {Promise<void>}
     */
    async beginUpdate() {
        this._inTransaction = true;
    }

    /**
     * Commits a batch update transaction.
     * @returns {Promise<void>}
     */
    async endUpdate() {
        this._inTransaction = false;
    }

    /**
     * Generates a unique ID for a vector item based on its metadata hash.
     * @param {Object} metadata - The item metadata
     * @returns {string} A unique ID
     */
    _generateId(metadata) {
        if (metadata && metadata.hash !== undefined) {
            return `item_${metadata.hash}`;
        }
        return `item_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * Formats a vector array as a pgvector string literal.
     * @param {number[]} vector - The vector to format
     * @returns {string} The formatted vector string, e.g. "[1,2,3]"
     */
    _formatVector(vector) {
        return `[${vector.join(',')}]`;
    }

    /**
     * Inserts or updates a vector item.
     * @param {import('./vector-store.js').VectorItem} item
     * @returns {Promise<void>}
     */
    async upsertItem(item) {
        const dimension = await this._getVectorDimension(item.vector);
        await this._ensureTable(dimension);
        const db = await this._getDb();
        const id = this._generateId(item.metadata);
        const vectorStr = this._formatVector(item.vector);

        await db.query(
            `INSERT INTO ${VECTORS_TABLE} (id, embedding, metadata)
             VALUES ($1, $2::vector, $3::jsonb)
             ON CONFLICT (id) DO UPDATE SET embedding = $2::vector, metadata = $3::jsonb`,
            [id, vectorStr, JSON.stringify(item.metadata)],
        );
    }

    /**
     * Deletes a vector item by ID.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async deleteItem(id) {
        const db = await this._getDb();
        await db.query(`DELETE FROM ${VECTORS_TABLE} WHERE id = $1`, [id]);
    }

    /**
     * Returns the pgvector distance operator for the given similarity method.
     * @param {string} similarityMethod - The similarity method
     * @returns {{ operator: string, orderDirection: string, scoreTransform: (val: number) => number }}
     */
    _getDistanceConfig(similarityMethod) {
        switch (similarityMethod) {
            case SIMILARITY_METHODS.L2:
                return {
                    operator: '<->',
                    orderDirection: 'ASC',
                    // Convert L2 distance to a 0-1 similarity score
                    scoreTransform: (val) => 1 / (1 + val),
                };
            case SIMILARITY_METHODS.INNER_PRODUCT:
                return {
                    operator: '<#>',
                    orderDirection: 'ASC',
                    // pgvector returns negative inner product for ordering; negate to get actual IP
                    scoreTransform: (val) => -val,
                };
            case SIMILARITY_METHODS.COSINE:
            default:
                return {
                    operator: '<=>',
                    orderDirection: 'ASC',
                    // Convert cosine distance to cosine similarity
                    scoreTransform: (val) => 1 - val,
                };
        }
    }

    /**
     * Queries items by vector similarity.
     * @param {number[]} vector - The query vector
     * @param {number} topK - Number of results to return
     * @param {string} [similarityMethod] - The similarity method (cosine, l2, inner_product)
     * @returns {Promise<import('./vector-store.js').VectorQueryResult[]>}
     */
    async queryItems(vector, topK, similarityMethod) {
        const isCreated = await this.isIndexCreated();
        if (!isCreated) {
            return [];
        }

        const db = await this._getDb();
        const vectorStr = this._formatVector(vector);
        const method = similarityMethod || SIMILARITY_METHODS.COSINE;
        const { operator, orderDirection, scoreTransform } = this._getDistanceConfig(method);

        const result = await db.query(
            `SELECT id, embedding::text, metadata, (embedding ${operator} $1::vector) AS distance
             FROM ${VECTORS_TABLE}
             ORDER BY embedding ${operator} $1::vector ${orderDirection}
             LIMIT $2`,
            [vectorStr, topK],
        );

        return result.rows.map(row => ({
            score: scoreTransform(Number(row.distance)),
            item: {
                id: row.id,
                vector: this._parseVector(row.embedding),
                metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
            },
        }));
    }

    /**
     * Parses a pgvector string representation back to a number array.
     * @param {string} vectorStr - The vector string, e.g. "[1,2,3]"
     * @returns {number[]}
     */
    _parseVector(vectorStr) {
        if (!vectorStr) return [];
        const cleaned = vectorStr.replace(/^\[|\]$/g, '');
        return cleaned.split(',').map(Number);
    }

    /**
     * Lists all items in the index.
     * @returns {Promise<import('./vector-store.js').VectorListItem[]>}
     */
    async listItems() {
        const isCreated = await this.isIndexCreated();
        if (!isCreated) {
            return [];
        }

        const db = await this._getDb();
        const result = await db.query(`SELECT id, embedding::text, metadata FROM ${VECTORS_TABLE}`);

        return result.rows.map(row => ({
            id: row.id,
            vector: this._parseVector(row.embedding),
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        }));
    }

    /**
     * Lists items matching a metadata filter.
     * Supports vectra-compatible filter syntax: { hash: { '$in': [1, 2, 3] } }
     * @param {Object} filter - Metadata filter
     * @returns {Promise<import('./vector-store.js').VectorListItem[]>}
     */
    async listItemsByMetadata(filter) {
        const isCreated = await this.isIndexCreated();
        if (!isCreated) {
            return [];
        }

        const db = await this._getDb();
        const { whereClause, params } = this._buildWhereClause(filter);

        const result = await db.query(
            `SELECT id, embedding::text, metadata FROM ${VECTORS_TABLE} WHERE ${whereClause}`,
            params,
        );

        return result.rows.map(row => ({
            id: row.id,
            vector: this._parseVector(row.embedding),
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        }));
    }

    /**
     * Builds a SQL WHERE clause from a vectra-compatible metadata filter.
     * @param {Object} filter - The metadata filter
     * @returns {{ whereClause: string, params: any[] }}
     */
    _buildWhereClause(filter) {
        const conditions = [];
        const params = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(filter)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // Handle operators like { '$in': [...] }
                for (const [op, operand] of Object.entries(value)) {
                    if (op === '$in' && Array.isArray(operand)) {
                        const placeholders = operand.map(() => {
                            params.push(JSON.stringify(operand[paramIndex - params.length - 1 + params.length]));
                            return `$${paramIndex++}`;
                        });
                        // Reset and do it properly
                        params.length -= placeholders.length;
                        paramIndex -= placeholders.length;

                        const inPlaceholders = [];
                        for (const val of operand) {
                            params.push(JSON.stringify(val));
                            inPlaceholders.push(`$${paramIndex++}`);
                        }
                        conditions.push(`(metadata->>'${key}')::text IN (${inPlaceholders.join(', ')})`);
                    } else if (op === '$eq') {
                        params.push(JSON.stringify(operand));
                        conditions.push(`(metadata->>'${key}')::text = $${paramIndex++}`);
                    }
                }
            } else {
                // Direct equality
                params.push(JSON.stringify(value));
                conditions.push(`(metadata->>'${key}')::text = $${paramIndex++}`);
            }
        }

        return {
            whereClause: conditions.length > 0 ? conditions.join(' AND ') : '1=1',
            params,
        };
    }
}
