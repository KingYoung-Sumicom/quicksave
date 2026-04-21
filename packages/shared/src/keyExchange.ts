import { sign, verify } from './crypto.js';

/**
 * Canonical body signed by the PWA in a V2 key exchange. The agent
 * re-derives this string locally and verifies the Ed25519 signature against
 * the claimed `sigPubkey` (TOFU on first pair, pinned match on subsequent).
 *
 * Binding fields:
 * - `agentId`: prevents an envelope captured by one agent from being replayed
 *   against another agent (each agent TOFU-pins a single group identity).
 * - `sigPubkey`: prevents key-substitution — the claimed signing pubkey is
 *   itself part of the signed body, so an attacker can't swap it after the
 *   fact without re-signing.
 * - `encryptedDEK`: binds the signature to this specific handshake's DEK so a
 *   captured envelope can't be spliced with a different DEK.
 * - `timestamp`: freshness (agent enforces a ±bounded window).
 *
 * Separator `|` is not valid in base64url, so the fields cannot collide.
 */
export function canonicalKeyExchangeV2Body(params: {
  agentId: string;
  sigPubkey: string;
  encryptedDEK: string;
  timestamp: number;
}): string {
  return [
    'key-exchange-v2',
    params.agentId,
    params.sigPubkey,
    params.encryptedDEK,
    String(params.timestamp),
  ].join('|');
}

export interface SignKeyExchangeV2Input {
  agentId: string;
  encryptedDEK: string;
  timestamp: number;
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  /** base64 encoder; injected to avoid a crypto-lib-specific dependency here. */
  encodeBase64: (bytes: Uint8Array) => string;
}

export interface SignedKeyExchangeV2 {
  sigPubkey: string;
  signature: string;
}

/**
 * Produce the `sigPubkey + signature` pair the PWA attaches to the V2 key
 * exchange envelope.
 */
export function signKeyExchangeV2(
  input: SignKeyExchangeV2Input,
): SignedKeyExchangeV2 {
  const sigPubkey = input.encodeBase64(input.signingPublicKey);
  const body = canonicalKeyExchangeV2Body({
    agentId: input.agentId,
    sigPubkey,
    encryptedDEK: input.encryptedDEK,
    timestamp: input.timestamp,
  });
  const signature = sign(body, input.signingSecretKey);
  return { sigPubkey, signature };
}

export interface VerifyKeyExchangeV2Input {
  agentId: string;
  encryptedDEK: string;
  timestamp: number;
  sigPubkey: string;
  signature: string;
  /** base64 decoder (usually `decodeBase64` from crypto.ts). */
  decodeBase64: (b64: string) => Uint8Array;
}

/**
 * Verify the Ed25519 signature on a V2 key exchange. Does *not* check the
 * timestamp window or whether `sigPubkey` matches a pinned identity — the
 * caller is responsible for those policy decisions (unpaired vs paired
 * branches diverge on how to interpret `sigPubkey`).
 */
export function verifyKeyExchangeV2Signature(
  input: VerifyKeyExchangeV2Input,
): boolean {
  try {
    const body = canonicalKeyExchangeV2Body({
      agentId: input.agentId,
      sigPubkey: input.sigPubkey,
      encryptedDEK: input.encryptedDEK,
      timestamp: input.timestamp,
    });
    const pubKey = input.decodeBase64(input.sigPubkey);
    return verify(body, input.signature, pubKey);
  } catch {
    return false;
  }
}
