# Protocol

## WebSocket URL Patterns

Two URL patterns are supported for WebSocket connections:

| URL | Role | Description |
|-----|------|-------------|
| `/agent/{agentId}` | agent | Desktop agent connecting |
| `/pwa/{publicKey}` | pwa | PWA client connecting by its own public key |

### ID Validation

- **agentId**: 8–64 characters, alphanumeric plus `-` and `_`
- **publicKey**: 8+ characters after URL-decoding. Allows base64 characters including `+`, `/`, `=` (URL-encoded as `%2B`, `%2F`, `%3D`)

Extra path segments, query parameters, and fragments are rejected.

## Message Types

### Control Messages (server-originated)

These are messages the relay server itself sends or processes:

| Type | Direction | Description |
|------|-----------|-------------|
| `agent-status` | server → PWA | Agent online/offline status (response to `watch-agent`, and on agent connect/disconnect) |
| `pwa-bye` | server → agent | PWA disconnected. Payload: `{pwaAddress}` |
| `error` | server → client | Error with a code (see below) |
| `watch-agent` | PWA → server | Subscribe to an agent's online/offline status. Payload: `{agentId}` |

### Error Codes

| Code | Meaning |
|------|---------|
| `RATE_LIMITED` | Connection or message rate exceeded |
| `INVALID_URL` | URL doesn't match any known pattern |
| `ID_IN_USE` | Agent tried to connect with an already-registered agentId |
| `REPLACED` | Duplicate PWA connection displaced existing one |
| `INVALID_FROM` | Routed message `from` field doesn't match sender's identity |

### Routed Messages (relayed opaquely)

Messages with both `from` and `to` fields are forwarded to the target connection without inspection. The server only validates that `from` matches the sender's registered identity.

```typescript
interface RoutedMessage {
  from: string;    // "pwa:{publicKey}" or "agent:{agentId}"
  to: string;      // "pwa:{publicKey}" or "agent:{agentId}"
  payload: string; // opaque (encrypted by clients)
}
```

**Address format**: `"{role}:{id}"` where role is `agent` or `pwa`.

**From-field validation**:
- Agents: `from` must equal `agent:{agentId}`
- PWAs: `from` must equal `pwa:{publicKey}`

### Application Messages (relayed through signaling)

These flow between agent and PWA as encrypted payloads inside routed messages. The server never decrypts them. Types include:

- `ping`, `pong` — keep-alive
- `handshake`, `handshake:ack` — session establishment
- `git:status`, `git:diff`, `git:log`, etc. — git operations (request/response pairs)
- `ai:*` — AI-related operations
- `agent:*` — agent control operations
- `error` — application-level errors

## Message Flow

### PWA Connection and Agent Watching

```
Agent                    Server                    PWA
  │                        │                        │
  ├──ws://.../agent/abc──►│                        │
  │                        │◄──ws://.../pwa/K──────┤
  │                        │◄──watch-agent(abc)────┤
  │                        │──agent-status(online)─►│
  │                        │                        │
  │◄═══════════════════════╪════════════════════════╡
  │    (routed messages with from/to/payload)       │
  │                        │                        │
  │                        │    (PWA disconnects)   │
  │◄──pwa-bye(pwa:K)──────│                        │
```
