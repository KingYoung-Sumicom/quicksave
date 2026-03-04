# Signaling Server

The signaling server is a lightweight WebSocket relay that connects Quicksave agents (desktop) with PWA clients (browser). It handles connection management, message routing, and temporary blob storage — but performs **no encryption or authentication** itself. All security is end-to-end between clients.

## Architecture

```
                  WebSocket              WebSocket
  Agent ◄──────────────────► Signaling ◄──────────────────► PWA
 (Desktop)                    Server                     (Browser)
                                │
                                │ HTTP
                                ▼
                           Sync Store
                        (in-memory blobs)
```

**Stack**: Plain Node.js + `ws` library. No Express or other framework. A single `http.createServer` handles both HTTP endpoints and WebSocket upgrades.

**State**: Everything lives in memory — no database, no Redis, no persistence. Three singletons manage all state:

- **ConnectionManager** — tracks all WebSocket connections and routes messages
- **RateLimiter** — per-IP connection throttling
- **SyncStore** — in-memory key/value blob store for encrypted pairing data

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
apps/signaling/src/
├── index.ts              # Entry point, HTTP + WebSocket server, request routing
├── connections.ts         # ConnectionManager class
├── syncStore.ts           # SyncStore class (in-memory blob storage)
├── rateLimiter.ts         # RateLimiter class
├── utils.ts               # parseUrl() and sendMessage() helpers
├── connections.test.ts    # 24 tests
├── syncStore.test.ts      # 7 tests
├── rateLimiter.test.ts    # 7 tests
└── utils.test.ts          # 26 tests
```

## Key Design Decisions

1. **The server is a dumb relay.** All application messages (git operations, handshakes, AI requests) flow opaquely through the relay as encrypted payloads. The server only inspects `from`/`to` fields for routing and `type` for the one control message it understands (`watch-agent`).

2. **Two PWA connection modes coexist.** Legacy mode (by `agentId`) and key-based mode (by public key) run simultaneously. Key-based connections take priority in address resolution.

3. **No WebRTC.** Despite the package description, the signaling server is used directly as the transport (WebSocket relay), not as an ICE/SDP exchange server.

4. **All crypto is end-to-end.** The server never sees plaintext. Payloads are encrypted by clients using NaCl (X25519 + XSalsa20-Poly1305).

5. **Tombstones are permanent.** Once a sync key has a tombstone (key rotation marker), no further blob writes are allowed. This enforces key rotation semantics.
