# Relay Server

The relay server is a lightweight WebSocket relay that connects Quicksave agents (desktop) with PWA clients (browser). It handles connection management, message routing, and temporary blob storage — but performs **no encryption or authentication** itself. All security is end-to-end between clients.

## Architecture

```
                  WebSocket              WebSocket
  Agent ◄──────────────────► Relay  ◄──────────────────► PWA
 (Desktop)                   Server                   (Browser)
                               │
                               │ HTTP
                               ▼
                          Sync Store
                       (in-memory blobs)
```

**Stack**: Built on [`@sumicom/ws-relay`](https://www.npmjs.com/package/@sumicom/ws-relay), a generic WebSocket relay package. No Express or other framework. HTTP and WebSocket are handled by the package's `createRelay()` factory, with Quicksave-specific behavior added via hooks.

**State**: Everything lives in memory — no database, no Redis, no persistence. Two things manage state:

- **`@sumicom/ws-relay` internals** — `PeerRegistry` tracks connections, `RateLimiter` throttles per-IP, heartbeat and routing built-in
- **`SyncStore`** — Quicksave-specific in-memory blob store with tombstone semantics

**Build**: TypeScript compiled with `tsc`, bundled with `esbuild` into a single `dist/bundle.cjs`. The version string from `package.json` is injected at build time.

## Documentation

| Document | Contents |
|----------|----------|
| [Protocol](protocol.md) | WebSocket URL patterns, message types, routing |
| [Connections](connections.md) | Connection lifecycle, heartbeat, pairing flows |
| [HTTP API](api.md) | Health, stats, and sync store endpoints |
| [Security](security.md) | E2E encryption, key exchange, sync blob crypto |
| [Deployment](deployment.md) | Configuration, rate limiting, graceful shutdown |

## Source Files

```
apps/relay/src/
├── index.ts              # Entry point — createRelay() + Quicksave hooks
├── syncStore.ts          # SyncStore class (in-memory blob storage)
├── signaling.test.ts     # 12 integration tests
└── syncStore.test.ts     # 7 tests
```

## Key Design Decisions

1. **The server is a dumb relay.** All application messages (git operations, handshakes, AI requests) flow opaquely through the relay as encrypted payloads. The server only inspects `from`/`to` fields for routing and `type` for the one control message it understands (`watch-agent`).

2. **One PWA connection mode.** PWAs connect by their own public key at `/pwa/{publicKey}`. There is no legacy agent-targeted connection mode.

3. **All crypto is end-to-end.** The server never sees plaintext. Payloads are encrypted by clients using NaCl (X25519 + XSalsa20-Poly1305).

4. **Tombstones are permanent.** Once a sync key has a tombstone (key rotation marker), no further blob writes are allowed. This enforces key rotation semantics.
