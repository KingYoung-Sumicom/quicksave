# @sumicom/quicksave-message-bus

Transport-agnostic **command + subscribe** message bus. Built for Quicksave's
PWA ↔ agent RPC channel, but has no Quicksave-specific code — it only needs
a duplex transport that can deliver JSON frames.

## What it gives you

Three primitives over a single transport:

| Primitive      | Shape                                                            |
| -------------- | ---------------------------------------------------------------- |
| `command`      | One-shot request/response (`verb` + payload → result or error)   |
| `subscribe`    | Path-based (`/sessions/:id/cards`), delivers **snapshot + updates** until unsub |
| `publish`      | Server-side fan-out to every peer subscribed to a path           |
| `getSnapshot`  | One-shot read of a subscribable path — resolves with the same data `sub` would, without creating a subscription |

Key properties:

- **Snapshot-on-subscribe**: the first frame after `sub` is always a full
  snapshot. On reconnect the client auto-resends `sub` frames and gets a
  fresh snapshot, eliminating the "stale-after-reconnect" window.
- **Command queueing**: `command(..., { queueWhileDisconnected: true })`
  holds the request until the transport reconnects, then flushes.
- **Typed path params**: `PathParams<'/sessions/:id/cards'>` → `{ id: string }`.
- **Transport-agnostic**: implement `ServerTransport` / `ClientTransport` and
  drop it in. A `FakeTransport` ships under `/fake` for tests.

## Install

```bash
npm install @sumicom/quicksave-message-bus
```

## Quick example

**Server** (Node, any transport):

```ts
import { MessageBusServer } from '@sumicom/quicksave-message-bus';

const bus = new MessageBusServer(transport);

bus.onCommand<StartPayload, StartResult>('session:start', async (payload, ctx) => {
  return await startSession(payload);
});

bus.onSubscribe<'/sessions/:id/cards', CardHistory, CardUpdate>(
  '/sessions/:id/cards',
  {
    snapshot: async ({ params }) => getCardHistory(params.id),
    onSubscribed: ({ params, peer }) => trackSubscriber(params.id, peer),
  },
);

// Push updates to all subscribers of this exact path
bus.publish('/sessions/abc123/cards', { kind: 'card', event });
```

**Client** (browser or Node):

```ts
import { MessageBusClient } from '@sumicom/quicksave-message-bus';

const bus = new MessageBusClient(transport);

const result = await bus.command<StartResult, StartPayload>(
  'session:start',
  { prompt: 'hello' },
  { timeoutMs: 30_000, queueWhileDisconnected: true },
);

const unsub = bus.subscribe<CardHistory, CardUpdate>(
  '/sessions/abc123/cards',
  {
    onSnapshot: (history) => setInitialState(history),
    onUpdate: (event) => applyUpdate(event),
    onError: (err) => console.warn('sub failed:', err),
  },
);
// later:
unsub();
```

## Wire protocol

Frames (JSON):

```ts
// Client → Server
{ kind: 'cmd',   id, verb, payload }
{ kind: 'sub',   path }
{ kind: 'unsub', path }

// Server → Client
{ kind: 'result', id, ok: true, data }
{ kind: 'result', id, ok: false, error }
{ kind: 'snap',   path, data }
{ kind: 'upd',    path, data }
{ kind: 'sub-error', path, error }
```

Transports are responsible for framing, delivery, and emitting peer
connect/disconnect events; the bus has no opinion on wire format below
that.

## Transport contract

```ts
interface ServerTransport {
  send(peer: PeerId, frame: ServerFrame): void;
  onFrame(handler: (peer: PeerId, frame: ClientFrame) => void): void;
  onPeerConnected(handler: (peer: PeerId) => void): void;
  onPeerDisconnected(handler: (peer: PeerId) => void): void;
}

interface ClientTransport {
  send(frame: ClientFrame): void;
  onFrame(handler: (frame: ServerFrame) => void): void;
  onConnected(handler: () => void): void;
  onDisconnected(handler: () => void): void;
  isConnected(): boolean;
}
```

For an example over an existing WebSocket layer, see Quicksave's
`apps/agent/src/messageBus/busServerTransport.ts` and
`apps/pwa/src/lib/busClientTransport.ts`.

## Testing with the fake transport

```ts
import { FakeServerTransport, FakeClientTransport } from '@sumicom/quicksave-message-bus/fake';
```

Pairs in-memory; lets you drive connect/disconnect manually. Used in this
package's own test suite.

## License

MIT
