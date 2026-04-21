import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import type { License, Tombstone } from './types.js';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

// ============================================================================
// Key Generation
// ============================================================================

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generate a new X25519 key pair for encryption
 */
export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

/**
 * Generate a new Ed25519 key pair for signing
 */
export function generateSigningKeyPair(): KeyPair {
  return nacl.sign.keyPair();
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * Encrypt a message using X25519 + XSalsa20-Poly1305
 * @param message - The plaintext message
 * @param theirPublicKey - Recipient's public key
 * @param mySecretKey - Sender's secret key
 * @returns Base64 encoded encrypted message (nonce + ciphertext)
 */
export function encrypt(
  message: string,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = decodeUTF8(message);

  const encrypted = nacl.box(messageBytes, nonce, theirPublicKey, mySecretKey);

  if (!encrypted) {
    throw new Error('Encryption failed');
  }

  // Combine nonce + ciphertext
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  return encodeBase64(combined);
}

/**
 * Decrypt a message using X25519 + XSalsa20-Poly1305
 * @param encryptedMessage - Base64 encoded encrypted message (nonce + ciphertext)
 * @param theirPublicKey - Sender's public key
 * @param mySecretKey - Recipient's secret key
 * @returns Decrypted plaintext message
 */
export function decrypt(
  encryptedMessage: string,
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): string {
  const combined = decodeBase64(encryptedMessage);

  const nonce = combined.slice(0, nacl.box.nonceLength);
  const ciphertext = combined.slice(nacl.box.nonceLength);

  const decrypted = nacl.box.open(ciphertext, nonce, theirPublicKey, mySecretKey);

  if (!decrypted) {
    throw new Error('Decryption failed - invalid message or wrong key');
  }

  return encodeUTF8(decrypted);
}

// ============================================================================
// Shared Secret (for symmetric encryption)
// ============================================================================

/**
 * Derive a shared secret from key pairs (X25519)
 */
export function deriveSharedSecret(
  theirPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): Uint8Array {
  return nacl.box.before(theirPublicKey, mySecretKey);
}

/**
 * Encrypt using a pre-computed shared secret (faster for multiple messages)
 */
export function encryptWithSharedSecret(
  message: string,
  sharedSecret: Uint8Array
): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = decodeUTF8(message);

  const encrypted = nacl.secretbox(messageBytes, nonce, sharedSecret);

  if (!encrypted) {
    throw new Error('Encryption failed');
  }

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);

  return encodeBase64(combined);
}

/**
 * Decrypt using a pre-computed shared secret
 */
export function decryptWithSharedSecret(
  encryptedMessage: string,
  sharedSecret: Uint8Array
): string {
  const combined = decodeBase64(encryptedMessage);

  const nonce = combined.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = combined.slice(nacl.secretbox.nonceLength);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, sharedSecret);

  if (!decrypted) {
    throw new Error('Decryption failed - invalid message or wrong key');
  }

  return encodeUTF8(decrypted);
}

// ============================================================================
// Session DEK (Data Encryption Key) - V2 Protocol
// ============================================================================

/**
 * Generate a random 32-byte session DEK for symmetric encryption.
 * Used in V2 key exchange where PWA generates the DEK and sends it encrypted to Agent.
 */
export function generateSessionDEK(): Uint8Array {
  return nacl.randomBytes(32);
}

/**
 * Encrypt a DEK for a specific recipient using sealed box pattern.
 * Uses an ephemeral keypair so the sender's identity is not revealed.
 *
 * Format: ephemeralPublicKey (32) + nonce (24) + ciphertext
 *
 * @param dek - The 32-byte DEK to encrypt
 * @param recipientPublicKey - Recipient's X25519 public key
 * @returns Base64 encoded encrypted DEK
 */
export function encryptDEK(
  dek: Uint8Array,
  recipientPublicKey: Uint8Array
): string {
  if (dek.length !== 32) {
    throw new Error('DEK must be 32 bytes');
  }

  // Generate ephemeral keypair for this encryption
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const encrypted = nacl.box(dek, nonce, recipientPublicKey, ephemeral.secretKey);

  if (!encrypted) {
    throw new Error('DEK encryption failed');
  }

  // Combine: ephemeralPublicKey + nonce + ciphertext
  const combined = new Uint8Array(
    ephemeral.publicKey.length + nonce.length + encrypted.length
  );
  combined.set(ephemeral.publicKey);
  combined.set(nonce, ephemeral.publicKey.length);
  combined.set(encrypted, ephemeral.publicKey.length + nonce.length);

  return encodeBase64(combined);
}

/**
 * Decrypt a DEK that was encrypted for us.
 *
 * @param encryptedDEK - Base64 encoded encrypted DEK (ephemeralPubKey + nonce + ciphertext)
 * @param mySecretKey - Our X25519 secret key
 * @returns The decrypted 32-byte DEK
 */
export function decryptDEK(
  encryptedDEK: string,
  mySecretKey: Uint8Array
): Uint8Array {
  const combined = decodeBase64(encryptedDEK);

  // Extract components
  const ephemeralPublicKey = combined.slice(0, 32);
  const nonce = combined.slice(32, 32 + nacl.box.nonceLength);
  const ciphertext = combined.slice(32 + nacl.box.nonceLength);

  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, mySecretKey);

  if (!decrypted) {
    throw new Error('DEK decryption failed - invalid message or wrong key');
  }

  if (decrypted.length !== 32) {
    throw new Error('Decrypted DEK has invalid length');
  }

  return decrypted;
}

// ============================================================================
// Signing / Verification
// ============================================================================

/**
 * Sign a message using Ed25519
 */
export function sign(message: string, secretKey: Uint8Array): string {
  const messageBytes = decodeUTF8(message);
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return encodeBase64(signature);
}

/**
 * Verify an Ed25519 signature
 */
export function verify(
  message: string,
  signature: string,
  publicKey: Uint8Array
): boolean {
  const messageBytes = decodeUTF8(message);
  const signatureBytes = decodeBase64(signature);
  return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
}

// ============================================================================
// License Verification
// ============================================================================

// Quicksave's public key for license verification (Ed25519)
// This would be generated once and hardcoded
// For development, we'll generate a placeholder
const QUICKSAVE_PUBLIC_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function getQuicksavePublicKey(): Uint8Array {
  return decodeBase64(QUICKSAVE_PUBLIC_KEY_BASE64);
}

/**
 * Verify a license certificate
 */
export function verifyLicense(license: License): boolean {
  const message = `${license.version}:${license.publicKey}:${license.issuedAt}:${license.type}`;
  return verify(message, license.signature, getQuicksavePublicKey());
}

/**
 * Create a license certificate (server-side only)
 */
export function createLicense(
  userPublicKey: string,
  signingSecretKey: Uint8Array
): License {
  const license: Omit<License, 'signature'> = {
    version: 1,
    publicKey: userPublicKey,
    issuedAt: Date.now(),
    type: 'pro',
  };

  const message = `${license.version}:${license.publicKey}:${license.issuedAt}:${license.type}`;
  const signature = sign(message, signingSecretKey);

  return {
    ...license,
    signature,
  };
}

// ============================================================================
// Tombstone Signing
// ============================================================================

/**
 * Create a tombstone proving key rotation.
 * Signs the message "rotated:{oldPublicKey}" with an Ed25519 signing key.
 */
export function createTombstone(
  oldPublicKeyB64: string,
  signingSecretKey: Uint8Array
): Tombstone {
  const message = `rotated:${oldPublicKeyB64}`;
  const signature = sign(message, signingSecretKey);
  return {
    type: 'rotated',
    oldPublicKey: oldPublicKeyB64,
    signature,
  };
}

/**
 * Verify a tombstone's signature.
 */
export function verifyTombstone(
  tombstone: Tombstone,
  signingPublicKey: Uint8Array
): boolean {
  const message = `rotated:${tombstone.oldPublicKey}`;
  return verify(message, tombstone.signature, signingPublicKey);
}

// ============================================================================
// Sync Blob Encryption
// ============================================================================

/**
 * Encrypt a sync blob for a recipient using sealed-box pattern.
 * Uses the same ephemeral-key scheme as encryptDEK but without the
 * 32-byte length restriction, so arbitrary-length plaintext is supported.
 *
 * Format: ephemeralPublicKey (32) + nonce (24) + ciphertext
 */
export function encryptSyncBlob(
  plaintext: string,
  recipientPublicKey: Uint8Array
): string {
  const data = decodeUTF8(plaintext);

  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const encrypted = nacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);

  if (!encrypted) {
    throw new Error('Sync blob encryption failed');
  }

  const combined = new Uint8Array(
    ephemeral.publicKey.length + nonce.length + encrypted.length
  );
  combined.set(ephemeral.publicKey);
  combined.set(nonce, ephemeral.publicKey.length);
  combined.set(encrypted, ephemeral.publicKey.length + nonce.length);

  return encodeBase64(combined);
}

/**
 * Decrypt a sync blob using the recipient's secret key.
 *
 * Expects the same format produced by encryptSyncBlob:
 * ephemeralPublicKey (32) + nonce (24) + ciphertext
 */
export function decryptSyncBlob(
  encrypted: string,
  mySecretKey: Uint8Array
): string {
  const combined = decodeBase64(encrypted);

  const ephemeralPublicKey = combined.slice(0, 32);
  const nonce = combined.slice(32, 32 + nacl.box.nonceLength);
  const ciphertext = combined.slice(32 + nacl.box.nonceLength);

  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, mySecretKey);

  if (!decrypted) {
    throw new Error('Sync blob decryption failed - invalid message or wrong key');
  }

  return encodeUTF8(decrypted);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Encode a key pair to base64 strings for storage
 */
export function encodeKeyPair(keyPair: KeyPair): { publicKey: string; secretKey: string } {
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: encodeBase64(keyPair.secretKey),
  };
}

/**
 * Decode base64 strings back to a key pair
 */
export function decodeKeyPair(encoded: { publicKey: string; secretKey: string }): KeyPair {
  return {
    publicKey: decodeBase64(encoded.publicKey),
    secretKey: decodeBase64(encoded.secretKey),
  };
}

/**
 * Generate a random agent ID (used for signaling)
 */
export function generateAgentId(): string {
  const bytes = nacl.randomBytes(16);
  return encodeBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ============================================================================
// Shared-Secret Key Derivation (PWA sync identity)
// ============================================================================

const X25519_DOMAIN = 'quicksave-sync-x25519-v1';
const ED25519_DOMAIN = 'quicksave-sync-ed25519-v1';

function deriveSeed(masterSecret: Uint8Array, domain: string): Uint8Array {
  const domainBytes = decodeUTF8(domain);
  const input = new Uint8Array(domainBytes.length + masterSecret.length);
  input.set(domainBytes);
  input.set(masterSecret, domainBytes.length);
  return nacl.hash(input).slice(0, 32);
}

/**
 * Derive the shared X25519 and Ed25519 keypairs used by all PWA clients
 * that share this `masterSecret`. Both keypairs are fully deterministic
 * from `masterSecret` + a fixed domain string, so every PWA that holds
 * the same secret derives bit-identical pubkeys.
 */
export function deriveSharedKeys(
  masterSecret: Uint8Array
): { x25519: KeyPair; ed25519: KeyPair } {
  if (masterSecret.length !== 32) {
    throw new Error('masterSecret must be 32 bytes');
  }
  const x25519Seed = deriveSeed(masterSecret, X25519_DOMAIN);
  const ed25519Seed = deriveSeed(masterSecret, ED25519_DOMAIN);
  return {
    x25519: nacl.box.keyPair.fromSecretKey(x25519Seed),
    ed25519: nacl.sign.keyPair.fromSeed(ed25519Seed),
  };
}

// ============================================================================
// SAS (Short Authentication String) for PWA pairing
// ============================================================================

// 32 symbols, case-insensitive, removed 0/1/I/O to avoid typo ambiguity.
// 5 bits per character.
export const SAS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const SAS_DOMAIN = 'quicksave-sas-v1';

/**
 * Encode the first `chars * 5` bits of `hmacOutput` into the 32-symbol SAS
 * alphabet. Reads bits big-endian (MSB first) from consecutive bytes.
 */
export function sasEncode(hmacOutput: Uint8Array, chars: number): string {
  if (!Number.isInteger(chars) || chars <= 0) {
    throw new Error('chars must be a positive integer');
  }
  const bytesNeeded = Math.ceil((chars * 5) / 8);
  if (hmacOutput.length < bytesNeeded) {
    throw new Error(
      `hmacOutput too short: need >= ${bytesNeeded} bytes for ${chars} chars`
    );
  }
  let result = '';
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let byteIdx = 0;
  for (let i = 0; i < chars; i++) {
    while (bitsInBuffer < 5) {
      bitBuffer = (bitBuffer << 8) | hmacOutput[byteIdx++];
      bitsInBuffer += 8;
    }
    bitsInBuffer -= 5;
    const idx = (bitBuffer >> bitsInBuffer) & 0x1f;
    result += SAS_ALPHABET[idx];
  }
  return result;
}

/**
 * Compute the current bucket index for a SAS window. Default 60s window.
 * A and B only agree if they fall in the same bucket (or adjacent, checked
 * at verify time).
 */
export function sasBucket(now: number, windowMs = 60_000): number {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('now must be a non-negative finite number');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive number');
  }
  return Math.floor(now / windowMs);
}

/**
 * Compute the SAS string for a given pubkey and bucket.
 *
 * Deterministic hash of (domain || pubkey || bucket_be8); the same inputs
 * always yield the same SAS on both A and B. The "HMAC" in the design doc
 * is interpreted as "a domain-separated cryptographic hash": SAS isn't a
 * MAC (there's no secret key both sides share before pairing), it's a
 * visual comparison of two independently-computed values.
 */
export function sasCompute(
  pubkey: Uint8Array,
  bucket: number,
  chars = 6
): string {
  if (pubkey.length === 0) {
    throw new Error('pubkey must not be empty');
  }
  if (!Number.isInteger(bucket) || bucket < 0) {
    throw new Error('bucket must be a non-negative integer');
  }
  const domainBytes = decodeUTF8(SAS_DOMAIN);
  const bucketBytes = new Uint8Array(8);
  // Big-endian 64-bit encoding of the bucket index.
  const view = new DataView(
    bucketBytes.buffer,
    bucketBytes.byteOffset,
    bucketBytes.byteLength
  );
  view.setBigUint64(0, BigInt(bucket), false);
  const input = new Uint8Array(
    domainBytes.length + pubkey.length + bucketBytes.length
  );
  input.set(domainBytes);
  input.set(pubkey, domainBytes.length);
  input.set(bucketBytes, domainBytes.length + pubkey.length);
  return sasEncode(nacl.hash(input), chars);
}

// Re-export encoding utilities
export { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };
