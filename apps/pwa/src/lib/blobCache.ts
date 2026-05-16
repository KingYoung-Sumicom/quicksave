// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Generic two-tier blob cache.
 *
 *   L1 — in-memory `Map` LRU. Lives for the page lifetime.
 *        Hot path for "open the same item twice" / images that re-render.
 *   L2 — IndexedDB store keyed by composite key. Survives reload.
 *        LRU-evicted by `lastAccessAt`.
 *
 * Each `createBlobCache(config)` call owns its own L1 Map and IDB database
 * (separate `dbName` per cache type — no schema migrations needed).
 *
 * The cache is best-effort: every L2 path is wrapped in try/catch so an
 * IDB failure (locked DB, browser quota, private mode) downgrades silently
 * to L1-only. Failures here MUST NOT break the underlying fetcher.
 */

const DB_VERSION = 1;
const STORE = 'entries';

interface CacheEntry<Res> {
  /** Composite key — also the IDB keyPath. */
  key: string;
  res: Res;
  /** Approximate byte cost (drives LRU eviction). */
  bytes: number;
  /** ms since epoch — drives LRU eviction in both layers. */
  lastAccessAt: number;
}

export interface BlobCacheConfig<Req, Res> {
  /** Distinct IndexedDB name per cache type. */
  dbName: string;
  /** L1 byte cap (hot in-memory). */
  l1MaxBytes: number;
  /** L2 byte cap (persisted IDB). */
  l2MaxBytes: number;
  /** Map a request to a stable composite cache key. */
  keyFn: (req: Req) => string;
  /** Approximate byte cost of one cached response — drives LRU eviction. */
  bytesFn: (res: Res) => number;
  /** Whether a response should populate the cache (e.g. skip failures). */
  shouldCache: (res: Res) => boolean;
}

export interface BlobCache<Req, Res> {
  /** Read with both cache layers wrapped around the network fetcher. */
  read(req: Req, fetcher: (req: Req) => Promise<Res>): Promise<Res>;
  /** Lookup-only: return a cached entry without touching the network, but
   *  DO refresh LRU position on hit (so a peek-then-revalidate flow is
   *  treated as a real access). Returns undefined on miss. */
  peek(req: Req): Promise<Res | undefined>;
  /** Inject a known-good entry (e.g. populated from local upload bytes the
   *  PWA already has). Same caching effect as a successful read. */
  prime(req: Req, res: Res): void;
  /** Drop every cached entry whose key starts with `prefix`. */
  invalidatePrefix(prefix: string): void;
  /** Drop everything in this cache. */
  clear(): void;
  // Test hooks
  _resetForTest(): void;
  _l1Stats(): { count: number; bytes: number };
}

export function createBlobCache<Req, Res>(config: BlobCacheConfig<Req, Res>): BlobCache<Req, Res> {
  const { dbName, l1MaxBytes, l2MaxBytes, keyFn, bytesFn, shouldCache } = config;

  // ── L1 ────────────────────────────────────────────────────────────────
  const l1 = new Map<string, CacheEntry<Res>>();
  let l1Bytes = 0;

  function l1Get(key: string): CacheEntry<Res> | undefined {
    const hit = l1.get(key);
    if (!hit) return undefined;
    // Refresh LRU position by re-inserting.
    l1.delete(key);
    hit.lastAccessAt = Date.now();
    l1.set(key, hit);
    return hit;
  }

  function l1Set(entry: CacheEntry<Res>): void {
    const prev = l1.get(entry.key);
    if (prev) {
      l1Bytes -= prev.bytes;
      l1.delete(entry.key);
    }
    l1.set(entry.key, entry);
    l1Bytes += entry.bytes;
    while (l1Bytes > l1MaxBytes && l1.size > 0) {
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

  // ── L2 (IndexedDB) ───────────────────────────────────────────────────
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('IndexedDB unavailable'));
    }
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('lastAccessAt', 'lastAccessAt');
        }
      };
      req.onerror = () => reject(req.error ?? new Error('open failed'));
      req.onsuccess = () => resolve(req.result);
    });
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
    dbPromise = p;
    return p;
  }

  async function l2Get(key: string): Promise<CacheEntry<Res> | undefined> {
    try {
      const db = await openDb();
      return await new Promise<CacheEntry<Res> | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as CacheEntry<Res> | undefined);
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
          const entry = get.result as CacheEntry<Res> | undefined;
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

  async function l2Set(entry: CacheEntry<Res>): Promise<void> {
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
      const all = await new Promise<CacheEntry<Res>[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result as CacheEntry<Res>[]) ?? []);
        req.onerror = () => reject(req.error ?? new Error('l2 getAll failed'));
      });
      let total = 0;
      for (const e of all) total += e.bytes;
      if (total <= l2MaxBytes) return;
      all.sort((a, b) => a.lastAccessAt - b.lastAccessAt);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const e of all) {
          if (total <= l2MaxBytes) break;
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

  // ── Public API ───────────────────────────────────────────────────────

  async function read(req: Req, fetcher: (req: Req) => Promise<Res>): Promise<Res> {
    const key = keyFn(req);

    const hot = l1Get(key);
    if (hot) return hot.res;

    const warm = await l2Get(key);
    if (warm) {
      l1Set({ ...warm, lastAccessAt: Date.now() });
      void l2Touch(key);
      return warm.res;
    }

    const res = await fetcher(req);
    if (shouldCache(res)) {
      const entry: CacheEntry<Res> = {
        key,
        res,
        bytes: bytesFn(res),
        lastAccessAt: Date.now(),
      };
      l1Set(entry);
      void l2Set(entry);
    }
    return res;
  }

  async function peek(req: Req): Promise<Res | undefined> {
    const key = keyFn(req);
    const hot = l1Get(key);
    if (hot) return hot.res;
    const warm = await l2Get(key);
    if (warm) {
      l1Set({ ...warm, lastAccessAt: Date.now() });
      void l2Touch(key);
      return warm.res;
    }
    return undefined;
  }

  function prime(req: Req, res: Res): void {
    if (!shouldCache(res)) return;
    const key = keyFn(req);
    const entry: CacheEntry<Res> = {
      key,
      res,
      bytes: bytesFn(res),
      lastAccessAt: Date.now(),
    };
    l1Set(entry);
    void l2Set(entry);
  }

  function invalidatePrefix(prefix: string): void {
    l1Delete(prefix);
    void l2DeletePrefix(prefix);
  }

  function clear(): void {
    l1.clear();
    l1Bytes = 0;
    void l2Clear();
  }

  function _resetForTest(): void {
    l1.clear();
    l1Bytes = 0;
    dbPromise = null;
  }

  function _l1Stats(): { count: number; bytes: number } {
    return { count: l1.size, bytes: l1Bytes };
  }

  return { read, peek, prime, invalidatePrefix, clear, _resetForTest, _l1Stats };
}
