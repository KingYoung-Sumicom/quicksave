import {
  encryptSyncBlob,
  decryptSyncBlob,
  decodeBase64,
  createTombstone,
} from '@sumicom/quicksave-shared';
import type { Machine } from '../stores/machineStore';
import type { SyncPayloadV3, Timestamped } from './syncMerge';

/**
 * Legacy v2 payload shape. Kept only so fetchMyMailbox can auto-upgrade a
 * blob written by an older PWA version. Once all devices push v3, this path
 * becomes dead code and can be removed.
 */
interface SyncPayloadV2 {
  version: 2;
  masterSecret: string;
  apiKey?: string;
  machines: Machine[];
  exportedAt: string;
}

type AnySyncPayload = SyncPayloadV2 | SyncPayloadV3;

function hashPublicKey(publicKey: string): string {
  return publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function upgradePayload(payload: AnySyncPayload): SyncPayloadV3 {
  if (payload.version === 3) return payload;
  // v2 → v3: wrap scalar secrets as Timestamped with updatedAt=0 so any local
  // value outranks them. Legacy payloads carry no tombstones or pinned state.
  const secret: Timestamped<string> | null = payload.masterSecret
    ? { value: payload.masterSecret, updatedAt: 0 }
    : null;
  const apiKey: Timestamped<string> | null = payload.apiKey
    ? { value: payload.apiKey, updatedAt: 0 }
    : null;
  return {
    version: 3,
    masterSecret: secret,
    apiKey,
    machines: payload.machines,
    machineTombstones: {},
    pinnedProjects: {},
    exportedAt: payload.exportedAt,
  };
}

export class SyncClient {
  private baseUrl: string;

  constructor(signalingServer: string) {
    this.baseUrl = signalingServer
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');
  }

  /**
   * Push encrypted sync payload to a paired device's mailbox.
   * Returns 'ok' on success, 'tombstone' if the key has been rotated.
   */
  async pushToDevice(
    payload: SyncPayloadV3,
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
   * Fetch and decrypt this device's mailbox. Any v2 blob is auto-upgraded.
   */
  async fetchMyMailbox(
    myPublicKey: string,
    mySecretKey: Uint8Array,
  ): Promise<
    | { type: 'blob'; payload: SyncPayloadV3 }
    | { type: 'tombstone'; tombstone: string }
    | null
  > {
    const keyHash = hashPublicKey(myPublicKey);
    const res = await fetch(`${this.baseUrl}/sync/${keyHash}`);

    if (res.status === 404) return null;

    const body = await res.json();

    if (res.status === 410 || body.type === 'tombstone') {
      return { type: 'tombstone', tombstone: body.data };
    }

    const decrypted = decryptSyncBlob(body.data, mySecretKey);
    const raw = JSON.parse(decrypted) as AnySyncPayload;
    return { type: 'blob', payload: upgradePayload(raw) };
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

export type { SyncPayloadV3 as SyncPayload };
