import nacl from 'tweetnacl';

/**
 * Signed envelope for writes to `/sync/{keyHash}` routes. The envelope binds
 * the ciphertext + action to a specific mailbox (`keyHash`) via Ed25519, and
 * carries a nonce + timestamp so the relay can drop replays.
 *
 * Canonical body signed by the client (UTF-8, `|` separator):
 *   `${action}|${sigPubkey}|${ts}|${nonce}|${keyHash}|${ciphertextHash}`
 *
 * `ciphertextHash` is URL-safe-base64 of SHA-512 over the ciphertext bytes.
 * For actions that carry no ciphertext (e.g. lock-release) it is the empty
 * string.
 */
export type SyncEnvelopeAction =
  | 'sync-write'
  | 'sync-tombstone'
  | 'sync-lock-release';

export interface SignedSyncEnvelope {
  v: 1;
  action: SyncEnvelopeAction;
  /** Absent for actions that don't carry a payload (lock-release). */
  ciphertext?: string;
  /** URL-safe base64 Ed25519 public key. */
  sigPubkey: string;
  ts: number;
  nonce: string;
  sig: string;
}

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToUrlSafe(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa is available in browser + Node 16+ globals
  return toUrlSafe(btoa(bin));
}

function randomNonce(size = 16): string {
  const buf = new Uint8Array(size);
  (globalThis.crypto ?? require('crypto').webcrypto).getRandomValues(buf);
  return bytesToUrlSafe(buf);
}

export function hashCiphertext(ciphertext: string): string {
  const bytes = new TextEncoder().encode(ciphertext);
  return bytesToUrlSafe(nacl.hash(bytes));
}

export function canonicalEnvelopeBody(params: {
  action: SyncEnvelopeAction;
  sigPubkey: string;
  ts: number;
  nonce: string;
  keyHash: string;
  ciphertextHash: string;
}): string {
  return [
    params.action,
    params.sigPubkey,
    String(params.ts),
    params.nonce,
    params.keyHash,
    params.ciphertextHash,
  ].join('|');
}

export interface CreateEnvelopeInput {
  action: SyncEnvelopeAction;
  keyHash: string;
  ciphertext?: string;
  signKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  now?: () => number;
}

export function createSignedSyncEnvelope(
  input: CreateEnvelopeInput,
): SignedSyncEnvelope {
  const ts = (input.now ?? Date.now)();
  const nonce = randomNonce();
  const sigPubkey = bytesToUrlSafe(input.signKeyPair.publicKey);
  const ciphertextHash = input.ciphertext ? hashCiphertext(input.ciphertext) : '';
  const canonical = canonicalEnvelopeBody({
    action: input.action,
    sigPubkey,
    ts,
    nonce,
    keyHash: input.keyHash,
    ciphertextHash,
  });
  const sigBytes = nacl.sign.detached(
    new TextEncoder().encode(canonical),
    input.signKeyPair.secretKey,
  );
  return {
    v: 1,
    action: input.action,
    ciphertext: input.ciphertext,
    sigPubkey,
    ts,
    nonce,
    sig: bytesToUrlSafe(sigBytes),
  };
}

/**
 * Type-guard for parsed JSON bodies on the relay side.
 * Only checks shape; signature verification happens separately.
 */
export function isSignedSyncEnvelope(x: unknown): x is SignedSyncEnvelope {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.action === 'string' &&
    (e.ciphertext === undefined || typeof e.ciphertext === 'string') &&
    typeof e.sigPubkey === 'string' &&
    typeof e.ts === 'number' &&
    typeof e.nonce === 'string' &&
    typeof e.sig === 'string'
  );
}
