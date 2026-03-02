# Multi-Client Agent Support

**Date:** 2026-02-19
**Status:** Approved

## Problem

The quicksave agent only handles one PWA client at a time. A new client's key exchange clobbers the previous client's encryption state, replies always route to the last sender, and `currentRepoPath` is global mutable state shared across all connections.

## Constraints

- Multiple clients are operated by the same human (multiple devices/tabs)
- Mutating git operations lock per-repo; reject if busy
- No protocol changes needed (PWA and signaling server already support multi-client)

## Design

### Approach: Per-Peer Session Map

Refactor the agent's connection layer to maintain a `Map<peerAddress, PeerSession>` where each session holds its own encryption key. The signaling client passes the sender address alongside each message so replies route back correctly. The message handler tracks per-client repo context and uses per-repo mutexes to prevent concurrent mutations.

### Layer 1: SignalingClient (signaling.ts)

- Remove `peerAddress` field (no longer stored globally)
- `'data'` event signature becomes `(data: string, from: string)`
- `sendData(data, targetAddress)` requires explicit target
- `'peer-connected'` / `'peer-disconnected'` events include the peer address
- Signaling client becomes stateless regarding peers

### Layer 2: AgentConnection (connection.ts)

Rename `WebRTCConnection` to `AgentConnection` (no WebRTC is used).

```typescript
interface PeerSession {
  address: string;          // e.g. "pwa:BASE64_KEY"
  sessionDEK: Uint8Array;   // unique per peer
  connectedAt: number;
}
```

- Replace `sessionDEK: Uint8Array | null` with `peers: Map<string, PeerSession>`
- `isConnected` derived from `peers.size > 0`
- `handleDataMessage(data, from)` looks up peer by address for correct DEK
- `handleKeyExchange(message, from)` creates/updates PeerSession for that address
- `send(message, targetAddress)` encrypts with that peer's DEK
- `handlePeerDisconnected(address)` removes only that peer's session
- Events `'connected'` / `'disconnected'` include the peer address
- Event `'message'` becomes `(message: Message, peerAddress: string)`

### Layer 3: MessageHandler (messageHandler.ts)

**Per-client repo tracking:**

- Remove `currentRepoPath` field
- Add `clientRepos: Map<string, string>` (peerAddress -> repoPath)
- `handleMessage(message, peerAddress)` takes sender identity
- `this.git` getter replaced by `getGit(peerAddress)` which resolves repo for that client
- `handleSwitchRepo` updates `clientRepos[peerAddress]` only
- `handleHandshake` initializes `clientRepos[peerAddress]` to default repo
- Add `removeClient(peerAddress)` for cleanup on disconnect

**Per-repo operation mutex (lock-and-reject):**

- Add `repoLocks: Map<string, string>` (repoPath -> peerAddress currently holding lock)
- Mutating operations (stage, unstage, commit, checkout, discard, stage-patch, unstage-patch) acquire lock before executing, release after
- If lock held by another client, reject with error: "Repository is busy"
- Read operations (status, diff, log, branches) do not acquire locks
- Lock is short-lived (duration of a single git command)

**Shared state (stays shared, correct for same-human model):**

- `repos` map (GitOperations instances) -- shared, all clients see same repos
- `availableRepos` -- shared, addRepo benefits all clients
- `aiService` -- shared, cache benefits all clients

### Layer 4: Agent Entry Point (index.ts)

- `WebRTCConnection` -> `AgentConnection` (rename)
- `connection.on('message')` callback receives `(message, peerAddress)`, passes to `messageHandler.handleMessage(message, peerAddress)`
- `connection.send(response)` -> `connection.send(response, peerAddress)`
- `'connected'` event logs which peer connected (truncated key)
- `'disconnected'` event calls `messageHandler.removeClient(peerAddress)`
- Show QR code only when `peers.size === 0`

## What Doesn't Change

- **Signaling server** -- already supports multiple PWAs via key-based routing
- **PWA** -- already has per-agent session isolation (`Map<string, AgentSession>`)
- **Shared types/protocol** -- `Message.id` handles reply correlation, `RoutedMessage` carries `from`/`to`
- **GitOperations** -- stateless per-call, safe to share

## Files Changed

| File | Change |
|------|--------|
| `apps/agent/src/connection/signaling.ts` | Remove peerAddress field, emit from with data, sendData(data, target) |
| `apps/agent/src/connection/connection.ts` | Rename to AgentConnection, Map<string, PeerSession> for per-peer DEK |
| `apps/agent/src/handlers/messageHandler.ts` | clientRepos map for per-client repo, repoLocks map for mutation locking |
| `apps/agent/src/index.ts` | Pass peerAddress through, update connect/disconnect logging |

4 files changed, 0 new files, no protocol changes, no PWA changes.
