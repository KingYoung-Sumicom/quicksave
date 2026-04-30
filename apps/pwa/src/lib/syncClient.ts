// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import {
  encryptSyncBlob,
  decryptSyncBlob,
  decodeBase64,
  createTombstone,
  createSignedSyncEnvelope,
  type SyncEnvelopeAction,
} from '@sumicom/quicksave-shared';
import type { Machine } from '../stores/machineStore';
import type { SyncPayloadV3, Timestamped } from './syncMerge';

export interface SyncSignKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

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
  // value outranks them. Legacy payloads carry no tombstones.
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
    exportedAt: payload.exportedAt,
  };
}

const WRITE_MAX_RETRIES = 4;
const WRITE_BACKOFF_BASE_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SyncClient {
  private baseUrl: string;

  constructor(signalingServer: string) {
    this.baseUrl = signalingServer
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');
  }

  private async signedWrite(
    action: SyncEnvelopeAction,
    keyHash: string,
    ciphertext: string | undefined,
    method: 'PUT' | 'DELETE',
    urlSuffix: '' | '/tombstone' | '/lock',
    signKeyPair: SyncSignKeyPair,
  ): Promise<Response> {
    const url = `${this.baseUrl}/sync/${keyHash}${urlSuffix}`;
    for (let attempt = 0; attempt <= WRITE_MAX_RETRIES; attempt++) {
      const envelope = createSignedSyncEnvelope({
        action,
        keyHash,
        ciphertext,
        signKeyPair,
      });
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      if (res.status !== 409) return res;

      // 409 = mailbox locked by another writer. Retry with fresh nonce/ts
      // after backoff, honouring Retry-After when present.
      let waitMs: number | null = null;
      try {
        const cloned = res.clone();
        const body = await cloned.json();
        if (typeof body?.retryAfterMs === 'number') waitMs = body.retryAfterMs;
      } catch {
        // ignore body parsing errors
      }
      if (waitMs === null) {
        const header = res.headers.get('Retry-After');
        if (header) waitMs = Number(header) * 1000;
      }
      if (attempt === WRITE_MAX_RETRIES) return res;

      const backoff = WRITE_BACKOFF_BASE_MS * 2 ** attempt;
      const jitter = Math.floor(Math.random() * WRITE_BACKOFF_BASE_MS);
      const delay = Math.min(
        Math.max(waitMs ?? 0, backoff) + jitter,
        5_000,
      );
      await sleep(delay);
    }
    // Should be unreachable — the loop always returns on the last attempt.
    throw new Error('signedWrite: unreachable');
  }

  /**
   * Push an encrypted sync payload to the mailbox at `hash(recipientPublicKey)`.
   * In the shared-secret model this is the group mailbox — every PWA that
   * derives the same pubkey reads and writes to the same address.
   * Returns 'ok' on success, 'tombstone' if the mailbox has been sealed.
   */
  async pushToMailbox(
    payload: SyncPayloadV3,
    recipientPublicKey: string,
    signKeyPair: SyncSignKeyPair,
  ): Promise<'ok' | 'tombstone'> {
    const plaintext = JSON.stringify(payload);
    const recipientPublicKeyBytes = decodeBase64(recipientPublicKey);
    const encrypted = encryptSyncBlob(plaintext, recipientPublicKeyBytes);
    const keyHash = hashPublicKey(recipientPublicKey);

    const res = await this.signedWrite(
      'sync-write',
      keyHash,
      encrypted,
      'PUT',
      '',
      signKeyPair,
    );

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
    signingPublicKey: Uint8Array,
  ): Promise<void> {
    const tombstone = createTombstone(publicKey, signingSecretKey);
    const keyHash = hashPublicKey(publicKey);

    const res = await this.signedWrite(
      'sync-tombstone',
      keyHash,
      JSON.stringify(tombstone),
      'PUT',
      '/tombstone',
      { publicKey: signingPublicKey, secretKey: signingSecretKey },
    );

    if (!res.ok && res.status !== 409) {
      throw new Error(`Tombstone post failed: ${res.status}`);
    }
  }

  /**
   * Release a lock held by this signing key on `keyHash`. Used to bail out
   * early from a write that won't complete (e.g. client navigated away).
   */
  async releaseLock(
    recipientPublicKey: string,
    signKeyPair: SyncSignKeyPair,
  ): Promise<boolean> {
    const keyHash = hashPublicKey(recipientPublicKey);
    const res = await this.signedWrite(
      'sync-lock-release',
      keyHash,
      undefined,
      'DELETE',
      '/lock',
      signKeyPair,
    );
    if (!res.ok) return false;
    try {
      const body = await res.json();
      return !!body?.released;
    } catch {
      return false;
    }
  }
}

export type { SyncPayloadV3 as SyncPayload };
