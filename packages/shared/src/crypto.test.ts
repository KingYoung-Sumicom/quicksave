import { describe, it, expect } from 'vitest';
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
  encodeBase64,
  decodeBase64,
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

describe('Base64 Encoding Utilities', () => {
  it('should encode and decode bytes correctly', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const encoded = encodeBase64(original);
    const decoded = decodeBase64(encoded);

    expect(decoded).toEqual(original);
  });
});
