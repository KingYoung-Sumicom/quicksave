import { describe, expect, it, vi } from 'vitest';

import {
  CodexRpcClient,
  InMemoryTransport,
  RpcError,
  RpcTransportClosedError,
  type WireRequest,
  type WireResponse,
  type WireNotification,
} from '../rpcClient.js';

function setup() {
  const [clientSide, serverSide] = InMemoryTransport.pair();
  const client = new CodexRpcClient(clientSide);
  const inbound: Array<WireRequest | WireNotification> = [];
  serverSide.onMessage((m) => {
    if ('id' in m && 'method' in m) inbound.push(m as WireRequest);
    else if ('method' in m && !('id' in m)) inbound.push(m as WireNotification);
  });
  return { client, serverSide, inbound };
}

describe('CodexRpcClient — request/response correlation', () => {
  it('resolves with the matching response result', async () => {
    const { client, serverSide, inbound } = setup();

    const promise = client.request<{ ok: true }>('initialize', { foo: 'bar' });

    await flushMicrotasks();
    expect(inbound).toHaveLength(1);
    const req = inbound[0] as WireRequest;
    expect(req.method).toBe('initialize');
    expect(req.params).toEqual({ foo: 'bar' });

    await serverSide.send({
      jsonrpc: '2.0',
      id: req.id,
      result: { ok: true },
    } satisfies WireResponse);

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('demuxes interleaved responses by id', async () => {
    const { client, serverSide, inbound } = setup();

    const a = client.request<string>('a', null);
    const b = client.request<string>('b', null);
    const c = client.request<string>('c', null);
    await flushMicrotasks();
    const ids = (inbound as WireRequest[]).map((r) => r.id);
    expect(ids).toHaveLength(3);

    // Reply out of order: c, a, b.
    await serverSide.send({ jsonrpc: '2.0', id: ids[2], result: 'C' });
    await serverSide.send({ jsonrpc: '2.0', id: ids[0], result: 'A' });
    await serverSide.send({ jsonrpc: '2.0', id: ids[1], result: 'B' });

    await expect(Promise.all([a, b, c])).resolves.toEqual(['A', 'B', 'C']);
  });

  it('rejects with RpcError on a server error response', async () => {
    const { client, serverSide, inbound } = setup();

    const promise = client.request('thread/start', {});
    await flushMicrotasks();
    const req = inbound[0] as WireRequest;
    await serverSide.send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32602, message: 'invalid params', data: { hint: 'missing model' } },
    });

    await expect(promise).rejects.toBeInstanceOf(RpcError);
    await expect(promise).rejects.toMatchObject({
      code: -32602,
      data: { hint: 'missing model' },
    });
  });

  it('ignores responses with unknown ids', async () => {
    const { client, serverSide } = setup();
    const listener = vi.fn();
    client.onNotification(listener);
    await serverSide.send({ jsonrpc: '2.0', id: 999, result: 'ghost' });
    await flushMicrotasks();
    // No notification listener should fire for stray responses.
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('CodexRpcClient — notifications', () => {
  it('dispatches notifications to all listeners', async () => {
    const { client, serverSide } = setup();
    const a = vi.fn();
    const b = vi.fn();
    client.onNotification(a);
    client.onNotification(b);

    await serverSide.send({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: 'thr_1' },
    });
    await flushMicrotasks();

    expect(a).toHaveBeenCalledWith({ method: 'turn/started', params: { threadId: 'thr_1' } });
    expect(b).toHaveBeenCalledWith({ method: 'turn/started', params: { threadId: 'thr_1' } });
  });

  it('normalizes missing params to null', async () => {
    const { client, serverSide } = setup();
    const listener = vi.fn();
    client.onNotification(listener);

    await serverSide.send({ jsonrpc: '2.0', method: 'ping' });
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledWith({ method: 'ping', params: null });
  });

  it('unsubscribes cleanly', async () => {
    const { client, serverSide } = setup();
    const listener = vi.fn();
    const unsub = client.onNotification(listener);
    unsub();

    await serverSide.send({ jsonrpc: '2.0', method: 'turn/started', params: {} });
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a throwing listener', async () => {
    const { client, serverSide } = setup();
    const ok = vi.fn();
    client.onNotification(() => {
      throw new Error('boom');
    });
    client.onNotification(ok);

    await serverSide.send({ jsonrpc: '2.0', method: 'turn/started', params: {} });
    await flushMicrotasks();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('client.notify() sends a no-id payload', async () => {
    const { client, inbound } = setup();
    await client.notify('initialized');
    await flushMicrotasks();
    expect(inbound).toHaveLength(1);
    const m = inbound[0] as WireNotification;
    expect(m).toEqual({ jsonrpc: '2.0', method: 'initialized', params: undefined });
  });
});

describe('CodexRpcClient — server-initiated requests', () => {
  it('routes server requests to the registered handler and replies', async () => {
    const { client, serverSide, inbound } = setup();
    let collected: { method: string; params: unknown } | null = null;
    client.setServerRequestHandler(async (req) => {
      collected = { method: req.method, params: req.params };
      return { decision: 'allow' };
    });

    const responsePromise = new Promise<WireResponse>((resolve) => {
      const off = serverSide.onMessage((m) => {
        if ('id' in m && ('result' in m || 'error' in m)) {
          off();
          resolve(m as WireResponse);
        }
      });
    });

    await serverSide.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'item/permissions/requestApproval',
      params: { reason: 'extra writes' },
    });
    const response = await responsePromise;
    expect(collected).toEqual({
      method: 'item/permissions/requestApproval',
      params: { reason: 'extra writes' },
    });
    expect(response).toEqual({ jsonrpc: '2.0', id: 'req-1', result: { decision: 'allow' } });
    expect(inbound).toHaveLength(0); // only client→server requests are tracked above; the response is ignored by our filter.
  });

  it('responds with -32601 when no handler is registered', async () => {
    const { serverSide } = setup();
    const responsePromise = new Promise<WireResponse>((resolve) => {
      serverSide.onMessage((m) => {
        if ('id' in m && ('result' in m || 'error' in m)) resolve(m as WireResponse);
      });
    });
    await serverSide.send({
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'item/tool/call',
      params: {},
    });
    const r = await responsePromise;
    expect(r).toMatchObject({ id: 'req-2', error: { code: -32601 } });
  });

  it('responds with -32000 when the handler throws', async () => {
    const { client, serverSide } = setup();
    client.setServerRequestHandler(async () => {
      throw new Error('user denied');
    });
    const responsePromise = new Promise<WireResponse>((resolve) => {
      serverSide.onMessage((m) => {
        if ('id' in m && ('result' in m || 'error' in m)) resolve(m as WireResponse);
      });
    });
    await serverSide.send({
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'item/permissions/requestApproval',
      params: {},
    });
    const r = await responsePromise;
    expect(r).toMatchObject({
      id: 'req-3',
      error: { code: -32000, message: 'user denied' },
    });
  });
});

describe('CodexRpcClient — wire envelope tolerance (regression)', () => {
  it('accepts responses without the jsonrpc field (codex 0.125.0 shape)', async () => {
    // Codex app-server 0.125.0 omits `"jsonrpc":"2.0"` on responses.
    // Verified by `echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | codex app-server`
    // → the reply is `{"id":1,"result":{...}}` with no jsonrpc envelope.
    // We must keep accepting bare envelopes; this test fails loudly if a
    // strict validator gets reintroduced.
    const { client, serverSide, inbound } = setup();
    const promise = client.request('initialize', {});
    await flushMicrotasks();
    const req = inbound[0] as WireRequest;
    // Cast through unknown because TS tightens against missing jsonrpc.
    await serverSide.send({ id: req.id, result: { ok: true } } as unknown as WireResponse);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('accepts notifications without the jsonrpc field', async () => {
    const { client, serverSide } = setup();
    const listener = vi.fn();
    client.onNotification(listener);
    await serverSide.send({ method: 'turn/started', params: { x: 1 } } as unknown as WireNotification);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledWith({ method: 'turn/started', params: { x: 1 } });
  });
});

describe('CodexRpcClient — close behavior', () => {
  it('rejects in-flight requests on transport close', async () => {
    const { client, serverSide } = setup();
    const inFlight = client.request('long-running', {});
    await flushMicrotasks();
    await serverSide.close();
    await expect(inFlight).rejects.toBeInstanceOf(RpcTransportClosedError);
  });

  it('rejects in-flight requests on transport failure with the reason', async () => {
    const { client, serverSide } = setup();
    const inFlight = client.request('long-running', {});
    await flushMicrotasks();
    serverSide.failClose(new Error('pipe broken'));
    await expect(inFlight).rejects.toBeInstanceOf(RpcTransportClosedError);
    await expect(inFlight).rejects.toThrow(/pipe broken/);
  });

  it('rejects new requests after close', async () => {
    const { client } = setup();
    await client.close();
    await expect(client.request('any', {})).rejects.toBeInstanceOf(RpcTransportClosedError);
  });

  it('close() is idempotent', async () => {
    const { client } = setup();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.isClosed).toBe(true);
  });
});

async function flushMicrotasks(): Promise<void> {
  // Give queueMicrotask + Promise then chains a chance to run.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
