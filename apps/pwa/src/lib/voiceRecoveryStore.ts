// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Durable, per-composer recordings that could not yet be transcribed.
 *
 * This is deliberately not built on blobCache: a cache may be LRU-evicted or
 * silently unavailable, whereas a recovery recording must be surfaced to the
 * user until it is successfully transcribed or explicitly discarded.
 */

export type VoiceRecoveryKind = 'streaming-pcm' | 'batch-blob';

export interface VoiceRecoveryDraft {
  id: string;
  composerKey: string;
  kind: VoiceRecoveryKind;
  audio: Blob;
  sampleRate?: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export type VoiceRecoverySummary = Omit<VoiceRecoveryDraft, 'audio'> & { bytes: number };

const DB_NAME = 'quicksave-voice-recovery';
const DB_VERSION = 1;
const STORE = 'drafts';
const BY_COMPOSER = 'byComposer';

// IndexedDB is unavailable in SSR, private browsing on some browsers, and
// jsdom. Keeping an in-memory fallback still lets the current tab offer retry;
// callers must not advertise it as durable when their write rejects.
const memoryFallback = new Map<string, VoiceRecoveryDraft>();

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Could not open voice recovery storage.'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' });
      if (!store.indexNames.contains(BY_COMPOSER)) store.createIndex(BY_COMPOSER, 'composerKey');
    };
  });
}

function summary(draft: VoiceRecoveryDraft): VoiceRecoverySummary {
  const { audio, ...rest } = draft;
  return { ...rest, bytes: audio.size };
}

export async function saveVoiceRecoveryDraft(draft: VoiceRecoveryDraft): Promise<void> {
  memoryFallback.set(draft.id, draft);
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const request = tx.objectStore(STORE).put(draft);
      request.onerror = () => reject(request.error ?? new Error('Could not save voice recovery recording.'));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Could not save voice recovery recording.'));
    });
  } finally {
    db.close();
  }
}

export async function listVoiceRecoveryDrafts(composerKey: string): Promise<VoiceRecoverySummary[]> {
  try {
    const db = await openDb();
    try {
      const drafts = await new Promise<VoiceRecoveryDraft[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).index(BY_COMPOSER).getAll(composerKey);
        request.onsuccess = () => resolve((request.result as VoiceRecoveryDraft[] | undefined) ?? []);
        request.onerror = () => reject(request.error ?? new Error('Could not read voice recovery recordings.'));
      });
      return drafts.sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
    } finally {
      db.close();
    }
  } catch {
    return Array.from(memoryFallback.values())
      .filter((draft) => draft.composerKey === composerKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summary);
  }
}

export async function getVoiceRecoveryDraft(id: string): Promise<VoiceRecoveryDraft | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<VoiceRecoveryDraft | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(id);
        request.onsuccess = () => resolve((request.result as VoiceRecoveryDraft | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error('Could not read voice recovery recording.'));
      });
    } finally {
      db.close();
    }
  } catch {
    return memoryFallback.get(id) ?? null;
  }
}

export async function removeVoiceRecoveryDraft(id: string): Promise<void> {
  memoryFallback.delete(id);
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const request = tx.objectStore(STORE).delete(id);
        request.onerror = () => reject(request.error ?? new Error('Could not delete voice recovery recording.'));
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Could not delete voice recovery recording.'));
      });
    } finally {
      db.close();
    }
  } catch {
    // The memory copy was already removed. A later read will still be able to
    // reveal a persisted record if the browser comes back, which is safer than
    // failing a user-initiated discard silently.
  }
}

export function _resetVoiceRecoveryMemoryForTest(): void {
  memoryFallback.clear();
}
