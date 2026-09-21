// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

import type { Card, HistorySyncMetadata } from '@sumicom/quicksave-shared';

const DB_NAME = 'quicksave-session-history';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const KEY_PREFIX = 'v1:';
const MAX_RECORDS = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_EVENT = 'clear';
const cacheListeners = new Set<() => void>();
const cacheChannel = typeof BroadcastChannel === 'undefined'
  ? undefined
  : new BroadcastChannel('quicksave-session-history-cache');

export interface SessionHistoryCacheRecord {
  key: string;
  sessionId: string;
  cards: Card[];
  total: number | null;
  hasMore: boolean;
  nextCursor: string | null;
  historySync?: HistorySyncMetadata;
  /** Every server page observed while this record was assembled. */
  coverage?: Array<NonNullable<HistorySyncMetadata['coverage']> & { cachedAt: number }>;
  /** The last card visible when this cache record was written. */
  lastReceivedCard?: {
    id: string;
    timestamp: number;
    turnId?: string;
  };
  /** True when the cached view was captured while a turn was still streaming. */
  hasLiveCards?: boolean;
  /** The cache is a display aid until the next server snapshot validates it. */
  cachedAt: number;
}

function cacheKey(sessionId: string): string {
  // Session ids are globally unique, while the origin keeps browser profiles
  // and local development deployments from sharing records accidentally.
  const origin = typeof location === 'undefined' ? 'unknown' : location.origin;
  return `${KEY_PREFIX}${origin}:${sessionId}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open history cache'));
  });
}

export async function readSessionHistoryCache(sessionId: string): Promise<SessionHistoryCacheRecord | undefined> {
  try {
    const db = await openDatabase();
    const record = await new Promise<SessionHistoryCacheRecord | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(cacheKey(sessionId));
      request.onsuccess = () => resolve(request.result as SessionHistoryCacheRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error('Failed to read history cache'));
    });
    if (record && Date.now() - record.cachedAt > MAX_AGE_MS) {
      await deleteSessionHistoryCache(sessionId);
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

export async function writeSessionHistoryCache(
  sessionId: string,
  value: Omit<SessionHistoryCacheRecord, 'key' | 'sessionId' | 'cachedAt'>,
): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({
        key: cacheKey(sessionId),
        sessionId,
        ...value,
        cachedAt: Date.now(),
      } satisfies SessionHistoryCacheRecord);
      const all = store.getAll();
      all.onsuccess = () => {
        const records = (all.result as SessionHistoryCacheRecord[])
          .sort((a, b) => b.cachedAt - a.cachedAt);
        for (const record of records.slice(MAX_RECORDS)) store.delete(record.key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to write history cache'));
      tx.onabort = () => reject(tx.error ?? new Error('History cache write aborted'));
    });
  } catch {
    // Cache failures must never affect the live session path.
  }
}

export async function clearSessionHistoryCache(): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear history cache'));
    tx.onabort = () => reject(tx.error ?? new Error('History cache clear aborted'));
  });
  for (const listener of cacheListeners) listener();
  cacheChannel?.postMessage({ type: CACHE_EVENT });
}

export function subscribeSessionHistoryCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

if (cacheChannel) {
  cacheChannel.onmessage = (event) => {
    if (event.data?.type !== CACHE_EVENT) return;
    void (async () => {
      try {
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch { /* another tab may have already removed the database */ }
      for (const listener of cacheListeners) listener();
    })();
  };
}

async function deleteSessionHistoryCache(sessionId: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(cacheKey(sessionId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete history cache'));
    tx.onabort = () => reject(tx.error ?? new Error('History cache delete aborted'));
  });
}
