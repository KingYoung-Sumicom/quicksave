/**
 * Agent-side client for the relay's signed HTTP push side-channel.
 *
 * Every call signs a canonical body with the agent's Ed25519 secret key.
 * The relay verifies the signature against the `signPubKey` segment of the
 * URL path; there is no pre-issued challenge, so the request is safe to
 * replay-retry up to the nonce TTL.
 *
 * Canonical body:
 *   `${action}|${signPubKey}|${ts}|${nonce}|${extra.join('|')}`
 */

import nacl from 'tweetnacl';
import { randomBytes } from 'node:crypto';
import { decodeBase64 } from '@sumicom/quicksave-shared';

export interface PushClientConfig {
  /** Agent's Ed25519 signing keypair, base64-encoded (from AgentConfig.signKeyPair). */
  signKeyPair: { publicKey: string; secretKey: string };
  /** Default relay base URL (HTTPS). Callers can override per-call. */
  defaultRelayHttpUrl: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotifyOptions {
  title?: string;
  body?: string;
  agentId?: string;
  url?: string;
  tag?: string;
  relayHttpUrl?: string;
}

export interface PushCallResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body from the relay, when the response had one. */
  body?: unknown;
  error?: string;
}

export interface NotifyResult extends PushCallResult {
  sent?: number;
  pruned?: number;
}

function bytesToB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Derive the HTTP base URL for the relay given a signaling URL.
 * `wss://host` → `https://host`, `ws://host` → `http://host`, any other
 * scheme passes through unchanged. We only care about the origin; paths on
 * the signaling URL are dropped.
 */
export function httpBaseFromSignalingUrl(signalingServer: string): string {
  try {
    const url = new URL(signalingServer);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    return url.origin;
  } catch {
    return signalingServer;
  }
}

export class PushClient {
  private readonly signPubKeyUrl: string;
  private readonly secretKey: Uint8Array;
  private readonly defaultRelayHttpUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PushClientConfig) {
    const pubBytes = decodeBase64(config.signKeyPair.publicKey);
    this.signPubKeyUrl = bytesToB64Url(pubBytes);
    this.secretKey = decodeBase64(config.signKeyPair.secretKey);
    this.defaultRelayHttpUrl = config.defaultRelayHttpUrl.replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** URL-safe base64 of the public key — used as the relay's addressing ID. */
  get signPubKey(): string {
    return this.signPubKeyUrl;
  }

  async register(subscription: PushSubscriptionJson, relayHttpUrl?: string): Promise<PushCallResult> {
    return this.post('register', [subscription.endpoint], relayHttpUrl, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    });
  }

  async unregister(endpoint: string, relayHttpUrl?: string): Promise<PushCallResult> {
    return this.post('unregister', [endpoint], relayHttpUrl, { endpoint });
  }

  async notify(sessionId: string, opts: NotifyOptions = {}): Promise<NotifyResult> {
    const body: Record<string, unknown> = { sessionId };
    if (opts.title !== undefined) body.title = opts.title;
    if (opts.body !== undefined) body.body = opts.body;
    if (opts.agentId !== undefined) body.agentId = opts.agentId;
    if (opts.url !== undefined) body.url = opts.url;
    if (opts.tag !== undefined) body.tag = opts.tag;

    const result = await this.post('notify', [sessionId], opts.relayHttpUrl, body);
    if (result.ok && result.body && typeof result.body === 'object') {
      const parsed = result.body as { sent?: number; pruned?: number };
      return { ...result, sent: parsed.sent, pruned: parsed.pruned };
    }
    return result;
  }

  private async post(
    action: 'register' | 'unregister' | 'notify',
    extra: string[],
    relayHttpUrl: string | undefined,
    bodyFields: Record<string, unknown>,
  ): Promise<PushCallResult> {
    const ts = String(Date.now());
    const nonce = bytesToB64Url(randomBytes(16));
    const canonical = [`push:${action}`, this.signPubKeyUrl, ts, nonce, ...extra].join('|');
    const sig = bytesToB64Url(nacl.sign.detached(new TextEncoder().encode(canonical), this.secretKey));

    const base = (relayHttpUrl ?? this.defaultRelayHttpUrl).replace(/\/$/, '');
    const url = `${base}/push/${this.signPubKeyUrl}/${action}`;
    const payload = { ...bodyFields, ts, nonce, sig };

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let parsed: unknown;
      try { parsed = await res.json(); } catch { parsed = undefined; }
      if (!res.ok) {
        const errMsg = (parsed && typeof parsed === 'object' && 'error' in parsed)
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
        return { ok: false, status: res.status, body: parsed, error: errMsg };
      }
      return { ok: true, status: res.status, body: parsed };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
