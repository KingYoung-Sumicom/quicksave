import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import type { License } from './types.js';

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

// Re-export encoding utilities
export { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 };
