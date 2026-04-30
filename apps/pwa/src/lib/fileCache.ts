// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Two-tier cache for `files:read` responses.
 *
 *   L1 — in-memory `Map` LRU, ~50 MB cap. Lives for the page lifetime.
 *        Hot path for "open the same file twice" / images that re-render.
 *   L2 — IndexedDB (`quicksave-file-cache`, separate from the secrets DB),
 *        ~100 MB cap. Survives reload. LRU-evicted by `lastAccessAt`.
 *
 * Cache key fingerprint: `${cwd}\0${path}\0${maxBytes ?? ''}\0${allowImage}`
 * — same input → same cached output. No content hash because the agent
 * already returns `mtime`+`size` in metadata; for our use case (file
 * viewer opening the same path repeatedly within a session) the input
 * fingerprint is the natural cache key. Cross-session invalidation is
 * coarse: cached entries are returned even if the file changed on disk
 * since the last read. Callers that know about a write should call
 * `invalidateFileCache(cwd, path)` to flush.
 *
 * This cache is sized large but is best-effort: every L2 path is wrapped
 * in try/catch so an IDB failure (locked DB, browser quota, private
 * mode) downgrades silently to L1-only. Failures here MUST NOT break
 * `files:read`.
 */

import type {
  FilesReadRequestPayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';

const DB_NAME = 'quicksave-file-cache';
const DB_VERSION = 1;
const STORE = 'entries';

const L1_MAX_BYTES = 50 * 1024 * 1024;
const L2_MAX_BYTES = 100 * 1024 * 1024;

interface CacheEntry {
  /** Composite key — also stored as keyPath for IDB. */
  key: string;
  res: FilesReadResponsePayload;
  /** Approximate byte cost (response content length + small overhead). */
  bytes: number;
  /** ms since epoch — drives LRU eviction in both layers. */
  lastAccessAt: number;
}

// ---------------------------------------------------------------------------
// L1
// ---------------------------------------------------------------------------

const l1 = new Map<string, CacheEntry>();
let l1Bytes = 0;

function l1Get(key: string): CacheEntry | undefined {
  const hit = l1.get(key);
  if (!hit) return undefined;
  // Re-insert to refresh LRU order — Map iteration is in insertion order,
  // so the oldest entry is whatever .keys().next() yields.
  l1.delete(key);
  hit.lastAccessAt = Date.now();
  l1.set(key, hit);
  return hit;
}

function l1Set(entry: CacheEntry): void {
  const prev = l1.get(entry.key);
  if (prev) {
    l1Bytes -= prev.bytes;
    l1.delete(entry.key);
  }
  l1.set(entry.key, entry);
  l1Bytes += entry.bytes;
  while (l1Bytes > L1_MAX_BYTES && l1.size > 0) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    const e = l1.get(oldest);
    if (e) l1Bytes -= e.bytes;
    l1.delete(oldest);
  }
}

function l1Delete(prefix: string): void {
  for (const k of Array.from(l1.keys())) {
    if (k.startsWith(prefix)) {
      const e = l1.get(k);
      if (e) l1Bytes -= e.bytes;
      l1.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// L2 (IndexedDB)
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        // Indexed so we can later switch eviction to a cursor scan if
        // getAll() becomes too expensive.
        store.createIndex('lastAccessAt', 'lastAccessAt');
      }
    };
    req.onerror = () => reject(req.error ?? new Error('open failed'));
    req.onsuccess = () => resolve(req.result);
  });
  // Reset on failure so a later attempt can retry instead of getting
  // stuck on a permanent rejection.
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  dbPromise = p;
  return p;
}

async function l2Get(key: string): Promise<CacheEntry | undefined> {
  try {
    const db = await openDb();
    return await new Promise<CacheEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
      req.onerror = () => reject(req.error ?? new Error('l2 get failed'));
    });
  } catch {
    return undefined;
  }
}

async function l2Touch(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const get = store.get(key);
      get.onsuccess = () => {
        const entry = get.result as CacheEntry | undefined;
        if (!entry) {
          resolve();
          return;
        }
        entry.lastAccessAt = Date.now();
        const put = store.put(entry);
        put.onsuccess = () => resolve();
        put.onerror = () => reject(put.error ?? new Error('touch put failed'));
      };
      get.onerror = () => reject(get.error ?? new Error('touch get failed'));
    });
  } catch {
    /* best effort */
  }
}

async function l2Set(entry: CacheEntry): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('l2 put failed'));
    });
    await l2EnforceCap();
  } catch {
    /* best effort */
  }
}

async function l2EnforceCap(): Promise<void> {
  try {
    const db = await openDb();
    const all = await new Promise<CacheEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as CacheEntry[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error('l2 getAll failed'));
    });
    let total = 0;
    for (const e of all) total += e.bytes;
    if (total <= L2_MAX_BYTES) return;
    all.sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of all) {
        if (total <= L2_MAX_BYTES) break;
        store.delete(e.key);
        total -= e.bytes;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('l2 evict tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('l2 evict aborted'));
    });
  } catch {
    /* best effort */
  }
}

async function l2DeletePrefix(prefix: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const cur = tx.objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const cursor = cur.result;
        if (!cursor) {
          resolve();
          return;
        }
        const k = cursor.key as string;
        if (typeof k === 'string' && k.startsWith(prefix)) cursor.delete();
        cursor.continue();
      };
      cur.onerror = () => reject(cur.error ?? new Error('l2 cursor failed'));
    });
  } catch {
    /* best effort */
  }
}

async function l2Clear(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('clear failed'));
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function cacheKeyFor(req: FilesReadRequestPayload): string {
  return `${req.cwd} ${req.path} ${req.maxBytes ?? ''} ${req.allowImage ? '1' : '0'}`;
}

/** Approximate byte cost of a cached response — drives LRU eviction.
 *  String content's `length` is char count (≈ bytes for ASCII / base64);
 *  exact bytes don't matter, only the relative size signal does. */
export function entryBytesOf(res: FilesReadResponsePayload): number {
  const contentLen = typeof res.content === 'string' ? res.content.length : 0;
  return contentLen + 256;
}

/**
 * Read with both cache layers wrapped around the network fetcher.
 * Successful responses populate L1 (sync) and L2 (fire-and-forget).
 * Failures (success: false) are NOT cached — re-asking the agent later
 * gives errors a chance to clear up.
 */
export async function readWithCache(
  req: FilesReadRequestPayload,
  fetcher: (req: FilesReadRequestPayload) => Promise<FilesReadResponsePayload>,
): Promise<FilesReadResponsePayload> {
  const key = cacheKeyFor(req);

  const hot = l1Get(key);
  if (hot) return hot.res;

  const warm = await l2Get(key);
  if (warm) {
    l1Set({ ...warm, lastAccessAt: Date.now() });
    void l2Touch(key);
    return warm.res;
  }

  const res = await fetcher(req);
  if (res.success) {
    const entry: CacheEntry = {
      key,
      res,
      bytes: entryBytesOf(res),
      lastAccessAt: Date.now(),
    };
    l1Set(entry);
    void l2Set(entry);
  }
  return res;
}

/** Drop every cached entry for a specific (cwd, path) — across all
 *  maxBytes/allowImage variants. Call after a write you can attribute to
 *  a known file. */
export function invalidateFileCache(cwd: string, path: string): void {
  const prefix = `${cwd} ${path} `;
  l1Delete(prefix);
  void l2DeletePrefix(prefix);
}

/** Drop everything. Use sparingly — e.g., on session switch when paths
 *  may collide across cwds, or for a manual "refresh" UI affordance. */
export function clearFileCache(): void {
  l1.clear();
  l1Bytes = 0;
  void l2Clear();
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export function _resetFileCacheForTest(): void {
  l1.clear();
  l1Bytes = 0;
  dbPromise = null;
}

export function _l1StatsForTest(): { count: number; bytes: number } {
  return { count: l1.size, bytes: l1Bytes };
}
