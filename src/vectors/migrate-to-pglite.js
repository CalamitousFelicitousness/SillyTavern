/**
 * @module migrate-to-pglite
 * @description Migration logic from vectra to pglite vector storage.
 * This module is kept dormant and should be activated in a future release.
 */

import path from 'node:path';
import fs from 'node:fs';

import sanitize from 'sanitize-filename';

import { VectraStore } from './vectra-store.js';
import { PGLiteStore, closeAllInstances } from './pglite-store.js';

/**
 * @typedef {Object} MigrationResult
 * @property {number} totalCollections - Number of collections found
 * @property {number} migratedCollections - Number of collections successfully migrated
 * @property {number} totalItems - Total number of items migrated
 * @property {string[]} errors - Error messages for failed migrations
 */

/**
 * Migrates all vector collections from vectra to pglite.
 * Scans the vectors directory for all sources, collections, and models.
 *
 * @param {string} vectorsDir - The root vectors directory (e.g., user_data/vectors/)
 * @param {string[]} sources - The list of embedding sources to scan
 * @returns {Promise<MigrationResult>}
 */
export async function migrateVectraToPglite(vectorsDir, sources) {
    /** @type {MigrationResult} */
    const result = {
        totalCollections: 0,
        migratedCollections: 0,
        totalItems: 0,
        errors: [],
    };

    for (const source of sources) {
        const sourcePath = path.join(vectorsDir, sanitize(source));

        if (!fs.existsSync(sourcePath)) {
            continue;
        }

        const collections = await fs.promises.readdir(sourcePath, { withFileTypes: true });

        for (const collectionEntry of collections) {
            if (!collectionEntry.isDirectory()) {
                continue;
            }

            const collectionId = collectionEntry.name;
            const collectionPath = path.join(sourcePath, collectionId);

            const models = await fs.promises.readdir(collectionPath, { withFileTypes: true });

            for (const modelEntry of models) {
                if (!modelEntry.isDirectory()) {
                    continue;
                }

                const model = modelEntry.name;
                const indexPath = path.join(collectionPath, model);

                result.totalCollections++;

                try {
                    const itemCount = await migrateCollection(indexPath);
                    result.migratedCollections++;
                    result.totalItems += itemCount;
                    console.info(`Migrated collection ${source}/${collectionId}/${model}: ${itemCount} items`);
                } catch (error) {
                    const errorMsg = `Failed to migrate ${source}/${collectionId}/${model}: ${error.message}`;
                    result.errors.push(errorMsg);
                    console.error(errorMsg);
                }
            }
        }
    }

    await closeAllInstances();
    return result;
}

/**
 * Migrates a single collection from vectra to pglite.
 *
 * @param {string} indexPath - The path to the vectra index directory
 * @returns {Promise<number>} The number of items migrated
 */
export async function migrateCollection(indexPath) {
    const vectraStore = new VectraStore(indexPath);

    if (!await vectraStore.isIndexCreated()) {
        return 0;
    }

    const pgliteStore = new PGLiteStore(indexPath);
    const pgliteAlreadyExists = await pgliteStore.isIndexCreated();

    if (pgliteAlreadyExists) {
        // Check if there are already items in pglite
        const existingItems = await pgliteStore.listItems();
        if (existingItems.length > 0) {
            // Already migrated, skip
            return 0;
        }
    }

    await pgliteStore.createIndex();

    const items = await vectraStore.listItems();
    if (items.length === 0) {
        return 0;
    }

    await pgliteStore.beginUpdate();

    for (const item of items) {
        await pgliteStore.upsertItem({
            vector: item.vector,
            metadata: item.metadata,
        });
    }

    await pgliteStore.endUpdate();

    return items.length;
}
