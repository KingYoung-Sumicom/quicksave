# Connection Management

## Internal Data Structures

`ConnectionManager` maintains four maps:

```typescript
agents: Map<string, WebSocket>          // agentId → WebSocket
pwas: Map<string, WebSocket>            // agentId → WebSocket (legacy)
pwasByKey: Map<string, WebSocket>       // publicKey → WebSocket (key-based)
agentWatchers: Map<string, Set<string>> // agentId → Set<pwaKey>
```

## Connection Metadata

Each WebSocket is augmented with `ExtendedWebSocket` properties:

```typescript
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;        // heartbeat tracking
  role?: 'agent' | 'pwa';
  agentId?: string;        // set for agents and legacy PWAs
  pwaKey?: string;         // set for key-based PWAs
  messageCount: number;    // per-connection message rate limiting
  lastMessageReset: number;
  ip: string;              // client IP (respects X-Forwarded-For)
}
```

## Connection Flows

### Agent Connection (`/agent/{agentId}`)

1. Rate limiter checks per-IP connection count
2. URL is parsed and validated
3. If `agentId` is already registered → error `AGENT_ID_IN_USE`, close
4. WebSocket registered in `agents` map
5. If a legacy PWA is waiting for this `agentId` → send `peer-connected` to both
6. All key-based PWAs watching this `agentId` receive `agent-status {online: true}`

### Legacy PWA Connection (`/pwa/{agentId}`)

1. Rate limiter checks per-IP connection count
2. URL is parsed and validated
3. WebSocket registered in `pwas` map
4. If agent is connected → send `peer-connected` to both
5. If agent is NOT connected → send `peer-offline` to PWA

### Key-Based PWA Connection (`/pwa/key/{publicKey}`)

1. Rate limiter checks per-IP connection count
2. URL is parsed and validated
3. If a connection for this key already exists → old connection is closed with error `REPLACED`
4. WebSocket registered in `pwasByKey` map
5. PWA sends `watch-agent` messages to subscribe to agent presence
6. Server responds with immediate `agent-status` for each watched agent

## Disconnection Cleanup

### Agent Disconnects

1. All key-based PWAs watching this agent receive `agent-status {online: false}`
2. Agent removed from `agents` map
3. Legacy PWA for this `agentId` (if any) receives `peer-offline`

### Key-Based PWA Disconnects

1. `pwa-bye {pwaAddress}` sent to all agents this PWA was watching
2. All watcher subscriptions removed from `agentWatchers`
3. PWA removed from `pwasByKey` map

### Legacy PWA Disconnects

1. PWA removed from `pwas` map
2. Agent for this `agentId` (if any) receives `bye`

## Address Resolution

`getByAddress(address)` parses `"role:id"` format:

- `agent:{id}` → looks up `agents` map
- `pwa:{id}` → checks `pwasByKey` first, falls back to `pwas`

Key-based PWAs take priority over legacy PWAs when resolving addresses.

## Heartbeat

Every **30 seconds**, the server pings all connected WebSockets:

1. For each connection, check `isAlive` flag
2. If `isAlive === false` → connection didn't respond to last ping → `terminate()`
3. Set `isAlive = false`
4. Send WebSocket `ping` frame
5. On `pong` response, set `isAlive = true`

## Statistics

The ConnectionManager tracks:

| Stat | Description |
|------|-------------|
| `totalConnections` | Cumulative connection count (never decreases) |
| `activeAgents` | Currently connected agents |
| `activePwas` | Currently connected legacy PWAs |
| `activePwasByKey` | Currently connected key-based PWAs |
| `peakAgents` | High-water mark for agents |
| `peakPwas` | High-water mark for legacy PWAs |
| `peakPwasByKey` | High-water mark for key-based PWAs |
| `messagesRelayed` | Total routed messages forwarded |
| `startTime` | Server start timestamp (for uptime) |
