import { describe, expect, it, vi } from 'vitest';
import { MessageBusClient } from './client.js';
import { MessageBusServer } from './server.js';
import { FakePipe } from './transports/fake.js';

/** Wait a few microtasks so both sides flush queued deliveries. */
async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe('MessageBus e2e', () => {
  it('command round-trips over the fake pipe', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    server.onCommand<{ a: number; b: number }, number>(
      'add',
      (p) => p.a + p.b,
    );
    const clientTransport = pipe.createClient();
    const client = new MessageBusClient(clientTransport);
    clientTransport.connect();
    await flush();

    const result = await client.command<number>('add', { a: 2, b: 5 });
    expect(result).toBe(7);
  });

  it('subscribe delivers snapshot then update', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    const store = new Map<string, { value: number }>();
    store.set('a', { value: 10 });
    server.onSubscribe<'/items/:id', { value: number }, { value: number }>(
      '/items/:id',
      {
        snapshot: ({ params }) =>
          store.get(params.id) ?? { value: -1 },
      },
    );
    const clientTransport = pipe.createClient();
    const client = new MessageBusClient(clientTransport);
    clientTransport.connect();
    await flush();

    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    client.subscribe<{ value: number }, { value: number }>('/items/a', {
      onSnapshot,
      onUpdate,
    });
    await flush();
    expect(onSnapshot).toHaveBeenCalledWith({ value: 10 });

    server.publish('/items/a', { value: 42 });
    await flush();
    expect(onUpdate).toHaveBeenCalledWith({ value: 42 });
  });

  it('two clients receive independent snapshots and shared updates', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    let snapN = 0;
    server.onSubscribe<'/counter'>('/counter', {
      snapshot: () => ({ n: ++snapN }),
    });

    const t1 = pipe.createClient();
    const t2 = pipe.createClient();
    const c1 = new MessageBusClient(t1);
    const c2 = new MessageBusClient(t2);
    t1.connect();
    t2.connect();
    await flush();

    const snap1 = vi.fn();
    const snap2 = vi.fn();
    const upd1 = vi.fn();
    const upd2 = vi.fn();
    c1.subscribe('/counter', { onSnapshot: snap1, onUpdate: upd1 });
    c2.subscribe('/counter', { onSnapshot: snap2, onUpdate: upd2 });
    await flush();
    expect(snap1).toHaveBeenCalledWith({ n: 1 });
    expect(snap2).toHaveBeenCalledWith({ n: 2 });

    expect(server.publish('/counter', { n: 99 })).toBe(2);
    await flush();
    expect(upd1).toHaveBeenCalledWith({ n: 99 });
    expect(upd2).toHaveBeenCalledWith({ n: 99 });
  });

  it('updates stop reaching a client after it disconnects', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    server.onSubscribe('/x', { snapshot: () => ({ v: 0 }) });
    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    const upd = vi.fn();
    c.subscribe('/x', { onSnapshot: vi.fn(), onUpdate: upd });
    await flush();
    expect(server.publish('/x', { v: 1 })).toBe(1);
    await flush();
    expect(upd).toHaveBeenCalledTimes(1);

    t.disconnect();
    await flush();
    expect(server.publish('/x', { v: 2 })).toBe(0);
  });

  it('async snapshot handler: a publish during the await cannot roll state back', async () => {
    // Real-world shape of the bug fixed by seq numbers. The server adds the
    // peer to its `active` map before awaiting the snapshot handler; any
    // publish during that await sends an `upd` to the new peer and wins the
    // race on the wire. Without seq, the late snapshot (pre-publish data)
    // would overwrite the newer state. With seq, the client drops the stale
    // snapshot and keeps the update.
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    let state = { v: 'initial' };
    let resolveSnap: ((v: { v: string }) => void) | undefined;
    server.onSubscribe('/state', {
      snapshot: () =>
        new Promise<{ v: string }>((resolve) => {
          resolveSnap = resolve;
        }),
    });

    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    let latest: { v: string } | undefined;
    c.subscribe('/state', {
      onSnapshot: (d) => {
        latest = d as { v: string };
      },
      onUpdate: (d) => {
        latest = d as { v: string };
      },
    });
    // Let the server see the `sub` frame and enter the await.
    await flush();

    // A publisher mutates state and publishes while the handler is still
    // awaiting. The upd is dispatched to the subscribed peer immediately.
    state = { v: 'after-publish' };
    server.publish('/state', state);
    await flush();
    expect(latest).toEqual({ v: 'after-publish' });

    // Snapshot handler resolves with pre-publish data. The snap frame is
    // now sent but carries an older seq — the client must drop it.
    resolveSnap!({ v: 'initial' });
    await flush();
    expect(latest).toEqual({ v: 'after-publish' });
  });

  it('getSnapshot returns the current snap without creating a subscription', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    let state = { v: 'first' };
    const onSubscribed = vi.fn();
    const onUnsubscribed = vi.fn();
    server.onSubscribe('/state', {
      snapshot: () => state,
      onSubscribed,
      onUnsubscribed,
    });
    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    const snap = await c.getSnapshot<{ v: string }>('/state');
    expect(snap).toEqual({ v: 'first' });

    // One-shot: no subscription registered on server.
    expect(server.subscriberCount('/state')).toBe(0);
    expect(onSubscribed).not.toHaveBeenCalled();
    expect(onUnsubscribed).not.toHaveBeenCalled();

    // A later publish doesn't reach the caller.
    state = { v: 'after' };
    expect(server.publish('/state', state)).toBe(0);

    // Subsequent reads reflect current state.
    const snap2 = await c.getSnapshot<{ v: string }>('/state');
    expect(snap2).toEqual({ v: 'after' });
  });

  it('getSnapshot with path params resolves via pattern match', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    const store = new Map<string, { value: number }>([
      ['a', { value: 10 }],
      ['b', { value: 20 }],
    ]);
    server.onSubscribe<'/items/:id', { value: number }>('/items/:id', {
      snapshot: ({ params }) => store.get(params.id) ?? { value: -1 },
    });
    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    expect(await c.getSnapshot<{ value: number }>('/items/a')).toEqual({ value: 10 });
    expect(await c.getSnapshot<{ value: number }>('/items/b')).toEqual({ value: 20 });
  });

  it('getSnapshot rejects when no handler matches the path', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    server.onSubscribe('/known', { snapshot: () => ({}) });
    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    await expect(c.getSnapshot('/unknown')).rejects.toThrow(
      /No subscription handler for path/,
    );
  });

  it('getSnapshot and subscribe on the same path are independent', async () => {
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    server.onSubscribe('/state', { snapshot: () => ({ v: 'live' }) });
    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    const onSnap = vi.fn();
    const onUpd = vi.fn();
    c.subscribe('/state', { onSnapshot: onSnap, onUpdate: onUpd });
    await flush();
    expect(onSnap).toHaveBeenCalledTimes(1);

    // A one-shot read does not fire the subscription's callbacks.
    await c.getSnapshot('/state');
    expect(onSnap).toHaveBeenCalledTimes(1);
    expect(onUpd).toHaveBeenCalledTimes(0);

    // The subscription still receives live updates.
    server.publish('/state', { v: 'next' });
    await flush();
    expect(onUpd).toHaveBeenCalledWith({ v: 'next' });
  });

  it('subscription snapshot is delivered atomically (no update lost between sub and snap)', async () => {
    // This is the central race the library is designed to prevent.
    // On subscribe: snapshot is sent before any subsequent publish can reach
    // the peer. The FakePipe serializes delivery per peer via queueMicrotask.
    const pipe = new FakePipe();
    const server = new MessageBusServer(pipe.server);
    server.onSubscribe('/state', { snapshot: () => ({ v: 'snapshot' }) });

    const t = pipe.createClient();
    const c = new MessageBusClient(t);
    t.connect();
    await flush();

    const events: string[] = [];
    c.subscribe('/state', {
      onSnapshot: (d) => events.push(`snap:${(d as { v: string }).v}`),
      onUpdate: (d) => events.push(`upd:${(d as { v: string }).v}`),
    });
    // Publish immediately after subscribe synchronously, before any flushing.
    // The server will see the sub frame first (queued earlier), build the
    // snapshot, and only then the publish will find the active sub.
    server.publish('/state', { v: 'tooEarly' });
    await flush();
    // Publish before sub is processed should not reach the client
    expect(events).toEqual(['snap:snapshot']);

    server.publish('/state', { v: 'after' });
    await flush();
    expect(events).toEqual(['snap:snapshot', 'upd:after']);
  });
});
