// src/services/merkle.ts
import { Level } from 'level'
import { IMT } from '@zk-kit/imt'
import { buildPoseidon } from 'circomlibjs'

// Ağaç derinliği ve default zero value
const TREE_DEPTH = parseInt(process.env.MERKLE_TREE_DEPTH || '20', 10)
const DB_PATH = process.env.DB_PATH || './data/db'
const ZERO_VALUE = BigInt(1)

// LevelDB örneği (JSON encode)
const db = new Level(DB_PATH, { valueEncoding: 'json' })

// IMT instance'ı ve init flag
let tree: IMT | null = null
let initializationPromise: Promise<void> | null = null
let poseidon2Sync: ((inputs: (number | string | bigint)[]) => bigint) | null = null;

// ✅ FIX: Add mutex to prevent race conditions
let addLeafMutex = Promise.resolve();

async function getPoseidon2() {
    if (!poseidon2Sync) {
        const poseidon = await buildPoseidon();
        poseidon2Sync = (inputs: (number | string | bigint)[]) => {
            const bigInts = inputs.map(x => BigInt(x));
            const result = poseidon(bigInts);
            return BigInt(poseidon.F.toString(result));
        };
    }
    return poseidon2Sync;
}

/**
 * 1) Ağaç örneğini yaratır,
 * 2) DB'den daha önce eklenen yaprakları yükler.
 */
async function initTree() {
    if (tree) return // Already initialized

    if (initializationPromise) {
        await initializationPromise;
        return;
    }

    initializationPromise = (async () => {
        try {
            // Yeni IMT (hashFn=poseidon2, depth, zero, arity=2)
            const poseidon2 = await getPoseidon2();
            tree = new IMT(poseidon2, TREE_DEPTH, ZERO_VALUE, 2)

            // DB'den kayıtlı yaprak sayısı
            const leafCount = parseInt(await db.get('leafCount').catch(() => '0'))
            for (let i = 0; i < leafCount; i++) {
                const leafStr = (await db.get(`leaf:${i}`)).toString()
                tree.insert(BigInt(leafStr))
            }
        } catch (error) {
            console.error('Failed to initialize tree:', error);
            throw error;
        }
    })();

    await initializationPromise;
}

/**
 * Yeni yaprak ekler ve indeksi döner.
 */
export async function addLeaf(leafHash: bigint): Promise<number> {
    // ✅ FIX: Use mutex to prevent race conditions
    return new Promise((resolve, reject) => {
        addLeafMutex = addLeafMutex.then(async () => {
            try {
                await initTree()
                if (!tree) {
                    throw new Error('Tree not initialized');
                }

                const count = parseInt(await db.get('leafCount').catch(() => '0'), 10);

                // Ağaç'a ekle
                tree.insert(leafHash)

                // DB'yi güncelle
                await db.put('leafCount', (count + 1).toString())
                await db.put(`leaf:${count}`, leafHash.toString())
                await db.put('root', tree.root.toString())

                resolve(count);
            } catch (error) {
                reject(error);
            }
        });
    });
}

/**
 * Belirli bir indeksteki yaprak için Merkle proof üretir.
 */
export async function generateProof(index: number) {
    await initTree()
    if (!tree) {
        throw new Error('Tree not initialized');
    }

    // ✅ FIX MIN_4: Use database leafCount instead of tree.leaves.length
    const leafCount = parseInt(await db.get('leafCount').catch(() => '0'), 10);
    if (index < 0 || index >= leafCount) {
        throw new Error('Invalid leaf index')
    }

    const proof = tree.createProof(index)
    return {
        root: tree.root.toString(),
        siblings: proof.siblings.map((s: any) => s.toString()),
        pathIndices: proof.pathIndices
    }
}

/**
 * Şu anki Merkle root'unu döner.
 */
export async function getRoot(): Promise<string> {
    await initTree()
    if (!tree) {
        throw new Error('Tree not initialized');
    }
    return tree.root.toString()
}

// Group interface
export interface StoredGroup {
    id: string;
    members: string[];
    root: string;
    depth: number;
    created: number;
}

// =============================================================================
// GROUP PERSISTENCE FUNCTIONS
// =============================================================================

/**
 * Save group to database
 */
export async function saveGroup(groupId: string, groupData: StoredGroup): Promise<void> {
    try {
        // Save individual group
        await db.put(`group:${groupId}`, JSON.stringify(groupData));

        // Update group list
        const groupList = await getAllGroupIds();
        if (!groupList.includes(groupId)) {
            groupList.push(groupId);
            await db.put('groups', JSON.stringify(groupList));
        }
    } catch (error) {
        console.error('Failed to save group:', error);
        throw error;
    }
}

/**
 * Get group from database
 */
export async function getGroup(groupId: string): Promise<StoredGroup | null> {
    try {
        const groupData = await db.get(`group:${groupId}`);
        return JSON.parse(groupData) as StoredGroup;
    } catch (error) {
        return null;
    }
}

/**
 * Get all group IDs
 */
export async function getAllGroupIds(): Promise<string[]> {
    try {
        const groupList = await db.get('groups');
        return JSON.parse(groupList) as string[];
    } catch (error) {
        return [];
    }
}

/**
 * Get all groups
 */
export async function getAllGroups(): Promise<StoredGroup[]> {
    try {
        const groupIds = await getAllGroupIds();
        const groups: StoredGroup[] = [];

        for (const groupId of groupIds) {
            const group = await getGroup(groupId);
            if (group) {
                groups.push(group);
            }
        }

        return groups;
    } catch (error) {
        console.error('Failed to get all groups:', error);
        return [];
    }
}

/**
 * Delete group from database
 */
export async function deleteGroup(groupId: string): Promise<boolean> {
    try {
        await db.del(`group:${groupId}`);

        // Update group list
        const groupList = await getAllGroupIds();
        const newGroupList = groupList.filter(id => id !== groupId);
        await db.put('groups', JSON.stringify(newGroupList));

        return true;
    } catch (error) {
        console.error('Failed to delete group:', error);
        return false;
    }
}
