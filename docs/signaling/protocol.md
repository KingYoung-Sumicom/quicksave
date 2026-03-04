# Protocol

## WebSocket URL Patterns

Three URL patterns are supported for WebSocket connections:

| URL | Role | Description |
|-----|------|-------------|
| `/agent/{agentId}` | agent | Desktop agent connecting |
| `/pwa/{agentId}` | pwa | PWA client connecting to a specific agent (legacy) |
| `/pwa/key/{publicKey}` | pwa (key-based) | PWA connecting by its own public key |

### ID Validation

- **agentId**: 8–64 characters, alphanumeric plus `-` and `_`
- **publicKey**: 8–512 characters after URL-decoding. Allows base64 characters including `+`, `/`, `=` (URL-encoded as `%2B`, `%2F`, `%3D`)

Extra path segments, query parameters, and fragments are rejected.

## Message Types

### Control Messages (server-originated)

These are messages the signaling server itself sends or processes:

| Type | Direction | Description |
|------|-----------|-------------|
| `peer-connected` | server → both | Sent to agent and PWA when both sides of a legacy pair are connected |
| `peer-offline` | server → PWA | Agent is not connected when legacy PWA connects |
| `agent-status` | server → key-based PWA | Agent online/offline status (response to `watch-agent`, and on connect/disconnect) |
| `pwa-bye` | server → agent | Key-based PWA disconnected. Payload: `{pwaAddress}` |
| `bye` | server → agent | Legacy PWA disconnected |
| `error` | server → client | Error with a code (see below) |
| `watch-agent` | key-based PWA → server | Subscribe to an agent's online/offline status. Payload: `{agentId}` |

### Error Codes

| Code | Meaning |
|------|---------|
| `RATE_LIMITED` | Connection or message rate exceeded |
| `INVALID_URL` | URL doesn't match any known pattern |
| `AGENT_ID_IN_USE` | Agent tried to connect with an already-registered agentId |
| `REPLACED` | Duplicate key-based PWA connection displaced existing one |
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
- Key-based PWAs: `from` must equal `pwa:{pwaKey}`
- Legacy PWAs: `from` must equal `pwa:{agentId}`

### Application Messages (relayed through signaling)

These flow between agent and PWA as encrypted payloads inside routed messages. The server never decrypts them. Types include:

- `ping`, `pong` — keep-alive
- `handshake`, `handshake:ack` — session establishment
- `git:status`, `git:diff`, `git:log`, etc. — git operations (request/response pairs)
- `ai:*` — AI-related operations
- `agent:*` — agent control operations
- `error` — application-level errors

## Message Flow Examples

### Legacy Pairing

```
Agent                    Server                    PWA
  │                        │                        │
  ├──ws://.../agent/abc──►│                        │
  │                        │◄──ws://.../pwa/abc────┤
  │◄──peer-connected──────│──peer-connected───────►│
  │                        │                        │
  │◄═══════════════════════╪════════════════════════╡
  │    (routed messages with from/to/payload)       │
```

### Key-Based Connection

```
Agent                    Server                    PWA
  │                        │                        │
  ├──ws://.../agent/abc──►│                        │
  │                        │◄──ws://.../pwa/key/K──┤
  │                        │◄──watch-agent(abc)────┤
  │                        │──agent-status(online)─►│
  │                        │                        │
  │◄═══════════════════════╪════════════════════════╡
  │    (routed messages with from/to/payload)       │
  │                        │                        │
  │                        │    (PWA disconnects)   │
  │◄──pwa-bye(pwa:K)──────│                        │
```
