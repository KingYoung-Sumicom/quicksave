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
