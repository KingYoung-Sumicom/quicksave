import {
  encryptSyncBlob,
  decryptSyncBlob,
  decodeBase64,
  createTombstone,
} from '@sumicom/quicksave-shared';
import type { Machine } from '../stores/machineStore';

interface SyncPayload {
  version: 2;
  masterSecret: string;
  apiKey?: string;
  machines: Machine[];
  exportedAt: string;
}

function hashPublicKey(publicKey: string): string {
  // Use base64url-safe version of the key as hash
  return publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export class SyncClient {
  private baseUrl: string;

  constructor(signalingServer: string) {
    // Convert ws:// to http:// for REST calls
    this.baseUrl = signalingServer
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');
  }

  /**
   * Push encrypted sync payload to a paired device's mailbox.
   * Returns 'ok' on success, 'tombstone' if the key has been rotated.
   */
  async pushToDevice(
    payload: SyncPayload,
    recipientPublicKey: string,
  ): Promise<'ok' | 'tombstone'> {
    const plaintext = JSON.stringify(payload);
    const recipientPublicKeyBytes = decodeBase64(recipientPublicKey);
    const encrypted = encryptSyncBlob(plaintext, recipientPublicKeyBytes);
    const keyHash = hashPublicKey(recipientPublicKey);

    const res = await fetch(`${this.baseUrl}/sync/${keyHash}`, {
      method: 'PUT',
      body: encrypted,
    });

    if (res.status === 410) return 'tombstone';
    if (!res.ok) throw new Error(`Sync push failed: ${res.status}`);
    return 'ok';
  }

  /**
   * Fetch and decrypt this device's mailbox.
   * Returns the decrypted payload, tombstone indicator, or null if empty.
   */
  async fetchMyMailbox(
    myPublicKey: string,
    mySecretKey: Uint8Array,
  ): Promise<{ type: 'blob'; payload: SyncPayload } | { type: 'tombstone'; tombstone: string } | null> {
    const keyHash = hashPublicKey(myPublicKey);
    const res = await fetch(`${this.baseUrl}/sync/${keyHash}`);

    if (res.status === 404) return null;

    const body = await res.json();

    if (res.status === 410 || body.type === 'tombstone') {
      return { type: 'tombstone', tombstone: body.data };
    }

    const decrypted = decryptSyncBlob(body.data, mySecretKey);
    return { type: 'blob', payload: JSON.parse(decrypted) as SyncPayload };
  }

  /**
   * Post a tombstone to seal a key's mailbox permanently.
   */
  async postTombstone(
    publicKey: string,
    signingSecretKey: Uint8Array,
  ): Promise<void> {
    const tombstone = createTombstone(publicKey, signingSecretKey);
    const keyHash = hashPublicKey(publicKey);

    const res = await fetch(`${this.baseUrl}/sync/${keyHash}/tombstone`, {
      method: 'PUT',
      body: JSON.stringify(tombstone),
    });

    if (!res.ok && res.status !== 409) {
      throw new Error(`Tombstone post failed: ${res.status}`);
    }
  }
}

export type { SyncPayload };
