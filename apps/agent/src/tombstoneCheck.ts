// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
/**
 * Tombstone catch-up check.
 *
 * On agent connect (and after signaling reconnect), if the agent is paired,
 * ask the relay whether the pinned peer PWA has rotated. A signed tombstone
 * on `/sync/{hash(peerPWAPublicKey)}` means the PWA group destroyed this
 * identity; the agent must self-destruct (clearPeerPWA) so it can accept a
 * fresh TOFU handshake from the rotated group.
 */
import {
  decodeBase64,
  verifyTombstone,
  type Tombstone,
} from '@sumicom/quicksave-shared';

export type TombstoneCheckResult =
  | { status: 'absent' }
  | { status: 'tombstoned'; tombstone: Tombstone }
  | { status: 'verify-failed'; reason: string }
  | { status: 'error'; error: string };

/** Relay-side convention: keyHash is the URL-safe base64 of the pubkey string. */
export function hashPublicKey(publicKey: string): string {
  return publicKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Verify a tombstone payload against the pinned peer keys. Reused by both the
 * catch-up GET path and the WS push path so the trust rules stay in one place:
 * the `oldPublicKey` field must match the pinned peer X25519 pubkey, and the
 * Ed25519 signature must verify against the pinned signing pubkey. Any
 * deviation is surfaced as `verify-failed` or `error` — the caller decides
 * whether to act.
 */
export function verifyTombstonePayload(
  data: string,
  peerPWAPublicKey: string,
  peerPWASignPublicKey: string,
): TombstoneCheckResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { status: 'verify-failed', reason: 'tombstone data not valid JSON' };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { type?: unknown }).type !== 'rotated' ||
    typeof (parsed as { oldPublicKey?: unknown }).oldPublicKey !== 'string' ||
    typeof (parsed as { signature?: unknown }).signature !== 'string'
  ) {
    return { status: 'verify-failed', reason: 'malformed tombstone shape' };
  }
  const tombstone = parsed as Tombstone;

  // The tombstone must reference the exact pubkey we have pinned. A valid
  // signature over a *different* oldPublicKey would mean the attacker replayed
  // a tombstone from some other group onto this mailbox — we're not fooled.
  if (tombstone.oldPublicKey !== peerPWAPublicKey) {
    return { status: 'verify-failed', reason: 'tombstone oldPublicKey mismatch' };
  }

  let signingPk: Uint8Array;
  try {
    signingPk = decodeBase64(peerPWASignPublicKey);
  } catch {
    return { status: 'error', error: 'invalid pinned signing pubkey' };
  }

  const ok = verifyTombstone(tombstone, signingPk);
  if (!ok) return { status: 'verify-failed', reason: 'signature verify failed' };

  return { status: 'tombstoned', tombstone };
}

/** `wss://host` → `https://host`; pass-through for already-HTTP urls. */
export function signalingServerToHttp(url: string): string {
  if (url.startsWith('wss://')) return 'https://' + url.slice('wss://'.length);
  if (url.startsWith('ws://')) return 'http://' + url.slice('ws://'.length);
  return url;
}

export interface CheckTombstoneOptions {
  signalingServer: string;
  peerPWAPublicKey: string;
  peerPWASignPublicKey: string;
  fetchImpl?: typeof fetch;
}

export async function checkTombstone(
  opts: CheckTombstoneOptions,
): Promise<TombstoneCheckResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const base = signalingServerToHttp(opts.signalingServer);
  const hash = hashPublicKey(opts.peerPWAPublicKey);

  let res: Response;
  try {
    res = await fetchFn(`${base}/sync/${hash}`, { method: 'GET' });
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }

  // 404 (nothing stored yet) or 200 (normal blob) both mean "no tombstone".
  if (res.status === 404 || res.status === 200) return { status: 'absent' };
  if (res.status !== 410) {
    return { status: 'error', error: `unexpected HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', error: 'invalid JSON response' };
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { data?: unknown }).data !== 'string'
  ) {
    return { status: 'error', error: 'missing tombstone data field' };
  }

  return verifyTombstonePayload(
    (body as { data: string }).data,
    opts.peerPWAPublicKey,
    opts.peerPWASignPublicKey,
  );
}
