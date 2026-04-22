import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  generateKeyPair,
  generateSigningKeyPair,
  encrypt,
  decrypt,
  deriveSharedSecret,
  encryptWithSharedSecret,
  decryptWithSharedSecret,
  generateSessionDEK,
  encryptDEK,
  decryptDEK,
  sign,
  verify,
  encodeKeyPair,
  decodeKeyPair,
  generateAgentId,
  isValidBase64Key,
  encodeBase64,
  decodeBase64,
  createTombstone,
  verifyTombstone,
  encryptSyncBlob,
  decryptSyncBlob,
  SAS_ALPHABET,
  deriveSharedKeys,
  sasEncode,
  sasBucket,
  sasCompute,
} from './crypto.js';

describe('Key Generation', () => {
  it('should generate valid encryption key pair', () => {
    const keyPair = generateKeyPair();
    expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keyPair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keyPair.publicKey.length).toBe(32);
    expect(keyPair.secretKey.length).toBe(32);
  });

  it('should generate unique key pairs each time', () => {
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();
    expect(encodeBase64(keyPair1.publicKey)).not.toBe(encodeBase64(keyPair2.publicKey));
    expect(encodeBase64(keyPair1.secretKey)).not.toBe(encodeBase64(keyPair2.secretKey));
  });

  it('should generate valid signing key pair', () => {
    const keyPair = generateSigningKeyPair();
    expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keyPair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keyPair.publicKey.length).toBe(32);
    expect(keyPair.secretKey.length).toBe(64);
  });
});

describe('Encryption / Decryption', () => {
  it('should encrypt and decrypt a message correctly', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const message = 'Hello, Bob!';

    const encrypted = encrypt(message, bob.publicKey, alice.secretKey);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe(message);

    const decrypted = decrypt(encrypted, alice.publicKey, bob.secretKey);
    expect(decrypted).toBe(message);
  });

  it('should produce different ciphertext for same message (due to random nonce)', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const message = 'Same message';

    const encrypted1 = encrypt(message, bob.publicKey, alice.secretKey);
    const encrypted2 = encrypt(message, bob.publicKey, alice.secretKey);

    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should fail to decrypt with wrong key', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const message = 'Secret message';

    const encrypted = encrypt(message, bob.publicKey, alice.secretKey);

    expect(() => {
      decrypt(encrypted, alice.publicKey, eve.secretKey);
    }).toThrow('Decryption failed');
  });

  it('should handle unicode and special characters', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const message = '你好世界 🚀 émojis & spëcial çhars!';

    const encrypted = encrypt(message, bob.publicKey, alice.secretKey);
    const decrypted = decrypt(encrypted, alice.publicKey, bob.secretKey);

    expect(decrypted).toBe(message);
  });

  it('should handle empty string', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const message = '';

    const encrypted = encrypt(message, bob.publicKey, alice.secretKey);
    const decrypted = decrypt(encrypted, alice.publicKey, bob.secretKey);

    expect(decrypted).toBe(message);
  });

  it('should handle large messages', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const message = 'x'.repeat(100000);

    const encrypted = encrypt(message, bob.publicKey, alice.secretKey);
    const decrypted = decrypt(encrypted, alice.publicKey, bob.secretKey);

    expect(decrypted).toBe(message);
  });
});

describe('Shared Secret Encryption', () => {
  it('should derive same shared secret from both sides', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    const aliceShared = deriveSharedSecret(bob.publicKey, alice.secretKey);
    const bobShared = deriveSharedSecret(alice.publicKey, bob.secretKey);

    expect(encodeBase64(aliceShared)).toBe(encodeBase64(bobShared));
  });

  it('should encrypt and decrypt with shared secret', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const message = 'Shared secret message';

    const sharedSecret = deriveSharedSecret(bob.publicKey, alice.secretKey);

    const encrypted = encryptWithSharedSecret(message, sharedSecret);
    const decrypted = decryptWithSharedSecret(encrypted, sharedSecret);

    expect(decrypted).toBe(message);
  });

  it('should fail to decrypt with wrong shared secret', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const eve = generateKeyPair();
    const message = 'Secret';

    const aliceShared = deriveSharedSecret(bob.publicKey, alice.secretKey);
    const eveShared = deriveSharedSecret(eve.publicKey, eve.secretKey);

    const encrypted = encryptWithSharedSecret(message, aliceShared);

    expect(() => {
      decryptWithSharedSecret(encrypted, eveShared);
    }).toThrow('Decryption failed');
  });
});

describe('Session DEK (V2 Protocol)', () => {
  it('should generate 32-byte session DEK', () => {
    const dek = generateSessionDEK();
    expect(dek).toBeInstanceOf(Uint8Array);
    expect(dek.length).toBe(32);
  });

  it('should generate unique DEKs each time', () => {
    const dek1 = generateSessionDEK();
    const dek2 = generateSessionDEK();
    expect(encodeBase64(dek1)).not.toBe(encodeBase64(dek2));
  });

  it('should encrypt and decrypt DEK correctly', () => {
    const agent = generateKeyPair();
    const dek = generateSessionDEK();

    const encryptedDEK = encryptDEK(dek, agent.publicKey);
    expect(typeof encryptedDEK).toBe('string');

    const decryptedDEK = decryptDEK(encryptedDEK, agent.secretKey);
    expect(encodeBase64(decryptedDEK)).toBe(encodeBase64(dek));
  });

  it('should produce different ciphertext for same DEK (due to ephemeral key)', () => {
    const agent = generateKeyPair();
    const dek = generateSessionDEK();

    const encrypted1 = encryptDEK(dek, agent.publicKey);
    const encrypted2 = encryptDEK(dek, agent.publicKey);

    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should fail to decrypt DEK with wrong key', () => {
    const agent = generateKeyPair();
    const eve = generateKeyPair();
    const dek = generateSessionDEK();

    const encryptedDEK = encryptDEK(dek, agent.publicKey);

    expect(() => {
      decryptDEK(encryptedDEK, eve.secretKey);
    }).toThrow('DEK decryption failed');
  });

  it('should throw if DEK is not 32 bytes', () => {
    const agent = generateKeyPair();
    const invalidDEK = new Uint8Array(16); // Too short

    expect(() => {
      encryptDEK(invalidDEK, agent.publicKey);
    }).toThrow('DEK must be 32 bytes');
  });

  it('should work end-to-end: PWA generates DEK, Agent decrypts, both use for encryption', () => {
    // Simulate V2 key exchange
    const agentKeyPair = generateKeyPair();

    // PWA generates session DEK and encrypts it for Agent
    const sessionDEK = generateSessionDEK();
    const encryptedDEK = encryptDEK(sessionDEK, agentKeyPair.publicKey);

    // Agent decrypts the DEK
    const agentDEK = decryptDEK(encryptedDEK, agentKeyPair.secretKey);

    // Both should have the same DEK
    expect(encodeBase64(agentDEK)).toBe(encodeBase64(sessionDEK));

    // Both can now encrypt/decrypt messages using the DEK as shared secret
    const message = 'Hello from PWA!';
    const encrypted = encryptWithSharedSecret(message, sessionDEK);
    const decrypted = decryptWithSharedSecret(encrypted, agentDEK);
    expect(decrypted).toBe(message);

    // Agent can respond
    const response = 'Hello from Agent!';
    const encryptedResponse = encryptWithSharedSecret(response, agentDEK);
    const decryptedResponse = decryptWithSharedSecret(encryptedResponse, sessionDEK);
    expect(decryptedResponse).toBe(response);
  });
});

describe('Signing / Verification', () => {
  it('should sign and verify a message', () => {
    const keyPair = generateSigningKeyPair();
    const message = 'Sign this message';

    const signature = sign(message, keyPair.secretKey);
    expect(typeof signature).toBe('string');

    const isValid = verify(message, signature, keyPair.publicKey);
    expect(isValid).toBe(true);
  });

  it('should fail verification with wrong public key', () => {
    const alice = generateSigningKeyPair();
    const bob = generateSigningKeyPair();
    const message = 'Signed by Alice';

    const signature = sign(message, alice.secretKey);
    const isValid = verify(message, signature, bob.publicKey);

    expect(isValid).toBe(false);
  });

  it('should fail verification with modified message', () => {
    const keyPair = generateSigningKeyPair();
    const message = 'Original message';

    const signature = sign(message, keyPair.secretKey);
    const isValid = verify('Modified message', signature, keyPair.publicKey);

    expect(isValid).toBe(false);
  });

  it('should produce different signatures for different messages', () => {
    const keyPair = generateSigningKeyPair();

    const sig1 = sign('Message 1', keyPair.secretKey);
    const sig2 = sign('Message 2', keyPair.secretKey);

    expect(sig1).not.toBe(sig2);
  });
});

describe('Key Encoding / Decoding', () => {
  it('should encode and decode key pair correctly', () => {
    const original = generateKeyPair();
    const encoded = encodeKeyPair(original);

    expect(typeof encoded.publicKey).toBe('string');
    expect(typeof encoded.secretKey).toBe('string');

    const decoded = decodeKeyPair(encoded);

    expect(encodeBase64(decoded.publicKey)).toBe(encodeBase64(original.publicKey));
    expect(encodeBase64(decoded.secretKey)).toBe(encodeBase64(original.secretKey));
  });

  it('should produce valid base64 strings', () => {
    const keyPair = generateKeyPair();
    const encoded = encodeKeyPair(keyPair);

    // Check base64 format
    expect(encoded.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(encoded.secretKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('Agent ID Generation', () => {
  it('should generate valid agent ID', () => {
    const agentId = generateAgentId();

    expect(typeof agentId).toBe('string');
    expect(agentId.length).toBeGreaterThan(0);
    // URL-safe base64 (no +, /, =)
    expect(agentId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should generate unique agent IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateAgentId());
    }
    expect(ids.size).toBe(100);
  });
});

describe('isValidBase64Key', () => {
  it('accepts a 32-byte standard base64 key', () => {
    const pk = encodeBase64(nacl.randomBytes(32));
    expect(isValidBase64Key(pk)).toBe(true);
  });

  it('rejects wrong byte length', () => {
    const sixteen = encodeBase64(nacl.randomBytes(16));
    expect(isValidBase64Key(sixteen)).toBe(false);
    expect(isValidBase64Key(sixteen, 16)).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidBase64Key('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidBase64Key(null)).toBe(false);
    expect(isValidBase64Key(undefined)).toBe(false);
    expect(isValidBase64Key(42)).toBe(false);
    expect(isValidBase64Key({})).toBe(false);
  });

  it('rejects base64url (agentId-style) input', () => {
    // generateAgentId uses URL-safe alphabet + no padding; tweetnacl-util
    // only accepts standard base64, so these must be rejected.
    expect(isValidBase64Key('FTjVcBEtjSGurpvw34_oWw')).toBe(false);
    expect(isValidBase64Key(generateAgentId())).toBe(false);
  });

  it('rejects garbage strings', () => {
    expect(isValidBase64Key('not base64!')).toBe(false);
    expect(isValidBase64Key('###')).toBe(false);
  });
});

describe('Base64 Encoding Utilities', () => {
  it('should encode and decode bytes correctly', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const encoded = encodeBase64(original);
    const decoded = decodeBase64(encoded);

    expect(decoded).toEqual(original);
  });
});

describe('tombstone signing', () => {
  it('should create and verify a valid tombstone', () => {
    const signingKeyPair = generateSigningKeyPair();
    const identityKeyPair = generateKeyPair();
    const publicKeyB64 = encodeBase64(identityKeyPair.publicKey);

    const tombstone = createTombstone(publicKeyB64, signingKeyPair.secretKey);

    expect(tombstone.type).toBe('rotated');
    expect(tombstone.oldPublicKey).toBe(publicKeyB64);
    expect(verifyTombstone(tombstone, signingKeyPair.publicKey)).toBe(true);
  });

  it('should reject a tombstone with wrong signing key', () => {
    const signingKeyPair = generateSigningKeyPair();
    const otherKeyPair = generateSigningKeyPair();
    const publicKeyB64 = encodeBase64(generateKeyPair().publicKey);

    const tombstone = createTombstone(publicKeyB64, signingKeyPair.secretKey);

    expect(verifyTombstone(tombstone, otherKeyPair.publicKey)).toBe(false);
  });
});

describe('sync blob encryption', () => {
  it('should encrypt and decrypt a sync blob', () => {
    const recipientKeyPair = generateKeyPair();
    const plaintext = JSON.stringify({
      version: 2,
      masterSecret: encodeBase64(nacl.randomBytes(32)),
      machines: [],
      exportedAt: new Date().toISOString(),
    });

    const encrypted = encryptSyncBlob(plaintext, recipientKeyPair.publicKey);
    const decrypted = decryptSyncBlob(encrypted, recipientKeyPair.secretKey);

    expect(decrypted).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', () => {
    const recipientKeyPair = generateKeyPair();
    const otherKeyPair = generateKeyPair();
    const plaintext = 'secret data';

    const encrypted = encryptSyncBlob(plaintext, recipientKeyPair.publicKey);

    expect(() => decryptSyncBlob(encrypted, otherKeyPair.secretKey)).toThrow();
  });
});

describe('SAS_ALPHABET', () => {
  it('should have exactly 32 characters', () => {
    expect(SAS_ALPHABET.length).toBe(32);
  });

  it('should not contain the ambiguous characters 0, 1, I, O', () => {
    expect(SAS_ALPHABET).not.toContain('0');
    expect(SAS_ALPHABET).not.toContain('1');
    expect(SAS_ALPHABET).not.toContain('I');
    expect(SAS_ALPHABET).not.toContain('O');
  });

  it('should only contain characters from the set 23456789A-HJ-NP-Z', () => {
    expect(SAS_ALPHABET).toMatch(/^[23456789A-HJ-NP-Z]+$/);
  });

  it('should contain all distinct characters', () => {
    const uniqueChars = new Set(SAS_ALPHABET.split(''));
    expect(uniqueChars.size).toBe(SAS_ALPHABET.length);
  });
});

describe('deriveSharedKeys', () => {
  it('should be deterministic: same secret produces same pubkeys', () => {
    const secret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) secret[i] = i;

    const a = deriveSharedKeys(secret);
    const b = deriveSharedKeys(secret);

    expect(encodeBase64(a.x25519.publicKey)).toBe(encodeBase64(b.x25519.publicKey));
    expect(encodeBase64(a.x25519.secretKey)).toBe(encodeBase64(b.x25519.secretKey));
    expect(encodeBase64(a.ed25519.publicKey)).toBe(encodeBase64(b.ed25519.publicKey));
    expect(encodeBase64(a.ed25519.secretKey)).toBe(encodeBase64(b.ed25519.secretKey));
  });

  it('should produce different pubkeys for different secrets', () => {
    const s1 = nacl.randomBytes(32);
    const s2 = nacl.randomBytes(32);

    const a = deriveSharedKeys(s1);
    const b = deriveSharedKeys(s2);

    expect(encodeBase64(a.x25519.publicKey)).not.toBe(encodeBase64(b.x25519.publicKey));
    expect(encodeBase64(a.ed25519.publicKey)).not.toBe(encodeBase64(b.ed25519.publicKey));
  });

  it('should return keys with the correct lengths', () => {
    const secret = nacl.randomBytes(32);
    const derived = deriveSharedKeys(secret);

    expect(derived.x25519.publicKey).toBeInstanceOf(Uint8Array);
    expect(derived.x25519.secretKey).toBeInstanceOf(Uint8Array);
    expect(derived.ed25519.publicKey).toBeInstanceOf(Uint8Array);
    expect(derived.ed25519.secretKey).toBeInstanceOf(Uint8Array);

    expect(derived.x25519.publicKey.length).toBe(32);
    expect(derived.x25519.secretKey.length).toBe(32);
    expect(derived.ed25519.publicKey.length).toBe(32);
    expect(derived.ed25519.secretKey.length).toBe(64);
  });

  it('should produce usable x25519 keypair (sync-blob roundtrip)', () => {
    const secret = nacl.randomBytes(32);
    const { x25519 } = deriveSharedKeys(secret);

    const plaintext = 'hello derived world';
    const encrypted = encryptSyncBlob(plaintext, x25519.publicKey);
    const decrypted = decryptSyncBlob(encrypted, x25519.secretKey);

    expect(decrypted).toBe(plaintext);
  });

  it('should produce usable ed25519 keypair (sign/verify)', () => {
    const secret = nacl.randomBytes(32);
    const { ed25519 } = deriveSharedKeys(secret);

    const message = 'sign me';
    const signature = sign(message, ed25519.secretKey);

    expect(verify(message, signature, ed25519.publicKey)).toBe(true);
  });

  it('should throw for a 0-byte master secret', () => {
    expect(() => deriveSharedKeys(new Uint8Array(0))).toThrow();
  });

  it('should throw for a 16-byte master secret', () => {
    expect(() => deriveSharedKeys(new Uint8Array(16))).toThrow();
  });

  it('should throw for a 33-byte master secret', () => {
    expect(() => deriveSharedKeys(new Uint8Array(33))).toThrow();
  });

  it('should throw for a 64-byte master secret', () => {
    expect(() => deriveSharedKeys(new Uint8Array(64))).toThrow();
  });

  it('should domain-separate x25519 and ed25519 seeds', () => {
    const secret = nacl.randomBytes(32);
    const derived = deriveSharedKeys(secret);

    expect(encodeBase64(derived.x25519.publicKey)).not.toBe(
      encodeBase64(derived.ed25519.publicKey)
    );
  });
});

describe('sasEncode', () => {
  it('should return exactly `chars` characters', () => {
    const buf = nacl.randomBytes(16);
    expect(sasEncode(buf, 6).length).toBe(6);
    expect(sasEncode(buf, 4).length).toBe(4);
    expect(sasEncode(buf, 8).length).toBe(8);
  });

  it('should produce output with only alphabet characters', () => {
    const buf = nacl.randomBytes(16);
    const out = sasEncode(buf, 6);
    for (const ch of out) {
      expect(SAS_ALPHABET).toContain(ch);
    }
  });

  it('should be deterministic', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sasEncode(buf, 6)).toBe(sasEncode(buf, 6));
    expect(sasEncode(buf, 4)).toBe(sasEncode(buf, 4));
  });

  it('should encode all-zero input to the first alphabet char repeated', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const result = sasEncode(buf, 6);
    expect(result).toBe('222222');
    expect(SAS_ALPHABET[0]).toBe('2');
  });

  it('should encode all-0xff input to the last alphabet char repeated', () => {
    const buf = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const result = sasEncode(buf, 6);
    const last = SAS_ALPHABET[SAS_ALPHABET.length - 1];
    expect(result).toBe(last.repeat(6));
  });

  it('should throw when chars is 0', () => {
    const buf = nacl.randomBytes(16);
    expect(() => sasEncode(buf, 0)).toThrow();
  });

  it('should throw when chars is negative', () => {
    const buf = nacl.randomBytes(16);
    expect(() => sasEncode(buf, -1)).toThrow();
  });

  it('should throw when chars is not an integer', () => {
    const buf = nacl.randomBytes(16);
    expect(() => sasEncode(buf, 2.5)).toThrow();
  });

  it('should throw when hmacOutput is too short for requested chars', () => {
    // 6 chars need ceil(30/8) = 4 bytes; supply only 3
    expect(() => sasEncode(new Uint8Array(3), 6)).toThrow();
  });
});

describe('sasBucket', () => {
  it('should return 0 for now=0', () => {
    expect(sasBucket(0)).toBe(0);
  });

  it('should return 0 for now=59_999 (within first 60s bucket)', () => {
    expect(sasBucket(59_999)).toBe(0);
  });

  it('should return 1 for now=60_000', () => {
    expect(sasBucket(60_000)).toBe(1);
  });

  it('should return 2 for now=120_000', () => {
    expect(sasBucket(120_000)).toBe(2);
  });

  it('should honor custom windowMs (60_000 @ 30_000 => 2)', () => {
    expect(sasBucket(60_000, 30_000)).toBe(2);
  });

  it('should honor custom windowMs (59_999 @ 30_000 => 1)', () => {
    expect(sasBucket(59_999, 30_000)).toBe(1);
  });

  it('should throw when now is negative', () => {
    expect(() => sasBucket(-1)).toThrow();
  });

  it('should throw when windowMs is 0', () => {
    expect(() => sasBucket(60_000, 0)).toThrow();
  });

  it('should throw when windowMs is negative', () => {
    expect(() => sasBucket(60_000, -1)).toThrow();
  });

  it('should throw when now is NaN', () => {
    expect(() => sasBucket(Number.NaN)).toThrow();
  });

  it('should throw when now is Infinity', () => {
    expect(() => sasBucket(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('sasCompute', () => {
  it('should return 6 characters by default from SAS_ALPHABET', () => {
    const pubkey = nacl.randomBytes(32);
    const result = sasCompute(pubkey, 0);
    expect(result.length).toBe(6);
    for (const ch of result) {
      expect(SAS_ALPHABET).toContain(ch);
    }
  });

  it('should be deterministic for same (pubkey, bucket, chars)', () => {
    const pubkey = nacl.randomBytes(32);
    const a = sasCompute(pubkey, 42);
    const b = sasCompute(pubkey, 42);
    expect(a).toBe(b);

    const c = sasCompute(pubkey, 42, 8);
    const d = sasCompute(pubkey, 42, 8);
    expect(c).toBe(d);
  });

  it('should (very likely) produce different output for adjacent buckets', () => {
    const pubkey = nacl.randomBytes(32);
    expect(sasCompute(pubkey, 100)).not.toBe(sasCompute(pubkey, 101));
  });

  it('should (very likely) produce different output for different pubkeys', () => {
    const pk1 = nacl.randomBytes(32);
    const pk2 = nacl.randomBytes(32);
    expect(sasCompute(pk1, 0)).not.toBe(sasCompute(pk2, 0));
  });

  it('should respect custom chars=4', () => {
    const pubkey = nacl.randomBytes(32);
    const result = sasCompute(pubkey, 0, 4);
    expect(result.length).toBe(4);
    for (const ch of result) {
      expect(SAS_ALPHABET).toContain(ch);
    }
  });

  it('should respect custom chars=8', () => {
    const pubkey = nacl.randomBytes(32);
    const result = sasCompute(pubkey, 0, 8);
    expect(result.length).toBe(8);
    for (const ch of result) {
      expect(SAS_ALPHABET).toContain(ch);
    }
  });

  it('should throw when pubkey is empty', () => {
    expect(() => sasCompute(new Uint8Array(0), 0)).toThrow();
  });

  it('should throw when bucket is negative', () => {
    const pubkey = nacl.randomBytes(32);
    expect(() => sasCompute(pubkey, -1)).toThrow();
  });

  it('should throw when bucket is non-integer', () => {
    const pubkey = nacl.randomBytes(32);
    expect(() => sasCompute(pubkey, 1.5)).toThrow();
  });
});
