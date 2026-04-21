import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  canonicalEnvelopeBody,
  hashCiphertext,
  createSignedSyncEnvelope,
  isSignedSyncEnvelope,
  type SignedSyncEnvelope,
  type SyncEnvelopeAction,
} from './syncEnvelope.js';

// URL-safe base64 decoder for verifying signatures / pubkeys round-tripped
// through the envelope. The module emits URL-safe base64 without padding.
function urlSafeB64Decode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

describe('canonicalEnvelopeBody', () => {
  it('produces the exact pipe-joined format for a known input', () => {
    const body = canonicalEnvelopeBody({
      action: 'sync-write',
      sigPubkey: 'PUBKEY',
      ts: 1234567890,
      nonce: 'NONCE',
      keyHash: 'KEYHASH',
      ciphertextHash: 'CTHASH',
    });
    expect(body).toBe('sync-write|PUBKEY|1234567890|NONCE|KEYHASH|CTHASH');
  });

  it('uses "|" as the separator in the exact positional order', () => {
    const body = canonicalEnvelopeBody({
      action: 'sync-tombstone',
      sigPubkey: 'A',
      ts: 1,
      nonce: 'B',
      keyHash: 'C',
      ciphertextHash: 'D',
    });
    const parts = body.split('|');
    expect(parts).toEqual(['sync-tombstone', 'A', '1', 'B', 'C', 'D']);
  });

  it('converts numeric ts to its decimal string form', () => {
    const body = canonicalEnvelopeBody({
      action: 'sync-write',
      sigPubkey: 'p',
      ts: 0,
      nonce: 'n',
      keyHash: 'k',
      ciphertextHash: 'c',
    });
    expect(body.split('|')[2]).toBe('0');
  });

  it('stringifies large ts without scientific notation', () => {
    const ts = 1_700_000_000_000; // realistic ms timestamp
    const body = canonicalEnvelopeBody({
      action: 'sync-write',
      sigPubkey: 'p',
      ts,
      nonce: 'n',
      keyHash: 'k',
      ciphertextHash: 'c',
    });
    expect(body.split('|')[2]).toBe('1700000000000');
  });

  it('renders empty ciphertextHash as a trailing empty segment', () => {
    const body = canonicalEnvelopeBody({
      action: 'sync-lock-release',
      sigPubkey: 'p',
      ts: 42,
      nonce: 'n',
      keyHash: 'k',
      ciphertextHash: '',
    });
    expect(body).toBe('sync-lock-release|p|42|n|k|');
    expect(body.endsWith('|')).toBe(true);
    expect(body.split('|').length).toBe(6);
  });

  it('produces different bodies when any single field changes', () => {
    const base = {
      action: 'sync-write' as SyncEnvelopeAction,
      sigPubkey: 'p',
      ts: 1,
      nonce: 'n',
      keyHash: 'k',
      ciphertextHash: 'c',
    };
    const baseline = canonicalEnvelopeBody(base);
    expect(canonicalEnvelopeBody({ ...base, action: 'sync-tombstone' })).not.toBe(baseline);
    expect(canonicalEnvelopeBody({ ...base, sigPubkey: 'p2' })).not.toBe(baseline);
    expect(canonicalEnvelopeBody({ ...base, ts: 2 })).not.toBe(baseline);
    expect(canonicalEnvelopeBody({ ...base, nonce: 'n2' })).not.toBe(baseline);
    expect(canonicalEnvelopeBody({ ...base, keyHash: 'k2' })).not.toBe(baseline);
    expect(canonicalEnvelopeBody({ ...base, ciphertextHash: 'c2' })).not.toBe(baseline);
  });
});

describe('hashCiphertext', () => {
  it('is deterministic for the same input', () => {
    const input = 'some ciphertext payload';
    expect(hashCiphertext(input)).toBe(hashCiphertext(input));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashCiphertext('a')).not.toBe(hashCiphertext('b'));
  });

  it('is sensitive to single-character differences', () => {
    expect(hashCiphertext('hello world')).not.toBe(hashCiphertext('hello worle'));
  });

  it('outputs URL-safe base64 (no +, /, or = characters)', () => {
    // Try several inputs to shake out any byte combination that might
    // produce padding or non-URL-safe characters.
    const inputs = [
      '',
      'a',
      'ab',
      'abc',
      'abcd',
      'hello world',
      '你好世界 🚀',
      'x'.repeat(1000),
    ];
    for (const input of inputs) {
      const hash = hashCiphertext(input);
      expect(hash).not.toMatch(/\+/);
      expect(hash).not.toMatch(/\//);
      expect(hash).not.toMatch(/=/);
      expect(hash).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it('is non-empty for non-empty input', () => {
    expect(hashCiphertext('anything').length).toBeGreaterThan(0);
  });

  it('produces a stable hash length for varying input sizes', () => {
    // SHA-512 => 64 bytes => ceil(64*4/3) = 86 chars unpadded.
    const lengths = new Set(
      ['', 'a', 'hello', 'x'.repeat(10_000)].map((s) => hashCiphertext(s).length),
    );
    expect(lengths.size).toBe(1);
  });
});

describe('createSignedSyncEnvelope', () => {
  it('returns v: 1', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    expect(env.v).toBe(1);
  });

  it('copies the action from input', () => {
    const kp = nacl.sign.keyPair();
    const actions: SyncEnvelopeAction[] = [
      'sync-write',
      'sync-tombstone',
      'sync-lock-release',
    ];
    for (const action of actions) {
      const env = createSignedSyncEnvelope({
        action,
        keyHash: 'kh',
        ciphertext: action === 'sync-lock-release' ? undefined : 'ct',
        signKeyPair: kp,
      });
      expect(env.action).toBe(action);
    }
  });

  it('encodes sigPubkey as URL-safe base64 of signKeyPair.publicKey', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    expect(env.sigPubkey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(urlSafeB64Decode(env.sigPubkey)).toEqual(kp.publicKey);
  });

  it('uses the injected now() for ts', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
      now: () => 1234567890,
    });
    expect(env.ts).toBe(1234567890);
  });

  it('falls back to Date.now() when now is not provided', () => {
    const kp = nacl.sign.keyPair();
    const before = Date.now();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const after = Date.now();
    expect(typeof env.ts).toBe('number');
    expect(env.ts).toBeGreaterThanOrEqual(before);
    expect(env.ts).toBeLessThanOrEqual(after);
  });

  it('produces a URL-safe, non-empty nonce', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    expect(env.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(env.nonce.length).toBeGreaterThan(0);
  });

  it('generates a fresh nonce on each call', () => {
    const kp = nacl.sign.keyPair();
    const a = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const b = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('omits ciphertext when not provided (lock-release)', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-lock-release',
      keyHash: 'kh',
      signKeyPair: kp,
    });
    expect(env.ciphertext).toBeUndefined();
  });

  it('passes through the provided ciphertext verbatim', () => {
    const kp = nacl.sign.keyPair();
    const ciphertext = 'some-encrypted-blob-base64==';
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext,
      signKeyPair: kp,
    });
    expect(env.ciphertext).toBe(ciphertext);
  });

  it('produces a valid Ed25519 signature over the canonical body (sync-write)', () => {
    const kp = nacl.sign.keyPair();
    const keyHash = 'KH-abc';
    const ciphertext = 'ciphertext-payload';
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash,
      ciphertext,
      signKeyPair: kp,
    });

    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: env.nonce,
      keyHash,
      ciphertextHash: hashCiphertext(ciphertext),
    });
    const bodyBytes = new TextEncoder().encode(body);
    const sigBytes = urlSafeB64Decode(env.sig);

    expect(nacl.sign.detached.verify(bodyBytes, sigBytes, kp.publicKey)).toBe(true);
  });

  it('produces a valid Ed25519 signature for lock-release (empty ciphertextHash)', () => {
    const kp = nacl.sign.keyPair();
    const keyHash = 'KH-lock';
    const env = createSignedSyncEnvelope({
      action: 'sync-lock-release',
      keyHash,
      signKeyPair: kp,
    });

    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: env.nonce,
      keyHash,
      ciphertextHash: '',
    });
    const sigBytes = urlSafeB64Decode(env.sig);

    expect(
      nacl.sign.detached.verify(new TextEncoder().encode(body), sigBytes, kp.publicKey),
    ).toBe(true);
  });

  it('signature fails verification when action is tampered', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const body = canonicalEnvelopeBody({
      action: 'sync-tombstone', // tampered
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: env.nonce,
      keyHash: 'kh',
      ciphertextHash: hashCiphertext('ct'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        kp.publicKey,
      ),
    ).toBe(false);
  });

  it('signature fails verification when keyHash is tampered', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: env.nonce,
      keyHash: 'other-keyhash',
      ciphertextHash: hashCiphertext('ct'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        kp.publicKey,
      ),
    ).toBe(false);
  });

  it('signature fails verification when ciphertext is tampered', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'original',
      signKeyPair: kp,
    });
    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: env.nonce,
      keyHash: 'kh',
      ciphertextHash: hashCiphertext('tampered'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        kp.publicKey,
      ),
    ).toBe(false);
  });

  it('signature fails verification when ts is tampered', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
      now: () => 1000,
    });
    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: 9999, // tampered
      nonce: env.nonce,
      keyHash: 'kh',
      ciphertextHash: hashCiphertext('ct'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        kp.publicKey,
      ),
    ).toBe(false);
  });

  it('signature fails verification when nonce is tampered', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: 'tampered-nonce',
      keyHash: 'kh',
      ciphertextHash: hashCiphertext('ct'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        kp.publicKey,
      ),
    ).toBe(false);
  });

  it('signature fails verification when sigPubkey is tampered', () => {
    const kp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: 'AAAA', // tampered
      ts: env.ts,
      nonce: env.nonce,
      keyHash: 'kh',
      ciphertextHash: hashCiphertext('ct'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        kp.publicKey,
      ),
    ).toBe(false);
  });

  it('signature fails verification under a different signing key', () => {
    const kp = nacl.sign.keyPair();
    const otherKp = nacl.sign.keyPair();
    const env = createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
    const body = canonicalEnvelopeBody({
      action: env.action,
      sigPubkey: env.sigPubkey,
      ts: env.ts,
      nonce: env.nonce,
      keyHash: 'kh',
      ciphertextHash: hashCiphertext('ct'),
    });
    expect(
      nacl.sign.detached.verify(
        new TextEncoder().encode(body),
        urlSafeB64Decode(env.sig),
        otherKp.publicKey,
      ),
    ).toBe(false);
  });
});

describe('isSignedSyncEnvelope', () => {
  function freshEnvelope(): SignedSyncEnvelope {
    const kp = nacl.sign.keyPair();
    return createSignedSyncEnvelope({
      action: 'sync-write',
      keyHash: 'kh',
      ciphertext: 'ct',
      signKeyPair: kp,
    });
  }

  it('returns true for a fresh envelope from createSignedSyncEnvelope', () => {
    expect(isSignedSyncEnvelope(freshEnvelope())).toBe(true);
  });

  it('returns false for null', () => {
    expect(isSignedSyncEnvelope(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isSignedSyncEnvelope(undefined)).toBe(false);
  });

  it('returns false for primitive values', () => {
    expect(isSignedSyncEnvelope(42)).toBe(false);
    expect(isSignedSyncEnvelope('string')).toBe(false);
    expect(isSignedSyncEnvelope(true)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isSignedSyncEnvelope({})).toBe(false);
  });

  it('returns false for an array (including an array holding an envelope)', () => {
    // Arrays do not have the required named fields.
    expect(isSignedSyncEnvelope([])).toBe(false);
    expect(isSignedSyncEnvelope([freshEnvelope()])).toBe(false);
  });

  it('returns false when any required field is missing', () => {
    const base = freshEnvelope();
    const fields: (keyof SignedSyncEnvelope)[] = [
      'v',
      'action',
      'sigPubkey',
      'ts',
      'nonce',
      'sig',
    ];
    for (const f of fields) {
      const clone: Record<string, unknown> = { ...base };
      delete clone[f];
      expect(isSignedSyncEnvelope(clone)).toBe(false);
    }
  });

  it('returns false when v is not 1', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), v: 2 })).toBe(false);
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), v: '1' })).toBe(false);
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), v: 0 })).toBe(false);
  });

  it('returns false when ts is a string', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), ts: '123' })).toBe(false);
  });

  it('returns false when action is not a string', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), action: 1 })).toBe(false);
  });

  it('returns false when sigPubkey is not a string', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), sigPubkey: 123 })).toBe(false);
  });

  it('returns false when nonce is not a string', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), nonce: null })).toBe(false);
  });

  it('returns false when sig is not a string', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), sig: {} })).toBe(false);
  });

  it('returns true when ciphertext is undefined', () => {
    const env = freshEnvelope();
    const withoutCiphertext: Record<string, unknown> = { ...env };
    delete withoutCiphertext.ciphertext;
    expect(isSignedSyncEnvelope(withoutCiphertext)).toBe(true);

    // Explicitly set to undefined should also be accepted.
    expect(isSignedSyncEnvelope({ ...env, ciphertext: undefined })).toBe(true);
  });

  it('returns true when ciphertext is a string', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), ciphertext: 'anything' })).toBe(
      true,
    );
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), ciphertext: '' })).toBe(true);
  });

  it('returns false when ciphertext is a number', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), ciphertext: 123 })).toBe(false);
  });

  it('returns false when ciphertext is an object', () => {
    expect(isSignedSyncEnvelope({ ...freshEnvelope(), ciphertext: {} })).toBe(false);
  });
});
