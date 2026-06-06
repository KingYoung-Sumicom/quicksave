// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Secure storage for master secret using IndexedDB.
 *
 * The master secret is a 32-byte random value that never leaves the PWA.
 * It's used to derive session DEKs that are sent (encrypted) to Agents.
 *
 * Security model:
 * - Master secret stored in IndexedDB (browser origin isolation)
 * - Each session gets a fresh random DEK
 * - Agent only receives encrypted DEK, cannot derive new session keys
 * - If Agent is compromised, only current session is exposed
 */

import { encodeBase64, decodeBase64, generateSessionDEK, type VoiceConfig } from '@sumicom/quicksave-shared';

export type { VoiceConfig };

const DB_NAME = 'quicksave-secure';
const DB_VERSION = 1;
const STORE_NAME = 'secrets';
const MASTER_SECRET_KEY = 'master-secret';
const MASTER_SECRET_META_KEY = 'master-secret-meta';
const API_KEY_KEY = 'anthropic-api-key';
const API_KEY_META_KEY = 'anthropic-api-key-meta';
const VOICE_CONFIG_KEY = 'voice-config';
const VOICE_CONFIG_META_KEY = 'voice-config-meta';

interface SecretMeta {
  updatedAt: number;
}

// `VoiceConfig` is defined in @sumicom/quicksave-shared (re-exported above) so
// the same shape flows PWA → agent in the voice:transcribe request. The config
// is persisted here (origin-isolated IndexedDB) and synced via the group
// mailbox so it's configured once and is the single source of truth.

async function putRecord(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new Error(`Failed to write ${key}`));
  });
  db.close();
}

async function getRecord<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`Failed to read ${key}`));
  });
  db.close();
  return result;
}

/**
 * Open or create the IndexedDB database
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open secure storage database'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Check if master secret exists in storage
 */
export async function hasMasterSecret(): Promise<boolean> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(MASTER_SECRET_KEY);

      request.onerror = () => {
        db.close();
        reject(new Error('Failed to check master secret'));
      };

      request.onsuccess = () => {
        db.close();
        resolve(request.result !== undefined);
      };
    });
  } catch {
    return false;
  }
}

/**
 * Get the master secret, generating one if it doesn't exist
 */
export async function getMasterSecret(): Promise<Uint8Array> {
  const db = await openDatabase();

  // Try to get existing secret
  const existing = await new Promise<string | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(MASTER_SECRET_KEY);

    request.onerror = () => {
      reject(new Error('Failed to get master secret'));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });

  if (existing) {
    db.close();
    return decodeBase64(existing);
  }

  // Generate new master secret (32 random bytes)
  const masterSecret = generateSessionDEK();
  const encoded = encodeBase64(masterSecret);

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(encoded, MASTER_SECRET_KEY);

    request.onerror = () => {
      reject(new Error('Failed to store master secret'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });

  db.close();
  // Record generation timestamp so merges order a freshly-generated secret
  // correctly against a remote one.
  await putRecord(MASTER_SECRET_META_KEY, { updatedAt: Date.now() } satisfies SecretMeta);
  console.log('Generated new master secret');
  return masterSecret;
}

/** Returns the master secret with its updatedAt, or null if not set. */
export async function getMasterSecretExport(): Promise<{ value: string; updatedAt: number } | null> {
  const raw = await getRecord<string>(MASTER_SECRET_KEY);
  if (!raw) return null;
  const meta = await getRecord<SecretMeta>(MASTER_SECRET_META_KEY);
  return { value: raw, updatedAt: meta?.updatedAt ?? 0 };
}

/**
 * Apply a remote master secret only if its updatedAt is newer than the local
 * copy. Returns true if local state changed.
 */
export async function applyMasterSecret(value: string, updatedAt: number): Promise<boolean> {
  const existing = await getMasterSecretExport();
  if (existing && existing.updatedAt >= updatedAt && existing.value === value) return false;
  if (existing && existing.updatedAt > updatedAt) return false;
  await putRecord(MASTER_SECRET_KEY, value);
  await putRecord(MASTER_SECRET_META_KEY, { updatedAt } satisfies SecretMeta);
  return true;
}

/**
 * Initialize master secret - gets existing or generates new
 * Call this on app startup to ensure master secret is ready
 */
export async function initMasterSecret(): Promise<Uint8Array> {
  return getMasterSecret();
}

/**
 * Clear master secret from storage
 * WARNING: This will invalidate all future sessions and cannot be undone
 */
export async function clearMasterSecret(): Promise<void> {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(MASTER_SECRET_KEY);

    request.onerror = () => {
      reject(new Error('Failed to clear master secret'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });

  db.close();
  console.log('Master secret cleared');
}

/**
 * Export master secret for backup purposes
 * Returns a base32-encoded string suitable for user display/backup
 */
export async function exportMasterSecret(): Promise<string> {
  const secret = await getMasterSecret();
  // Use base64 for export (could use base32 for more user-friendly display)
  return encodeBase64(secret);
}

/**
 * Save API key locally in IndexedDB
 */
export async function saveApiKey(apiKey: string): Promise<void> {
  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(apiKey, API_KEY_KEY);

    request.onerror = () => {
      reject(new Error('Failed to save API key'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });

  db.close();
  await putRecord(API_KEY_META_KEY, { updatedAt: Date.now() } satisfies SecretMeta);
}

/** Returns the API key with its updatedAt, or null if not set. */
export async function getApiKeyExport(): Promise<{ value: string; updatedAt: number } | null> {
  const raw = await getRecord<string>(API_KEY_KEY);
  if (!raw) return null;
  const meta = await getRecord<SecretMeta>(API_KEY_META_KEY);
  return { value: raw, updatedAt: meta?.updatedAt ?? 0 };
}

/**
 * Apply a remote API key only if its updatedAt is newer. Returns true if
 * local state changed.
 */
export async function applyApiKey(value: string, updatedAt: number): Promise<boolean> {
  const existing = await getApiKeyExport();
  if (existing && existing.updatedAt >= updatedAt && existing.value === value) return false;
  if (existing && existing.updatedAt > updatedAt) return false;
  await putRecord(API_KEY_KEY, value);
  await putRecord(API_KEY_META_KEY, { updatedAt } satisfies SecretMeta);
  return true;
}

/**
 * Get locally stored API key, or null if not set
 */
export async function getApiKey(): Promise<string | null> {
  try {
    const db = await openDatabase();
    const result = await new Promise<string | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(API_KEY_KEY);

      request.onerror = () => {
        reject(new Error('Failed to get API key'));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });

    db.close();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Check if API key is stored locally
 */
export async function hasApiKey(): Promise<boolean> {
  const key = await getApiKey();
  return key !== null;
}

/** Save the voice/transcription config locally, stamping updatedAt. */
export async function saveVoiceConfig(config: VoiceConfig): Promise<void> {
  await putRecord(VOICE_CONFIG_KEY, JSON.stringify(config));
  await putRecord(VOICE_CONFIG_META_KEY, { updatedAt: Date.now() } satisfies SecretMeta);
}

/**
 * Parse the persisted JSON into a `VoiceConfig`, applying field migrations.
 * Exported for unit testing. Returns null on unparseable input.
 *
 * IMPORTANT: every persisted field must be carried through here — anything
 * omitted is silently dropped on read, which looks exactly like "the save
 * didn't stick" (it did; the read was lossy). That regression is what cost the
 * voice-intermediary fields a round-trip.
 */
export function parseVoiceConfig(raw: string): VoiceConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceConfig> & { model?: string };
    return {
      apiKey: parsed.apiKey ?? '',
      baseUrl: parsed.baseUrl ?? '',
      mode: parsed.mode === 'batch' ? 'batch' : 'streaming',
      // Migrate the pre-split single `model` field → batch model.
      transcribeModel: parsed.transcribeModel ?? parsed.model ?? '',
      streamModel: parsed.streamModel ?? '',
      // Voice intermediary ("AI coworker") — optional.
      agentModel: parsed.agentModel,
      ttsModel: parsed.ttsModel,
      ttsVoice: parsed.ttsVoice,
    };
  } catch {
    return null;
  }
}

/** Returns the parsed voice config, or null if not set / unparseable. */
export async function getVoiceConfig(): Promise<VoiceConfig | null> {
  const raw = await getRecord<string>(VOICE_CONFIG_KEY);
  if (!raw) return null;
  return parseVoiceConfig(raw);
}

/**
 * Returns the serialized voice config with its updatedAt for sync, or null if
 * not set. The value is the raw JSON string so it merges as an opaque scalar.
 */
export async function getVoiceConfigExport(): Promise<{ value: string; updatedAt: number } | null> {
  const raw = await getRecord<string>(VOICE_CONFIG_KEY);
  if (!raw) return null;
  const meta = await getRecord<SecretMeta>(VOICE_CONFIG_META_KEY);
  return { value: raw, updatedAt: meta?.updatedAt ?? 0 };
}

/**
 * Apply a remote voice config only if its updatedAt is newer. Returns true if
 * local state changed.
 */
export async function applyVoiceConfig(value: string, updatedAt: number): Promise<boolean> {
  const existing = await getVoiceConfigExport();
  if (existing && existing.updatedAt >= updatedAt && existing.value === value) return false;
  if (existing && existing.updatedAt > updatedAt) return false;
  await putRecord(VOICE_CONFIG_KEY, value);
  await putRecord(VOICE_CONFIG_META_KEY, { updatedAt } satisfies SecretMeta);
  return true;
}

/**
 * Import master secret from backup
 * WARNING: This will replace any existing master secret
 */
export async function importMasterSecret(backup: string): Promise<void> {
  const secret = decodeBase64(backup);

  if (secret.length !== 32) {
    throw new Error('Invalid master secret: must be 32 bytes');
  }

  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(backup, MASTER_SECRET_KEY);

    request.onerror = () => {
      reject(new Error('Failed to import master secret'));
    };

    request.onsuccess = () => {
      resolve();
    };
  });

  db.close();
  await putRecord(MASTER_SECRET_META_KEY, { updatedAt: Date.now() } satisfies SecretMeta);
  console.log('Master secret imported');
}
