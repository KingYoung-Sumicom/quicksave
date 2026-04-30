// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { IncomingMessage, ServerResponse } from 'http';
import { PushStore, type PushSubscriptionRecord } from './pushStore.js';
import { PushService, type NotifyPayload } from './pushService.js';
import { TtlNonceCache, verifySignedRequest, TS_WINDOW_MS } from './sigVerify.js';

interface FailureCounters {
  total: number;
  byReason: Record<string, number>;
}

export interface PushRoutesMetrics {
  onVerifyFailure?(reason: string): void;
  onNotifyOutcome?(outcome: 'sent' | 'pruned' | 'failed', count: number): void;
}

export interface PushRoutesDeps {
  store: PushStore;
  service: PushService;
  metrics?: PushRoutesMetrics;
}

export interface PushRoutes {
  handle(req: IncomingMessage, res: ServerResponse, signPubKey: string, action: string): boolean;
  stats(): { store: PushStore['stats']; verifyFailures: FailureCounters };
}

const MAX_BODY_BYTES = 16 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) { resolve(null); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function getString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

export function createPushRoutes(deps: PushRoutesDeps): PushRoutes {
  const nonceCache = new TtlNonceCache();
  const failures: FailureCounters = { total: 0, byReason: {} };

  function bumpFailure(reason: string): void {
    failures.total++;
    failures.byReason[reason] = (failures.byReason[reason] ?? 0) + 1;
    deps.metrics?.onVerifyFailure?.(reason);
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse, signPubKey: string): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(req); }
    catch (err) {
      respond(res, 400, { error: (err as Error).message });
      return;
    }

    const ts = getString(body, 'ts');
    const nonce = getString(body, 'nonce');
    const sig = getString(body, 'sig');
    const endpoint = getString(body, 'endpoint');
    const p256dh = getString((body as any)?.keys, 'p256dh');
    const auth = getString((body as any)?.keys, 'auth');

    if (!endpoint || !p256dh || !auth) {
      respond(res, 400, { error: 'missing subscription fields' });
      return;
    }

    const verify = verifySignedRequest({
      action: 'push:register',
      signPubKey,
      ts,
      nonce,
      sig,
      extra: [endpoint],
      cache: nonceCache,
    });
    if (!verify.ok) {
      bumpFailure(verify.reason);
      respond(res, 401, {
        error: verify.reason,
        serverTime: verify.serverTime,
        tsWindowMs: TS_WINDOW_MS,
      });
      return;
    }

    const now = verify.now;
    const record: PushSubscriptionRecord = {
      endpoint,
      keys: { p256dh, auth },
      registeredAt: now,
      lastUsedAt: now,
    };
    deps.store.add(signPubKey, record);
    respond(res, 200, { ok: true });
  }

  async function handleUnregister(req: IncomingMessage, res: ServerResponse, signPubKey: string): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(req); }
    catch (err) {
      respond(res, 400, { error: (err as Error).message });
      return;
    }

    const ts = getString(body, 'ts');
    const nonce = getString(body, 'nonce');
    const sig = getString(body, 'sig');
    const endpoint = getString(body, 'endpoint');
    if (!endpoint) { respond(res, 400, { error: 'missing endpoint' }); return; }

    const verify = verifySignedRequest({
      action: 'push:unregister',
      signPubKey,
      ts,
      nonce,
      sig,
      extra: [endpoint],
      cache: nonceCache,
    });
    if (!verify.ok) {
      bumpFailure(verify.reason);
      respond(res, 401, { error: verify.reason, serverTime: verify.serverTime });
      return;
    }

    const removed = deps.store.removeByEndpoint(endpoint, signPubKey);
    respond(res, 200, { ok: true, removed });
  }

  async function handleNotify(req: IncomingMessage, res: ServerResponse, signPubKey: string): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(req); }
    catch (err) {
      respond(res, 400, { error: (err as Error).message });
      return;
    }

    const ts = getString(body, 'ts');
    const nonce = getString(body, 'nonce');
    const sig = getString(body, 'sig');
    const sessionId = getString(body, 'sessionId');
    const title = getString(body, 'title') ?? 'Quicksave';
    const message = getString(body, 'body') ?? '';
    const agentId = getString(body, 'agentId');
    const url = getString(body, 'url');
    const tag = getString(body, 'tag');

    if (!sessionId) {
      respond(res, 400, { error: 'missing sessionId' });
      return;
    }

    const verify = verifySignedRequest({
      action: 'push:notify',
      signPubKey,
      ts,
      nonce,
      sig,
      extra: [sessionId],
      cache: nonceCache,
    });
    if (!verify.ok) {
      bumpFailure(verify.reason);
      respond(res, 401, { error: verify.reason, serverTime: verify.serverTime });
      return;
    }

    const subs = deps.store.list(signPubKey);
    if (subs.length === 0) {
      respond(res, 200, { ok: true, sent: 0, pruned: 0 });
      return;
    }

    const payload: NotifyPayload = {
      title,
      body: message,
      sessionId,
      agentId,
      url,
      tag,
    };

    let sent = 0;
    let pruned = 0;
    let failed = 0;
    const now = verify.now;
    await Promise.all(subs.map(async (sub) => {
      const outcome = await deps.service.send(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
      );
      if (outcome.ok) {
        sent++;
        deps.store.touch(signPubKey, sub.endpoint, now);
      } else if (outcome.gone) {
        pruned++;
        deps.store.removeByEndpoint(sub.endpoint, signPubKey);
      } else {
        failed++;
        console.warn('[push] send failed', { endpoint: sub.endpoint, status: outcome.statusCode, err: outcome.error });
      }
    }));

    if (sent > 0) deps.metrics?.onNotifyOutcome?.('sent', sent);
    if (pruned > 0) deps.metrics?.onNotifyOutcome?.('pruned', pruned);
    if (failed > 0) deps.metrics?.onNotifyOutcome?.('failed', failed);

    respond(res, 200, { ok: true, sent, pruned });
  }

  return {
    handle(req, res, signPubKey, action): boolean {
      if (req.method !== 'POST') {
        respond(res, 405, { error: 'method not allowed' });
        return true;
      }
      switch (action) {
        case 'register':
          void handleRegister(req, res, signPubKey);
          return true;
        case 'unregister':
          void handleUnregister(req, res, signPubKey);
          return true;
        case 'notify':
          void handleNotify(req, res, signPubKey);
          return true;
        default:
          return false;
      }
    },
    stats() {
      return {
        store: deps.store.stats,
        verifyFailures: { total: failures.total, byReason: { ...failures.byReason } },
      };
    },
  };
}
