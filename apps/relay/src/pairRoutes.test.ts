// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRelay } from '@sumicom/ws-relay';
import type { RelayInstance } from '@sumicom/ws-relay';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo, Socket } from 'net';
import {
  PairStore,
  PairStoreFullError,
  PairStoreTooLargeError,
} from './pairStore.js';

// ── Test harness ────────────────────────────────────────────────────────────

// Port 0 makes the OS pick an unused port; the real port is read off the
// server after listen(). Using a fixed port caused EADDRINUSE flakes under
// beforeEach/afterEach because TIME_WAIT didn't release the socket fast
// enough between tests.
let BASE_URL: string;

interface RelayOptions {
  maxSlots?: number;
  maxDataSize?: number;
  ttlMs?: number;
}

interface TestHarness {
  relay: RelayInstance;
  store: PairStore;
  openSockets: Set<Socket>;
}

/**
 * Spin up a real HTTP server with just the pair-request routes wired.
 * Mirrors the handlePairRequest logic from index.ts.
 */
async function createTestRelay(opts: RelayOptions = {}): Promise<TestHarness> {
  const store = new PairStore({
    maxSlots: opts.maxSlots,
    maxDataSize: opts.maxDataSize,
    ttlMs: opts.ttlMs,
  });

  function handlePairRequest(
    req: IncomingMessage,
    res: ServerResponse,
    addr: string,
    subscribe: boolean,
  ): void {
    if (subscribe) {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Flush headers immediately by writing an SSE comment — otherwise
      // Node buffers them until the first body chunk, which can deadlock
      // fetch() clients waiting on the response.
      res.write(': ok\n\n');
      for (const slot of store.getSlots(addr)) {
        res.write(`event: slot\ndata: ${JSON.stringify(slot)}\n\n`);
      }
      const unsub = store.subscribe(addr, (slot) => {
        res.write(`event: slot\ndata: ${JSON.stringify(slot)}\n\n`);
      });
      const teardown = () => {
        unsub();
        try {
          res.end();
        } catch {
          // ignore
        }
      };
      req.on('close', teardown);
      req.on('error', teardown);
      return;
    }

    if (req.method === 'GET') {
      const slots = store.getSlots(addr);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slots }));
      return;
    }

    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: { data?: unknown; kind?: unknown };
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON body' }));
            return;
          }
          if (
            typeof parsed.data !== 'string' ||
            parsed.data.length === 0
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'data field required (string)' }));
            return;
          }
          const kind =
            typeof parsed.kind === 'string' && parsed.kind.length > 0
              ? parsed.kind
              : undefined;
          const { id, mailboxExpiresAt } = store.postSlot(addr, {
            data: parsed.data,
            kind,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, mailboxExpiresAt }));
        } catch (err) {
          if (err instanceof PairStoreFullError) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'mailbox full' }));
            return;
          }
          if (err instanceof PairStoreTooLargeError) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          const message = err instanceof Error ? err.message : 'unknown error';
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
      });
      return;
    }

    if (req.method === 'DELETE') {
      store.deleteMailbox(addr);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  }

  const relay = createRelay({
    port: 0,
    keyStore: false,
    blobStore: false,
    channels: [{ name: 'agent', onDuplicate: 'reject' }],
    hooks: {
      onHttpRequest(req, res, next) {
        const pairMatch = req.url?.match(
          /^\/pair-requests\/([A-Za-z0-9_-]{8,128})(\/subscribe)?(?:\?.*)?$/,
        );
        if (pairMatch) {
          handlePairRequest(req, res, pairMatch[1], !!pairMatch[2]);
          return;
        }
        next();
      },
    },
  });

  // Track open sockets so teardown can forcibly close long-lived SSE
  // connections (server.close() otherwise waits for them to drain).
  const openSockets = new Set<Socket>();
  relay.server.on('connection', (socket: Socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });

  // Wait for the server to bind its OS-assigned port before returning,
  // so callers can derive BASE_URL from server.address().
  await new Promise<void>((resolve, reject) => {
    if (relay.server.listening) {
      resolve();
      return;
    }
    relay.server.once('listening', () => resolve());
    relay.server.once('error', reject);
  });
  const addr = relay.server.address() as AddressInfo;
  BASE_URL = `http://localhost:${addr.port}`;

  return { relay, store, openSockets };
}

async function teardown(harness: TestHarness): Promise<void> {
  // Destroy any lingering sockets (e.g. SSE streams) before close() so the
  // server doesn't hang waiting for them to drain.
  for (const socket of harness.openSockets) socket.destroy();
  harness.openSockets.clear();
  harness.relay.close();
  await new Promise<void>((resolve) =>
    harness.relay.server.close(() => resolve()),
  );
}

// ── SSE helper ──────────────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Consume an SSE stream and push parsed events as they arrive.
 * Returns { events, cancel } — cancel aborts the underlying fetch.
 */
function consumeSse(res: { body: ReadableStream<Uint8Array> | null }): {
  events: SseEvent[];
  done: Promise<void>;
  cancel: () => void;
} {
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cancelled = false;

  const done = (async () => {
    while (!cancelled) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Parse SSE: events separated by blank lines
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice('event: '.length);
          else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
          // lines starting with ":" are comments (pings) — skip
        }
        if (dataLines.length > 0) {
          events.push({ event: eventName, data: dataLines.join('\n') });
        }
      }
    }
  })();

  const cancel = () => {
    cancelled = true;
    reader.cancel().catch(() => {});
  };

  return { events, done, cancel };
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForCondition timed out');
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

// Minimal fetch-compatible client built on Node's http module. Avoids the
// undici connection pool that can leak stale sockets across per-test server
// restarts. Body can be streamed incrementally via the onBody option.
interface TestFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

interface TestFetchResponse {
  status: number;
  headers: Map<string, string>;
  headerGet(name: string): string | null;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
  destroy(): void;
}

function testFetch(url: string, init: TestFetchInit = {}): Promise<TestFetchResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: { Connection: 'close', ...(init.headers ?? {}) },
        agent: false, // disable keep-alive pooling completely
      },
      (res) => {
        const headers = new Map<string, string>();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers.set(k.toLowerCase(), v);
          else if (Array.isArray(v)) headers.set(k.toLowerCase(), v.join(', '));
        }
        // Bridge Node IncomingMessage to a Web ReadableStream.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on('end', () => {
              try {
                controller.close();
              } catch {
                // ignore — already closed via cancel()
              }
            });
            res.on('error', (err) => {
              try {
                controller.error(err);
              } catch {
                // ignore
              }
            });
          },
          cancel() {
            res.destroy();
            req.destroy();
          },
        });

        const consume = async () => {
          const reader = body.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          return new TextDecoder().decode(merged);
        };

        const response: TestFetchResponse = {
          status: res.statusCode ?? 0,
          headers,
          headerGet: (name: string) => headers.get(name.toLowerCase()) ?? null,
          body,
          text: consume,
          json: async () => JSON.parse(await consume()),
          destroy: () => {
            res.destroy();
            req.destroy();
          },
        };
        resolve(response);
      },
    );
    req.on('error', reject);
    if (init.signal) {
      init.signal.addEventListener('abort', () => {
        req.destroy();
      });
    }
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

describe('pair-routes HTTP', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestRelay();
  });

  afterEach(async () => {
    await teardown(harness);
  });

  describe('POST /pair-requests/{addr}', () => {
    it('returns 201 with {id, mailboxExpiresAt} and persists the slot', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'ciphertext', kind: 'offer' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; mailboxExpiresAt: number };
      expect(typeof body.id).toBe('string');
      expect(body.id.length).toBeGreaterThan(0);
      expect(typeof body.mailboxExpiresAt).toBe('number');

      const slots = harness.store.getSlots('addr12345');
      expect(slots).toHaveLength(1);
      expect(slots[0].data).toBe('ciphertext');
      expect(slots[0].kind).toBe('offer');
      expect(slots[0].id).toBe(body.id);
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/invalid JSON/i);
    });

    it('returns 400 when data field is missing', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'offer' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/data field required/i);
    });

    it('returns 400 when data is an empty string', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /pair-requests/{addr}', () => {
    it('returns 200 with {slots: [...]} in post order', async () => {
      // Post two slots
      await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'first' }),
      });
      await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'second' }),
      });

      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        slots: { id: string; data: string }[];
      };
      expect(body.slots).toHaveLength(2);
      expect(body.slots[0].data).toBe('first');
      expect(body.slots[1].data).toBe('second');
    });

    it('returns 200 with empty array for unknown addr', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/unknown0`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { slots: unknown[] };
      expect(body.slots).toEqual([]);
    });
  });

  describe('error paths', () => {
    it('returns 409 when mailbox is full', async () => {
      await teardown(harness);
      harness = await createTestRelay({ maxSlots: 1 });

      const first = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'a' }),
      });
      expect(first.status).toBe(201);

      const second = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'b' }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: string };
      expect(body.error).toMatch(/mailbox full/i);
    });

    it('returns 413 when data exceeds maxDataSize', async () => {
      await teardown(harness);
      harness = await createTestRelay({ maxDataSize: 10 });

      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'x'.repeat(50) }),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/max size/i);
    });

    it('returns 405 for unsupported HTTP method (PATCH)', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(405);
    });

    it('returns 404 when addr is too short (route regex does not match)', async () => {
      // "/pair-requests/abc" has addr length 3, below min 8 → regex fails
      // → next() is called → default handler returns 404.
      const res = await testFetch(`${BASE_URL}/pair-requests/abc`);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /pair-requests/{addr}', () => {
    it('returns 204 and clears slots', async () => {
      await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'a' }),
      });

      const delRes = await testFetch(`${BASE_URL}/pair-requests/addr12345`, {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(204);

      const getRes = await testFetch(`${BASE_URL}/pair-requests/addr12345`);
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as { slots: unknown[] };
      expect(body.slots).toEqual([]);
    });

    it('is idempotent for unknown addr', async () => {
      const res = await testFetch(`${BASE_URL}/pair-requests/neverseen`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);
    });
  });

  describe('SSE /pair-requests/{addr}/subscribe', () => {
    it('establishes stream with SSE headers', async () => {
      const controller = new AbortController();
      const res = await testFetch(
        `${BASE_URL}/pair-requests/addr12345/subscribe`,
        { signal: controller.signal },
      );
      expect(res.status).toBe(200);
      expect(res.headerGet('content-type')).toMatch(/text\/event-stream/);
      expect(res.headerGet('cache-control')).toMatch(/no-cache/);
      controller.abort();
      // Allow any rejection from the aborted body to settle silently
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
    });

    it('delivers event: slot to a subscriber when POST hits the same addr', async () => {
      const controller = new AbortController();
      const res = await testFetch(
        `${BASE_URL}/pair-requests/addrabcd1234/subscribe`,
        { signal: controller.signal },
      );
      expect(res.status).toBe(200);
      const sse = consumeSse(res);

      // Wait until the server has registered the subscriber.
      await waitForCondition(() => harness.store.stats.subscribers >= 1);

      // Post a slot via another request.
      const postRes = await testFetch(
        `${BASE_URL}/pair-requests/addrabcd1234`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'hi-there', kind: 'offer' }),
        },
      );
      expect(postRes.status).toBe(201);

      // Wait for the event to arrive on the SSE stream.
      await waitForCondition(() => sse.events.length >= 1);
      expect(sse.events[0].event).toBe('slot');
      const payload = JSON.parse(sse.events[0].data) as {
        id: string;
        data: string;
        kind?: string;
      };
      expect(payload.data).toBe('hi-there');
      expect(payload.kind).toBe('offer');

      // Clean up
      sse.cancel();
      controller.abort();
    });

    it('flushes existing slots to late subscribers', async () => {
      // Post first, then subscribe — late subscriber should receive the backlog.
      const postRes = await testFetch(
        `${BASE_URL}/pair-requests/addrlate12345`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Connection: 'close',
          },
          body: JSON.stringify({ data: 'backlog' }),
        },
      );
      expect(postRes.status).toBe(201);
      // Drain body so the socket is eligible for disposal before the next
      // request (prevents undici keepalive from reusing a stale socket).
      await postRes.text();

      const controller = new AbortController();
      const res = await testFetch(
        `${BASE_URL}/pair-requests/addrlate12345/subscribe`,
        {
          signal: controller.signal,
          headers: { Connection: 'close' },
        },
      );
      const sse = consumeSse(res);

      await waitForCondition(() => sse.events.length >= 1);
      const parsed = JSON.parse(sse.events[0].data) as { data: string };
      expect(parsed.data).toBe('backlog');

      sse.cancel();
      controller.abort();
    });

    it('closing the client disconnects; subsequent POST does not error server-side', async () => {
      const controller = new AbortController();
      const res = await testFetch(
        `${BASE_URL}/pair-requests/addrclose1234/subscribe`,
        { signal: controller.signal },
      );
      const sse = consumeSse(res);
      await waitForCondition(() => harness.store.stats.subscribers >= 1);

      // Abort the client — server should tear down and drop listener.
      sse.cancel();
      controller.abort();

      await waitForCondition(() => harness.store.stats.subscribers === 0);

      // Subsequent POST should still succeed without errors.
      const postRes = await testFetch(
        `${BASE_URL}/pair-requests/addrclose1234`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: 'after-close' }),
        },
      );
      expect(postRes.status).toBe(201);
    });

    it('rejects non-GET methods with 405', async () => {
      const res = await testFetch(
        `${BASE_URL}/pair-requests/addrmethod12/subscribe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      expect(res.status).toBe(405);
    });
  });

  // NOTE: rate-limiting (429) is driven by a module-level counter inside
  // src/index.ts and is not exposed via the PairStore API. Since we wire our
  // own handler in this test (to avoid the production singleton), the
  // rate-limit path is not reachable here. Skipping per spec.
});
