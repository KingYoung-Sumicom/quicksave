import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import { verifySignedRequest, TtlNonceCache, NONCE_TTL_MS, TS_WINDOW_MS } from './sigVerify.js';

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function signRequest(action: string, extra: string[] = [], opts: { ts?: number; nonce?: string } = {}) {
  const keyPair = nacl.sign.keyPair();
  const signPubKey = b64url(keyPair.publicKey);
  const ts = opts.ts ?? Date.now();
  const nonce = opts.nonce ?? b64url(nacl.randomBytes(16));
  const canonical = [action, signPubKey, String(ts), nonce, ...extra].join('|');
  const sig = nacl.sign.detached(new TextEncoder().encode(canonical), keyPair.secretKey);
  return { signPubKey, ts, nonce, sig: b64url(sig), extra };
}

describe('verifySignedRequest', () => {
  let cache: TtlNonceCache;
  beforeEach(() => {
    cache = new TtlNonceCache();
  });

  it('accepts a well-formed signature', () => {
    const { signPubKey, ts, nonce, sig, extra } = signRequest('push:register');
    const result = verifySignedRequest({
      action: 'push:register',
      signPubKey,
      ts,
      nonce,
      sig,
      extra,
      cache,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects stale timestamps', () => {
    const old = Date.now() - TS_WINDOW_MS - 1000;
    const { signPubKey, ts, nonce, sig, extra } = signRequest('push:register', [], { ts: old });
    const result = verifySignedRequest({
      action: 'push:register',
      signPubKey,
      ts,
      nonce,
      sig,
      extra,
      cache,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('stale');
      expect(typeof result.driftMs).toBe('number');
      expect(typeof result.serverTime).toBe('number');
    }
  });

  it('rejects timestamps too far in the future', () => {
    const future = Date.now() + TS_WINDOW_MS + 1000;
    const { signPubKey, ts, nonce, sig, extra } = signRequest('push:register', [], { ts: future });
    const result = verifySignedRequest({
      action: 'push:register',
      signPubKey,
      ts,
      nonce,
      sig,
      extra,
      cache,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('future');
  });

  it('rejects reused nonces', () => {
    const signed = signRequest('push:register');
    const first = verifySignedRequest({ action: 'push:register', ...signed, cache });
    const second = verifySignedRequest({ action: 'push:register', ...signed, cache });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('replay');
  });

  it('rejects signatures that do not match the canonical body', () => {
    const { signPubKey, ts, nonce, sig } = signRequest('push:register');
    const result = verifySignedRequest({
      action: 'push:notify', // different action → canonical body differs
      signPubKey,
      ts,
      nonce,
      sig,
      cache,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects when extra fields are tampered with', () => {
    const { signPubKey, ts, nonce, sig } = signRequest('push:notify', ['session-abc']);
    const result = verifySignedRequest({
      action: 'push:notify',
      signPubKey,
      ts,
      nonce,
      sig,
      extra: ['session-xyz'],
      cache,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects malformed pubkey', () => {
    const { ts, nonce, sig } = signRequest('push:register');
    const result = verifySignedRequest({
      action: 'push:register',
      signPubKey: 'not-base64!!!',
      ts,
      nonce,
      sig,
      cache,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-pubkey');
  });

  it('rejects missing params', () => {
    const result = verifySignedRequest({
      action: 'push:register',
      signPubKey: b64url(new Uint8Array(32)),
      ts: null,
      nonce: null,
      sig: null,
      cache,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-params');
  });

  it('invariant: NONCE_TTL_MS covers the timestamp window', () => {
    expect(NONCE_TTL_MS).toBeGreaterThanOrEqual(TS_WINDOW_MS);
  });
});

describe('TtlNonceCache', () => {
  it('evicts expired entries on access', () => {
    const cache = new TtlNonceCache();
    cache.add('abc', Date.now() - 1);
    expect(cache.has('abc')).toBe(false);
  });
});
