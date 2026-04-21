import { describe, it, expect, vi } from 'vitest';
import {
  createTombstone,
  encodeBase64,
  generateSigningKeyPair,
  generateKeyPair,
  type Tombstone,
} from '@sumicom/quicksave-shared';
import {
  checkTombstone,
  hashPublicKey,
  signalingServerToHttp,
} from './tombstoneCheck.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make a fake fetch `Response`-ish object suitable for the boundary — only
 * the fields `checkTombstone` reads (status, json()) need to be present.
 */
function makeResponse(
  status: number,
  bodyJson?: unknown,
  opts: { jsonThrows?: boolean } = {},
): Response {
  return {
    status,
    async json() {
      if (opts.jsonThrows) throw new Error('invalid json');
      return bodyJson;
    },
  } as unknown as Response;
}

interface Fixture {
  peerPWAPublicKey: string;
  peerPWASignPublicKey: string;
  signingSecretKey: Uint8Array;
  tombstone: Tombstone;
  tombstoneDataJson: string;
}

/** Build a real, valid tombstone for the "pinned" PWA group. */
function makeValidFixture(): Fixture {
  const signing = generateSigningKeyPair();
  const identity = generateKeyPair();
  const peerPWAPublicKey = encodeBase64(identity.publicKey);
  const peerPWASignPublicKey = encodeBase64(signing.publicKey);
  const tombstone = createTombstone(peerPWAPublicKey, signing.secretKey);
  return {
    peerPWAPublicKey,
    peerPWASignPublicKey,
    signingSecretKey: signing.secretKey,
    tombstone,
    tombstoneDataJson: JSON.stringify(tombstone),
  };
}

// ---------------------------------------------------------------------------
// hashPublicKey
// ---------------------------------------------------------------------------

describe('hashPublicKey', () => {
  it('replaces "+" with "-"', () => {
    expect(hashPublicKey('a+b+c')).toBe('a-b-c');
  });

  it('replaces "/" with "_"', () => {
    expect(hashPublicKey('a/b/c')).toBe('a_b_c');
  });

  it('strips "=" padding', () => {
    expect(hashPublicKey('abc==')).toBe('abc');
  });

  it('preserves alphanumerics', () => {
    const alnum = 'ABCdef0123456789';
    expect(hashPublicKey(alnum)).toBe(alnum);
  });

  it('transforms a mixed standard base64 string correctly', () => {
    expect(hashPublicKey('ab+cd/ef==')).toBe('ab-cd_ef');
  });

  it('is a no-op for an already-urlsafe string', () => {
    expect(hashPublicKey('ab-cd_ef')).toBe('ab-cd_ef');
  });
});

// ---------------------------------------------------------------------------
// signalingServerToHttp
// ---------------------------------------------------------------------------

describe('signalingServerToHttp', () => {
  it('converts wss:// to https://', () => {
    expect(signalingServerToHttp('wss://relay.example.com')).toBe(
      'https://relay.example.com',
    );
  });

  it('converts ws:// to http://', () => {
    expect(signalingServerToHttp('ws://localhost:3000')).toBe(
      'http://localhost:3000',
    );
  });

  it('passes through https:// unchanged', () => {
    expect(signalingServerToHttp('https://relay.example.com')).toBe(
      'https://relay.example.com',
    );
  });

  it('passes through http:// unchanged', () => {
    expect(signalingServerToHttp('http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
  });

  it('preserves path and port', () => {
    expect(signalingServerToHttp('wss://relay.example.com:8080/sig')).toBe(
      'https://relay.example.com:8080/sig',
    );
  });
});

// ---------------------------------------------------------------------------
// checkTombstone
// ---------------------------------------------------------------------------

describe('checkTombstone', () => {
  it('hits the /sync/<hashedPubkey> URL on the HTTP-ified signaling server', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(404));

    await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://relay.example.com/sync/${hashPublicKey(fx.peerPWAPublicKey)}`,
    );
    expect(init).toEqual({ method: 'GET' });
  });

  it('returns { status: "absent" } on 404', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(404));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result).toEqual({ status: 'absent' });
  });

  it('returns { status: "absent" } on 200 (normal blob, not tombstone)', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { encryptedData: 'xxx' }));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result).toEqual({ status: 'absent' });
  });

  it('returns { status: "tombstoned", tombstone } for a valid signed tombstone whose oldPublicKey matches pinned pubkey', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(410, { data: fx.tombstoneDataJson }));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('tombstoned');
    if (result.status === 'tombstoned') {
      expect(result.tombstone).toEqual(fx.tombstone);
      expect(result.tombstone.oldPublicKey).toBe(fx.peerPWAPublicKey);
    }
  });

  it('returns { status: "verify-failed" } with oldPublicKey mismatch reason when tombstone points at a different pubkey', async () => {
    const fx = makeValidFixture();
    // Craft a tombstone signed by the same group key, but over a DIFFERENT
    // oldPublicKey than the one we have pinned — replay-from-elsewhere attack.
    const otherIdentity = generateKeyPair();
    const otherPubKeyB64 = encodeBase64(otherIdentity.publicKey);
    const mismatched = createTombstone(otherPubKeyB64, fx.signingSecretKey);

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        makeResponse(410, { data: JSON.stringify(mismatched) }),
      );

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('verify-failed');
    if (result.status === 'verify-failed') {
      expect(result.reason).toMatch(/oldPublicKey mismatch/i);
    }
  });

  it('returns { status: "verify-failed" } when the tombstone signature does not verify under the pinned signing key', async () => {
    const fx = makeValidFixture();
    // Tombstone signed by a DIFFERENT group's signing key, carrying the
    // correct oldPublicKey so shape + oldPublicKey checks pass, but signature
    // verification under `peerPWASignPublicKey` must fail.
    const wrongSigning = generateSigningKeyPair();
    const forged = createTombstone(
      fx.peerPWAPublicKey,
      wrongSigning.secretKey,
    );

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(410, { data: JSON.stringify(forged) }));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('verify-failed');
    if (result.status === 'verify-failed') {
      expect(result.reason).toMatch(/signature/i);
    }
  });

  it('returns { status: "verify-failed" } when `data` is not valid JSON', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(makeResponse(410, { data: '{not-json' }));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('verify-failed');
    if (result.status === 'verify-failed') {
      expect(result.reason).toMatch(/json/i);
    }
  });

  it('returns { status: "verify-failed" } when the tombstone is missing required fields', async () => {
    const fx = makeValidFixture();
    const malformed = { type: 'rotated', oldPublicKey: fx.peerPWAPublicKey };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        makeResponse(410, { data: JSON.stringify(malformed) }),
      );

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('verify-failed');
    if (result.status === 'verify-failed') {
      expect(result.reason).toMatch(/malformed tombstone shape/i);
    }
  });

  it('returns { status: "error" } on 500', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(500));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/500/);
    }
  });

  it('returns { status: "error" } when fetch throws', async () => {
    const fx = makeValidFixture();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: fx.peerPWASignPublicKey,
      fetchImpl,
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });

  it('returns { status: "error" } when the pinned signing pubkey is not valid base64', async () => {
    const fx = makeValidFixture();
    // Valid 410 + tombstone shape + oldPublicKey match, so we reach the
    // decodeBase64 call on `peerPWASignPublicKey`. The bogus key must fail
    // to decode.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        makeResponse(410, { data: fx.tombstoneDataJson }),
      );

    const result = await checkTombstone({
      signalingServer: 'wss://relay.example.com',
      peerPWAPublicKey: fx.peerPWAPublicKey,
      peerPWASignPublicKey: '!!!not-base64!!!',
      fetchImpl,
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/signing pubkey/i);
    }
  });
});
