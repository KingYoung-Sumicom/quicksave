// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import { createPushRoutes, type PushRoutes } from './pushRoutes.js';
import { PushStore } from './pushStore.js';
import type { PushService } from './pushService.js';
import type { IncomingMessage, ServerResponse } from 'http';

class FakeRequest {
  method = 'POST';
  private listeners = new Map<string, (...args: any[]) => void>();
  constructor(private body: string) {}
  on(event: string, cb: (...args: any[]) => void): this {
    this.listeners.set(event, cb);
    return this;
  }
  destroy(): void { /* no-op */ }
  /** Simulate the full body arriving. */
  async deliver(): Promise<void> {
    await Promise.resolve();
    this.listeners.get('data')?.(Buffer.from(this.body, 'utf-8'));
    this.listeners.get('end')?.();
  }
}

class FakeResponse {
  statusCode = 0;
  body = '';
  headers: Record<string, string> = {};
  writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    Object.assign(this.headers, headers);
  }
  end(body: string): void { this.body = body; }
  json(): any { return JSON.parse(this.body); }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function signBody(
  secretKey: Uint8Array,
  action: string,
  signPubKey: string,
  extra: string[],
): { ts: string; nonce: string; sig: string } {
  const ts = String(Date.now());
  const nonce = b64url(nacl.randomBytes(16));
  const canonical = [action, signPubKey, ts, nonce, ...extra].join('|');
  const sig = b64url(nacl.sign.detached(new TextEncoder().encode(canonical), secretKey));
  return { ts, nonce, sig };
}

async function invoke(routes: PushRoutes, signPubKey: string, action: string, body: unknown) {
  const req = new FakeRequest(JSON.stringify(body));
  const res = new FakeResponse();
  routes.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse, signPubKey, action);
  await req.deliver();
  // allow any queued microtasks in the handler to finish
  await new Promise((r) => setTimeout(r, 0));
  return res;
}

describe('pushRoutes', () => {
  let store: PushStore;
  let service: PushService;
  let routes: PushRoutes;
  let serviceSend: ReturnType<typeof vi.fn> & ((...args: any[]) => Promise<any>);
  let keyPair: nacl.SignKeyPair;
  let signPubKey: string;

  beforeEach(() => {
    store = new PushStore({ flushDebounceMs: 0 });
    serviceSend = vi.fn(async (_sub: any, _payload: any) => ({ endpoint: 'https://e/1', ok: true, statusCode: 201 })) as any;
    service = { send: serviceSend } as unknown as PushService;
    routes = createPushRoutes({ store, service });
    keyPair = nacl.sign.keyPair();
    signPubKey = b64url(keyPair.publicKey);
  });

  it('register accepts a valid signed body', async () => {
    const endpoint = 'https://push.example/abc';
    const { ts, nonce, sig } = signBody(keyPair.secretKey, 'push:register', signPubKey, [endpoint]);
    const res = await invoke(routes, signPubKey, 'register', {
      ts, nonce, sig, endpoint, keys: { p256dh: 'p', auth: 'a' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.list(signPubKey).map((s) => s.endpoint)).toEqual([endpoint]);
  });

  it('register rejects a tampered body', async () => {
    const endpoint = 'https://push.example/abc';
    const { ts, nonce, sig } = signBody(keyPair.secretKey, 'push:register', signPubKey, [endpoint]);
    const res = await invoke(routes, signPubKey, 'register', {
      ts, nonce, sig,
      endpoint: 'https://push.example/tampered',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('bad-signature');
    expect(store.list(signPubKey)).toEqual([]);
  });

  it('unregister removes a subscription after verifying', async () => {
    const endpoint = 'https://push.example/abc';
    store.add(signPubKey, {
      endpoint,
      keys: { p256dh: 'p', auth: 'a' },
      registeredAt: 1,
      lastUsedAt: 1,
    });
    const { ts, nonce, sig } = signBody(keyPair.secretKey, 'push:unregister', signPubKey, [endpoint]);
    const res = await invoke(routes, signPubKey, 'unregister', { ts, nonce, sig, endpoint });
    expect(res.statusCode).toBe(200);
    expect(store.list(signPubKey)).toEqual([]);
  });

  it('notify fans out to all subscriptions and prunes gone endpoints', async () => {
    store.add(signPubKey, { endpoint: 'https://e/1', keys: { p256dh: 'p', auth: 'a' }, registeredAt: 1, lastUsedAt: 1 });
    store.add(signPubKey, { endpoint: 'https://e/2', keys: { p256dh: 'p', auth: 'a' }, registeredAt: 1, lastUsedAt: 1 });

    serviceSend.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === 'https://e/2') {
        return { endpoint: sub.endpoint, ok: false, gone: true, statusCode: 410 };
      }
      return { endpoint: sub.endpoint, ok: true, statusCode: 201 };
    });

    const sessionId = 'session-42';
    const { ts, nonce, sig } = signBody(keyPair.secretKey, 'push:notify', signPubKey, [sessionId]);
    const res = await invoke(routes, signPubKey, 'notify', { ts, nonce, sig, sessionId, title: 'T', body: 'B' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, sent: 1, pruned: 1 });
    expect(store.list(signPubKey).map((s) => s.endpoint)).toEqual(['https://e/1']);
    expect(serviceSend).toHaveBeenCalledTimes(2);
  });

  it('notify rejects replayed signatures', async () => {
    store.add(signPubKey, { endpoint: 'https://e/1', keys: { p256dh: 'p', auth: 'a' }, registeredAt: 1, lastUsedAt: 1 });
    const sessionId = 'session-42';
    const { ts, nonce, sig } = signBody(keyPair.secretKey, 'push:notify', signPubKey, [sessionId]);
    const first = await invoke(routes, signPubKey, 'notify', { ts, nonce, sig, sessionId });
    const second = await invoke(routes, signPubKey, 'notify', { ts, nonce, sig, sessionId });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.json().error).toBe('replay');
    expect(routes.stats().verifyFailures.byReason.replay).toBe(1);
  });
});
