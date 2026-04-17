import nacl from 'tweetnacl';

/**
 * INVARIANT: NONCE_TTL_MS >= TS_WINDOW_MS. The two replay gates (timestamp
 * window + seen-nonce cache) together close the replay window by construction.
 * Shortening NONCE_TTL_MS below TS_WINDOW_MS silently reopens it.
 */
export const TS_WINDOW_MS = 60_000;
export const NONCE_TTL_MS = 120_000;

export interface VerifiedRequest {
  ok: true;
  now: number;
}

export interface RejectedRequest {
  ok: false;
  reason:
    | 'missing-params'
    | 'bad-pubkey'
    | 'stale'
    | 'future'
    | 'replay'
    | 'bad-signature';
  /** Milliseconds the client's timestamp is off by. Only set when reason=stale/future. */
  driftMs?: number;
  /** Server's notion of `now`, returned so clients can correct their clock on stale rejection. */
  serverTime: number;
}

export type VerifyResult = VerifiedRequest | RejectedRequest;

function b64urlToBytes(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const buf = Buffer.from(padded, 'base64');
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

interface NonceCache {
  has(nonce: string): boolean;
  add(nonce: string, expiresAt: number): void;
}

/**
 * Simple TTL map used as a seen-nonce cache. Entries are lazily evicted on
 * access; a periodic sweeper is not required because the cache is bounded by
 * valid traffic (an attacker without the signing key cannot grow it).
 */
export class TtlNonceCache implements NonceCache {
  private map = new Map<string, number>();

  has(nonce: string): boolean {
    const expiresAt = this.map.get(nonce);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.map.delete(nonce);
      return false;
    }
    return true;
  }

  add(nonce: string, expiresAt: number): void {
    this.map.set(nonce, expiresAt);
  }

  get size(): number {
    return this.map.size;
  }
}

export interface VerifyInput {
  /** Identifies what is being signed, e.g. "push:register". Included in the canonical body. */
  action: string;
  /** URL-safe base64 Ed25519 public key that signed the request. */
  signPubKey: string;
  ts: number | string | null | undefined;
  nonce: string | null | undefined;
  sig: string | null | undefined;
  /** Extra payload fields incorporated into the canonical body, in order. */
  extra?: string[];
  now?: number;
  cache: NonceCache;
}

/**
 * Verify an Ed25519 self-signed request with timestamp + nonce replay protection.
 *
 * Canonical body signed by the client (UTF-8, `|` separator):
 *   `${action}|${signPubKey}|${ts}|${nonce}|${extra.join('|')}`
 */
export function verifySignedRequest(input: VerifyInput): VerifyResult {
  const now = input.now ?? Date.now();
  const tsNum = typeof input.ts === 'string' ? Number(input.ts) : input.ts ?? NaN;

  if (!Number.isFinite(tsNum) || !input.nonce || !input.sig) {
    return { ok: false, reason: 'missing-params', serverTime: now };
  }

  const pub = b64urlToBytes(input.signPubKey);
  if (!pub || pub.length !== 32) {
    return { ok: false, reason: 'bad-pubkey', serverTime: now };
  }

  const drift = now - (tsNum as number);
  if (drift > TS_WINDOW_MS) return { ok: false, reason: 'stale', driftMs: drift, serverTime: now };
  if (drift < -TS_WINDOW_MS) return { ok: false, reason: 'future', driftMs: drift, serverTime: now };

  if (input.cache.has(input.nonce)) {
    return { ok: false, reason: 'replay', serverTime: now };
  }

  const canonical = [input.action, input.signPubKey, String(tsNum), input.nonce, ...(input.extra ?? [])].join('|');
  const sigBytes = b64urlToBytes(input.sig);
  if (!sigBytes || sigBytes.length !== 64) {
    return { ok: false, reason: 'bad-signature', serverTime: now };
  }

  const message = new TextEncoder().encode(canonical);
  if (!nacl.sign.detached.verify(message, sigBytes, pub)) {
    return { ok: false, reason: 'bad-signature', serverTime: now };
  }

  // Only commit seen-state after verification succeeds.
  input.cache.add(input.nonce, now + NONCE_TTL_MS);
  return { ok: true, now };
}
