# Connection Management

Connection tracking and routing is handled by `@sumicom/ws-relay` internals (`PeerRegistry`). Quicksave-specific behavior is layered on top via hooks in `index.ts`.

## Peer Identity

Each connected WebSocket is a `Peer` with:

```typescript
interface Peer {
  id: string;       // decoded agentId or publicKey
  channel: string;  // "agent" or "pwa"
  address: string;  // "{channel}:{id}" — used in from/to fields
  ws: WebSocket;
}
```

## Agent Watcher State

The only application-level state maintained outside `@sumicom/ws-relay` is the `agentWatchers` map, which tracks which PWAs are watching which agents for presence:

```typescript
agentWatchers: Map<string, Set<string>>
// agentId → Set<pwaAddress>
```

This map is managed entirely within the hook closures in `index.ts`.

## Connection Flows

### Agent Connection (`/agent/{agentId}`)

1. `@sumicom/ws-relay` validates URL and rate-limits by IP
2. If `agentId` is already registered → error `ID_IN_USE`, close
3. Peer registered in `PeerRegistry`
4. `onPeerConnect` hook fires:
   - All PWAs watching this `agentId` receive `agent-status {online: true}`

### PWA Connection (`/pwa/{publicKey}`)

1. `@sumicom/ws-relay` validates URL and rate-limits by IP
2. `parseId` decodes the URL-encoded public key
3. If a connection for this key already exists → old connection closed with error `REPLACED`
4. Peer registered in `PeerRegistry`
5. PWA sends `watch-agent` to subscribe to agent presence
6. Server responds immediately with `agent-status` reflecting current state

## Disconnection Cleanup

### Agent Disconnects

`onPeerDisconnect` hook fires:
1. All PWAs watching this agent receive `agent-status {online: false}`

### PWA Disconnects

`onPeerDisconnect` hook fires:
1. `pwa-bye {pwaAddress}` sent to each agent this PWA was watching
2. PWA's address removed from all `agentWatchers` entries

## Heartbeat

Handled automatically by `@sumicom/ws-relay`. The package pings all connected peers on a configurable interval and terminates connections that do not respond with a pong.

## Statistics

Available via `GET /stats` (from `relay.registry.getStats()`):

| Stat | Description |
|------|-------------|
| `totalConnections` | Cumulative connection count (never decreases) |
| `activeConnections` | Currently connected peers |
| `channels` | Per-channel breakdown (agents, pwas) |
