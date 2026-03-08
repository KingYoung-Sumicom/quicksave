# Security

## Overview

The relay server performs **no authentication or encryption**. All security is end-to-end between agent and PWA using NaCl cryptographic primitives (via `tweetnacl`).

The server's only security-related validation is checking that the `from` field on routed messages matches the sender's registered identity — preventing connection impersonation.

## Cryptographic Primitives

All crypto lives in `packages/shared/src/crypto.ts`:

| Function | Algorithm | Purpose |
|----------|-----------|---------|
| `generateKeyPair()` | X25519 | Encryption key pairs |
| `generateSigningKeyPair()` | Ed25519 | Signing key pairs |
| `encrypt()` / `decrypt()` | X25519 + XSalsa20-Poly1305 | Asymmetric authenticated encryption |
| `deriveSharedSecret()` | X25519 Diffie-Hellman | Pre-compute shared key |
| `encryptWithSharedSecret()` / `decryptWithSharedSecret()` | XSalsa20-Poly1305 | Symmetric encryption with pre-shared key |
| `generateSessionDEK()` | Random 32 bytes | Session Data Encryption Key |
| `encryptDEK()` / `decryptDEK()` | Sealed box (ephemeral X25519) | Encrypt/decrypt DEK for a recipient |
| `sign()` / `verify()` | Ed25519 detached | Message signing and verification |
| `encryptSyncBlob()` / `decryptSyncBlob()` | Sealed box | Encrypt/decrypt sync store blobs |
| `generateAgentId()` | Random 16 bytes → URL-safe base64 | Generate random agent IDs |

## Key Exchange (V2)

The V2 key exchange establishes a session encryption key between PWA and agent:

```
PWA                          Server                        Agent
 │                             │                             │
 │  1. Generate session DEK    │                             │
 │  2. Encrypt DEK with        │                             │
 │     agent's public key      │                             │
 │     (sealed box)            │                             │
 │                             │                             │
 │──KeyExchangeV2─────────────►│──────────────────────────►│
 │  {encryptedDEK, timestamp}  │                           │
 │                             │                           │ 3. Decrypt DEK
 │                             │                           │    with secret key
 │◄────────────────────────────│◄──KeyExchangeV2Ack────────│
 │                             │                             │
 │◄════════════════════════════╪═════════════════════════════╡
 │        All messages encrypted with session DEK            │
```

```typescript
interface KeyExchangeV2 {
  type: 'key-exchange';
  version: 2;
  encryptedDEK: string;  // sealed-box ciphertext
  timestamp: number;      // replay protection
}
```

**Properties:**
- The sealed-box pattern means the relay server cannot derive the DEK even if it wanted to
- The sender's identity is not revealed in the ciphertext (ephemeral key pair used)
- The `timestamp` provides replay protection
- After exchange, all application messages use symmetric encryption with the shared DEK

## Sync Store Security

The sync store holds encrypted pairing backups so PWAs can restore state across sessions:

1. **Blobs** are encrypted with `encryptSyncBlob()` (sealed box) using the PWA's own public key. Only the PWA with the corresponding secret key can decrypt.

2. **Tombstones** are Ed25519-signed proofs of key rotation. They permanently seal a key's storage slot, preventing an attacker from overwriting rotated-key data.

3. The `keyHash` in the URL is derived from the PWA's public key, so storage slots are bound to key identity.

## Licensing

Licenses are verified at the agent layer, not by the relay server:

```typescript
interface License {
  version: 1;
  publicKey: string;   // user's base64 public key
  issuedAt: number;
  type: 'pro';
  signature: string;   // Ed25519 signed by Quicksave's key
}
```

The license is sent in the `HandshakePayload` from PWA to agent. The agent calls `verifyLicense()` to validate the Ed25519 signature against Quicksave's public key.

## What the Server Does NOT Do

- No TLS termination (expected to run behind a reverse proxy)
- No authentication of connecting clients
- No payload inspection or decryption
- No license verification
- No session management beyond connection tracking
