# Deployment

## Configuration

| Variable | Default | Source | Description |
|----------|---------|--------|-------------|
| `PORT` | `8080` | `process.env.PORT` | HTTP/WebSocket listen port |
| `HEARTBEAT_INTERVAL` | 30,000 ms | Hardcoded | WebSocket ping interval |
| `RATE_LIMIT_WINDOW` | 60,000 ms | Hardcoded | Sliding window for rate limiting |
| `RATE_LIMIT_MAX_CONNECTIONS` | 10 | Hardcoded | Max new connections per IP per window |
| `RATE_LIMIT_MAX_MESSAGES` | 100 | Hardcoded | Max messages per connection per window |
| `SyncStore.maxBlobSize` | 8,192 bytes | Hardcoded | Max size for a single sync blob |
| `VERSION` | from `package.json` | Build-time inject | Server version string |

Only `PORT` is runtime-configurable via environment variable. All other values are hardcoded constants.

## Rate Limiting

Two independent layers protect the server:

### Connection Rate Limiting (per-IP)

- Tracked by `RateLimiter` class
- Sliding window: 10 connections per IP per 60-second window
- On rejection: sends `error {code: RATE_LIMITED}` and closes with WebSocket close code `1008`
- Periodic cleanup removes expired IP entries

### Message Rate Limiting (per-connection)

- Tracked inline on each `ExtendedWebSocket`
- Window: 100 messages per connection per 60-second window
- Window resets lazily when the next message arrives after expiry
- On rejection: sends `error {code: RATE_LIMITED}` but does NOT close the connection (message is dropped)

## Build

```bash
cd apps/signaling

# Development (watch mode)
npm run dev

# Production build
npm run build    # tsc + esbuild → dist/bundle.cjs

# Run tests
npx vitest run

# Start production
npm start        # node dist/bundle.cjs
```

The build script (`build.mjs`) uses esbuild to produce a single CommonJS bundle with the version string injected as a compile-time constant.

## Graceful Shutdown

The server handles both `SIGINT` and `SIGTERM`:

1. Close the WebSocket server (stops accepting new connections)
2. Close the HTTP server
3. Exit the process

In-memory state (connections, sync store) is lost on shutdown — this is by design. Clients are expected to reconnect and re-establish state.

## Docker

The Dockerfile sets `NODE_ENV=production` and exposes port 8080. The entrypoint runs the bundled output directly with Node.

## Infrastructure Notes

- **No persistence**: All state is in-memory. Server restarts clear everything.
- **Single process**: No clustering or worker threads. Scale horizontally by running multiple instances behind a load balancer (with sticky sessions for WebSocket connections).
- **TLS**: Expected to run behind a reverse proxy (nginx, Cloudflare, etc.) that terminates TLS.
- **CORS**: All HTTP endpoints allow `*` origin — the server is designed to be called from any browser context.
- **IP detection**: Respects `X-Forwarded-For` header for rate limiting, so it works correctly behind proxies.
