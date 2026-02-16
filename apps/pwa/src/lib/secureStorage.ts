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

import { encodeBase64, decodeBase64, generateSessionDEK } from '@sumicom/quicksave-shared';

const DB_NAME = 'quicksave-secure';
const DB_VERSION = 1;
const STORE_NAME = 'secrets';
const MASTER_SECRET_KEY = 'master-secret';
const API_KEY_KEY = 'anthropic-api-key';

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
  console.log('Generated new master secret');
  return masterSecret;
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
  console.log('Master secret imported');
}

// ============================================================================
// Identity Key Persistence
// ============================================================================

const IDENTITY_KEY = 'identity-keypair';
const SIGNING_KEY = 'signing-keypair';

export async function getIdentityKeyPair(): Promise<{ publicKey: string; secretKey: string } | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(IDENTITY_KEY);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function saveIdentityKeyPair(keyPair: { publicKey: string; secretKey: string }): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(keyPair, IDENTITY_KEY);
    request.onsuccess = () => { db.close(); resolve(); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function getSigningKeyPair(): Promise<{ publicKey: string; secretKey: string } | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(SIGNING_KEY);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function saveSigningKeyPair(keyPair: { publicKey: string; secretKey: string }): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(keyPair, SIGNING_KEY);
    request.onsuccess = () => { db.close(); resolve(); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

export async function clearIdentityKeys(): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(IDENTITY_KEY);
    store.delete(SIGNING_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
