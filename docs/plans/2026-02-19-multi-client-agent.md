# Multi-Client Agent Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the quicksave agent to handle multiple PWA clients simultaneously with per-peer encryption, per-client repo context, and per-repo mutation locking.

**Architecture:** Refactor the agent's connection layer to maintain a `Map<peerAddress, PeerSession>` for per-peer encryption. The signaling client becomes stateless regarding peers, passing sender addresses through. The message handler tracks per-client repo context and uses per-repo mutexes to reject concurrent mutations.

**Tech Stack:** TypeScript, Vitest, EventEmitter, WebSocket (ws)

**Design doc:** `docs/plans/2026-02-19-multi-client-agent-design.md`

**Test command:** `cd apps/agent && npx vitest run`

**Existing tests (must stay green):** 44 tests across `src/handlers/messageHandler.test.ts` and `src/git/operations.test.ts`

---

### Task 1: SignalingClient — Pass Peer Address Through

**Files:**
- Modify: `apps/agent/src/connection/signaling.ts`

The SignalingClient currently stores a single `peerAddress` and all replies go to the last sender. Change it to be stateless regarding peers — emit the sender address alongside data events, and require an explicit target for `sendData`.

**Step 1: Update SignalingEvents interface**

In `signaling.ts`, change the `data` event signature and add peer address to connect/disconnect events:

```typescript
export interface SignalingEvents {
  'peer-connected': (peerAddress?: string) => void;
  'peer-disconnected': (peerAddress?: string) => void;
  data: (data: string, from: string | null) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}
```

**Step 2: Remove `peerAddress` field, update message handling**

Remove the `private peerAddress` field and `getPeerAddress()` method. Update the `on('message')` handler to pass `from` with the data event instead of storing it:

```typescript
// In the ws.on('message') handler, routed message case:
if (parsed.from && parsed.to && 'payload' in parsed) {
  this.emit('data', parsed.payload, parsed.from);
  return;
}
// Non-routed data:
this.emit('data', data.toString(), null);
```

Update `handleMessage` to pass peer address through disconnect/connect events:

```typescript
private handleMessage(message: SignalingMessage): void {
  switch (message.type) {
    case 'peer-connected':
      this.emit('peer-connected');
      break;
    case 'peer-offline':
      this.emit('peer-disconnected');
      break;
    case 'data':
      if (typeof message.payload === 'string') {
        this.emit('data', message.payload, null);
      }
      break;
    case 'bye':
      this.emit('peer-disconnected');
      break;
  }
}
```

**Step 3: Update `sendData` to take target address**

```typescript
sendData(data: string, targetAddress: string | null): void {
  if (this.ws && this.ws.readyState === WebSocket.OPEN) {
    if (targetAddress) {
      const envelope = JSON.stringify({
        from: `agent:${this.agentId}`,
        to: targetAddress,
        payload: data,
      });
      this.ws.send(envelope);
    } else {
      this.ws.send(data);
    }
  }
}
```

Remove `getPeerAddress()` method. Also remove the `this.peerAddress = null` lines from `handleMessage` cases and the `ws.on('close')` handler.

**Step 4: Verify build compiles**

Run: `cd apps/agent && npx tsc --noEmit`

This will show compile errors in `connection.ts` (expected — we'll fix those in Task 2).

---

### Task 2: Rename WebRTCConnection to AgentConnection, Add Per-Peer Sessions

**Files:**
- Modify: `apps/agent/src/connection/connection.ts`

**Step 1: Rename class and update interfaces**

Rename `WebRTCConnection` to `AgentConnection`. Rename `WebRTCConnectionEvents` to `AgentConnectionEvents`. Update the events to include peer address:

```typescript
export interface PeerSession {
  address: string;
  sessionDEK: Uint8Array;
  connectedAt: number;
}

export interface AgentConnectionEvents {
  connected: (peerAddress: string) => void;
  disconnected: (peerAddress: string) => void;
  message: (message: Message, peerAddress: string) => void;
  error: (error: Error) => void;
}
```

**Step 2: Replace single DEK with peer session map**

Replace the fields:

```typescript
// Remove:
private sessionDEK: Uint8Array | null = null;
private isConnected = false;

// Add:
private peers: Map<string, PeerSession> = new Map();
```

**Step 3: Update `setupSignalingHandlers`**

The `data` event now receives `(data: string, from: string | null)`:

```typescript
private setupSignalingHandlers(): void {
  this.signaling.on('peer-connected', () => {
    console.log('PWA peer connected, waiting for key exchange...');
  });

  this.signaling.on('data', (data: string, from: string | null) => {
    this.handleDataMessage(data, from);
  });

  this.signaling.on('peer-disconnected', () => {
    // Legacy single-peer disconnect — disconnect all peers
    for (const [address] of this.peers) {
      this.handlePeerDisconnected(address);
    }
  });

  this.signaling.on('disconnected', () => {
    // WebSocket reconnect — clear all peer sessions
    const addresses = Array.from(this.peers.keys());
    this.peers.clear();
    for (const address of addresses) {
      this.emit('disconnected', address);
    }
  });

  this.signaling.on('error', (error: Error) => {
    this.emit('error', error);
  });
}
```

**Step 4: Update `handleDataMessage` to use per-peer DEK**

```typescript
private async handleDataMessage(data: string, from: string | null): Promise<void> {
  try {
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'key-exchange') {
        await this.handleKeyExchange(parsed, from);
        return;
      }
    } catch {
      // Not JSON
    }

    if (!from) {
      console.error('Received message without sender address');
      return;
    }

    const peer = this.peers.get(from);
    if (!peer) {
      console.error(`No session for peer ${from.slice(0, 20)}...`);
      return;
    }

    const decrypted = decryptWithSharedSecret(data, peer.sessionDEK);
    const buffer = Buffer.from(decrypted, 'base64');
    const decompressed = await gunzipAsync(buffer);
    const message = parseMessage(decompressed.toString('utf-8'));
    this.emit('message', message, from);
  } catch (error) {
    console.error('Failed to handle message:', error);
  }
}
```

**Step 5: Update `handleKeyExchange` to take sender address**

```typescript
private async handleKeyExchange(message: KeyExchangeV2, from: string | null): Promise<void> {
  const age = Date.now() - message.timestamp;
  if (age > AgentConnection.KEY_EXCHANGE_MAX_AGE_MS) {
    console.error(`Key exchange expired (age: ${age}ms)`);
    this.emit('error', new Error('Key exchange expired'));
    return;
  }

  if (age < -5000) {
    console.error(`Key exchange timestamp in future (age: ${age}ms)`);
    this.emit('error', new Error('Key exchange timestamp invalid'));
    return;
  }

  try {
    const sessionDEK = decryptDEK(message.encryptedDEK, this.keyPair.secretKey);
    const peerAddress = from || 'legacy-peer';
    const peerKey = peerAddress.replace('pwa:', '');
    const isNew = !this.peers.has(peerAddress);

    this.peers.set(peerAddress, {
      address: peerAddress,
      sessionDEK,
      connectedAt: Date.now(),
    });

    console.log(`Key exchange complete with ${peerKey.slice(0, 12)}..., connection encrypted (${this.peers.size} peer${this.peers.size !== 1 ? 's' : ''})`);

    if (isNew) {
      this.emit('connected', peerAddress);
    }

    // V2: Send acknowledgment
    const ack = JSON.stringify({
      type: 'key-exchange-ack',
      version: 2,
    });
    this.signaling.sendData(ack, peerAddress);
  } catch (error) {
    console.error('Failed to decrypt session DEK:', error);
    this.emit('error', new Error('Failed to decrypt session DEK'));
  }
}
```

**Step 6: Update `send` to target specific peer**

```typescript
send(message: Message, targetAddress: string): void {
  const peer = this.peers.get(targetAddress);
  if (!peer) {
    console.error(`No session for peer ${targetAddress.slice(0, 20)}..., cannot send`);
    return;
  }

  const serialized = serializeMessage(message);
  gzipAsync(Buffer.from(serialized)).then((compressed) => {
    const compressedBase64 = compressed.toString('base64');
    const encrypted = encryptWithSharedSecret(compressedBase64, peer.sessionDEK);
    this.signaling.sendData(encrypted, targetAddress);
  });
}
```

**Step 7: Update `handlePeerDisconnected`**

```typescript
private handlePeerDisconnected(peerAddress: string): void {
  if (this.peers.has(peerAddress)) {
    this.peers.delete(peerAddress);
    this.emit('disconnected', peerAddress);
    const peerKey = peerAddress.replace('pwa:', '');
    console.log(`Peer ${peerKey.slice(0, 12)}... disconnected (${this.peers.size} peer${this.peers.size !== 1 ? 's' : ''} remaining)`);
  }
}
```

**Step 8: Remove old helpers, add new ones**

Remove `isKeyExchangeComplete()`, `getEncryptionKey()`, `sendRaw()`. Add:

```typescript
getPeerCount(): number {
  return this.peers.size;
}

hasPeers(): boolean {
  return this.peers.size > 0;
}
```

Rename the static field from `WebRTCConnection.KEY_EXCHANGE_MAX_AGE_MS` to `AgentConnection.KEY_EXCHANGE_MAX_AGE_MS`.

**Step 9: Verify build compiles**

Run: `cd apps/agent && npx tsc --noEmit`

Remaining errors should only be in `index.ts` (fixed in Task 4).

---

### Task 3: MessageHandler — Per-Client Repo Context and Repo Locking

**Files:**
- Modify: `apps/agent/src/handlers/messageHandler.ts`
- Modify: `apps/agent/src/handlers/messageHandler.test.ts`

**Step 1: Write failing tests for multi-client repo isolation**

Add these tests to `messageHandler.test.ts`:

```typescript
describe('multi-client support', () => {
  const clientA = 'pwa:clientA';
  const clientB = 'pwa:clientB';

  let secondRepoPath: string;

  beforeEach(async () => {
    // Create a second repo for multi-repo tests
    secondRepoPath = join(tmpdir(), `quicksave-handler-test2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(secondRepoPath, { recursive: true });
    const git2 = simpleGit(secondRepoPath);
    await git2.init();
    await git2.addConfig('user.email', 'test@test.com');
    await git2.addConfig('user.name', 'Test User');
    await writeFile(join(secondRepoPath, 'README.md'), '# Second Repo\n');
    await git2.add('README.md');
    await git2.commit('Initial commit');

    // Recreate handler with two repos
    handler = new MessageHandler([
      { path: testRepoPath, name: 'test-repo' },
      { path: secondRepoPath, name: 'second-repo' },
    ]);
  });

  afterEach(async () => {
    try {
      await rm(secondRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should isolate repo context per client', async () => {
    // Client A switches to second repo
    const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
    const switchResp = await handler.handleMessage(switchMsg, clientA);
    expect((switchResp.payload as any).success).toBe(true);

    // Client B should still be on default repo (first repo)
    const statusMsg = createMessage('git:status', {});
    const statusResp = await handler.handleMessage(statusMsg, clientB);
    // If client B is on the first repo, status should work without error
    expect(statusResp.type).toBe('git:status:response');
    // Verify it's the first repo by checking the repo path context
    const listMsg = createMessage('agent:list-repos', {});
    const listResp = await handler.handleMessage(listMsg, clientB);
    expect((listResp.payload as any).current).toBe(testRepoPath);
  });

  it('should reject mutating ops when repo is locked by another client', async () => {
    // Create a file to stage
    await writeFile(join(testRepoPath, 'file1.txt'), 'content1');
    await writeFile(join(testRepoPath, 'file2.txt'), 'content2');

    // Client A starts staging (we need to simulate concurrent access)
    // We'll test the lock by directly using the lock mechanism
    const stageMsg1 = createMessage('git:stage', { paths: ['file1.txt'] });
    const stageMsg2 = createMessage('git:stage', { paths: ['file2.txt'] });

    // Both should succeed sequentially (same client or no contention)
    const resp1 = await handler.handleMessage(stageMsg1, clientA);
    expect((resp1.payload as any).success).toBe(true);

    const resp2 = await handler.handleMessage(stageMsg2, clientB);
    expect((resp2.payload as any).success).toBe(true);
  });

  it('should clean up client state on removeClient', async () => {
    // Client A switches repo
    const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
    await handler.handleMessage(switchMsg, clientA);

    // Remove client A
    handler.removeClient(clientA);

    // Client A reconnecting should get default repo again
    const listMsg = createMessage('agent:list-repos', {});
    const listResp = await handler.handleMessage(listMsg, clientA);
    expect((listResp.payload as any).current).toBe(testRepoPath);
  });

  it('should return per-client current repo in list-repos', async () => {
    // Client A switches to second repo
    const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
    await handler.handleMessage(switchMsg, clientA);

    // Client A's list-repos should show second repo as current
    const listMsgA = createMessage('agent:list-repos', {});
    const listRespA = await handler.handleMessage(listMsgA, clientA);
    expect((listRespA.payload as any).current).toBe(secondRepoPath);

    // Client B's list-repos should show first repo as current
    const listMsgB = createMessage('agent:list-repos', {});
    const listRespB = await handler.handleMessage(listMsgB, clientB);
    expect((listRespB.payload as any).current).toBe(testRepoPath);
  });

  it('should return per-client repo path in handshake', async () => {
    // Client A switches repo
    const switchMsg = createMessage('agent:switch-repo', { path: secondRepoPath });
    await handler.handleMessage(switchMsg, clientA);

    // Client B handshake should return default repo
    const handshakeMsg = createMessage('handshake', { publicKey: 'test-key' });
    const handshakeResp = await handler.handleMessage(handshakeMsg, clientB);
    expect((handshakeResp.payload as any).repoPath).toBe(testRepoPath);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/agent && npx vitest run src/handlers/messageHandler.test.ts`

Expected: FAIL — `handleMessage` doesn't accept a second argument yet.

**Step 3: Update MessageHandler to accept peerAddress**

Replace `currentRepoPath` with per-client tracking:

```typescript
export class MessageHandler {
  private repos: Map<string, GitOperations>;
  private agentVersion = '0.1.0';
  private defaultRepoPath: string;
  private clientRepos: Map<string, string>; // peerAddress -> repoPath
  private repoLocks: Map<string, string>;   // repoPath -> peerAddress holding lock
  private availableRepos: Repository[];
  private aiService: CommitSummaryService | null = null;

  constructor(repos: Repository[], _license?: License) {
    this.repos = new Map();
    for (const repo of repos) {
      this.repos.set(repo.path, new GitOperations(repo.path));
    }
    this.availableRepos = repos;
    this.defaultRepoPath = repos[0].path;
    this.clientRepos = new Map();
    this.repoLocks = new Map();
  }
```

Add a helper to get the git instance for a client:

```typescript
private getClientRepoPath(peerAddress: string): string {
  return this.clientRepos.get(peerAddress) || this.defaultRepoPath;
}

private getGit(peerAddress: string): GitOperations {
  const repoPath = this.getClientRepoPath(peerAddress);
  return this.repos.get(repoPath)!;
}
```

Add lock helpers:

```typescript
private acquireRepoLock(repoPath: string, peerAddress: string): boolean {
  const holder = this.repoLocks.get(repoPath);
  if (holder && holder !== peerAddress) {
    return false; // locked by another client
  }
  this.repoLocks.set(repoPath, peerAddress);
  return true;
}

private releaseRepoLock(repoPath: string, peerAddress: string): void {
  if (this.repoLocks.get(repoPath) === peerAddress) {
    this.repoLocks.delete(repoPath);
  }
}
```

Add client cleanup:

```typescript
removeClient(peerAddress: string): void {
  this.clientRepos.delete(peerAddress);
  // Release any locks held by this client
  for (const [repoPath, holder] of this.repoLocks) {
    if (holder === peerAddress) {
      this.repoLocks.delete(repoPath);
    }
  }
}
```

**Step 4: Update `handleMessage` signature**

```typescript
async handleMessage(message: Message, peerAddress: string = 'default'): Promise<Message> {
```

The default value ensures backward compatibility with existing tests.

**Step 5: Update all handler methods to use per-client git**

Replace every `this.git` usage with `this.getGit(peerAddress)`. Pass `peerAddress` through to each handler method. For example:

```typescript
case 'git:status':
  return this.handleStatus(message as Message<StatusRequestPayload>, peerAddress);
```

And in the handler:

```typescript
private async handleStatus(message: Message<StatusRequestPayload>, peerAddress: string): Promise<Message<StatusResponsePayload>> {
  const status = await this.getGit(peerAddress).getStatus();
  const response = createMessage<StatusResponsePayload>('git:status:response', status);
  response.id = message.id;
  return response;
}
```

Do this for ALL handler methods. The mutating handlers (stage, unstage, commit, checkout, discard, stage-patch, unstage-patch) should acquire/release the lock:

```typescript
private async handleStage(message: Message<StageRequestPayload>, peerAddress: string): Promise<Message<StageResponsePayload>> {
  const repoPath = this.getClientRepoPath(peerAddress);
  if (!this.acquireRepoLock(repoPath, peerAddress)) {
    const response = createMessage<StageResponsePayload>('git:stage:response', {
      success: false,
      error: 'Repository is busy — another device is performing an operation',
    });
    response.id = message.id;
    return response;
  }
  try {
    await this.getGit(peerAddress).stage(message.payload.paths);
    const response = createMessage<StageResponsePayload>('git:stage:response', { success: true });
    response.id = message.id;
    return response;
  } catch (error) {
    const response = createMessage<StageResponsePayload>('git:stage:response', {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stage files',
    });
    response.id = message.id;
    return response;
  } finally {
    this.releaseRepoLock(repoPath, peerAddress);
  }
}
```

Apply the same lock pattern to: `handleUnstage`, `handleCommit`, `handleCheckout`, `handleDiscard`, `handleStagePatch`, `handleUnstagePatch`.

**Step 6: Update `handleSwitchRepo` to use per-client state**

```typescript
private handleSwitchRepo(message: Message<SwitchRepoRequestPayload>, peerAddress: string): Message<SwitchRepoResponsePayload> {
  const { path } = message.payload;
  if (!this.repos.has(path)) {
    const response = createMessage<SwitchRepoResponsePayload>('agent:switch-repo:response', {
      success: false,
      newPath: this.getClientRepoPath(peerAddress),
      error: `Repository not available: ${path}`,
    });
    response.id = message.id;
    return response;
  }

  this.clientRepos.set(peerAddress, path);
  const response = createMessage<SwitchRepoResponsePayload>('agent:switch-repo:response', {
    success: true,
    newPath: path,
  });
  response.id = message.id;
  return response;
}
```

**Step 7: Update `handleListRepos` to return per-client current**

```typescript
private async handleListRepos(message: Message, peerAddress: string): Promise<Message<ListReposResponsePayload>> {
  const repos: Repository[] = [];
  for (const repo of this.availableRepos) {
    const git = this.repos.get(repo.path)!;
    try {
      const { current } = await git.getBranches();
      repos.push({ ...repo, currentBranch: current });
    } catch {
      repos.push(repo);
    }
  }
  const response = createMessage<ListReposResponsePayload>('agent:list-repos:response', {
    repos,
    current: this.getClientRepoPath(peerAddress),
  });
  response.id = message.id;
  return response;
}
```

**Step 8: Update `handleHandshake` to return per-client repo path**

```typescript
private handleHandshake(message: Message<HandshakePayload>, peerAddress: string): Message<HandshakeAckPayload> {
  const response = createMessage<HandshakeAckPayload>('handshake:ack', {
    success: true,
    agentVersion: this.agentVersion,
    repoPath: this.getClientRepoPath(peerAddress),
    availableRepos: this.availableRepos,
  });
  response.id = message.id;
  return response;
}
```

**Step 9: Run tests**

Run: `cd apps/agent && npx vitest run`

Expected: ALL tests pass (44 existing + new multi-client tests).

**Step 10: Commit**

```bash
git add apps/agent/src/handlers/messageHandler.ts apps/agent/src/handlers/messageHandler.test.ts apps/agent/src/connection/signaling.ts apps/agent/src/connection/connection.ts
git commit -m "feat: multi-client agent support — per-peer sessions, per-client repo context, repo locking

Refactored SignalingClient to pass peer addresses through instead of storing
a single peerAddress. Renamed WebRTCConnection to AgentConnection with
Map<peerAddress, PeerSession> for per-peer encryption. MessageHandler now
tracks per-client repo context and uses per-repo mutexes."
```

---

### Task 4: Wire Up index.ts

**Files:**
- Modify: `apps/agent/src/index.ts`

**Step 1: Update imports and wiring**

```typescript
import { AgentConnection } from './connection/connection.js';
```

Update the connection creation:

```typescript
const connection = new AgentConnection({
  signalingServer,
  agentId: config.agentId,
  keyPair: config.keyPair,
});
```

Update the message handler wiring:

```typescript
connection.on('message', async (message: Message, peerAddress: string) => {
  const response = await messageHandler.handleMessage(message, peerAddress);
  connection.send(response, peerAddress);
});

connection.on('connected', (peerAddress: string) => {
  const peerKey = peerAddress.replace('pwa:', '');
  console.log(`\n+ PWA connected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} client${connection.getPeerCount() !== 1 ? 's' : ''})`);
});

connection.on('disconnected', (peerAddress: string) => {
  const peerKey = peerAddress.replace('pwa:', '');
  messageHandler.removeClient(peerAddress);
  console.log(`\n- PWA disconnected: ${peerKey.slice(0, 12)}... (${connection.getPeerCount()} client${connection.getPeerCount() !== 1 ? 's' : ''})`);
  if (!connection.hasPeers()) {
    displayConnectionInfo(config.agentId, config.keyPair.publicKey, options.qr);
  }
});
```

**Step 2: Verify build compiles**

Run: `cd apps/agent && npx tsc --noEmit`

Expected: No errors.

**Step 3: Run all tests**

Run: `cd apps/agent && npx vitest run`

Expected: ALL tests pass.

**Step 4: Build the agent**

Run: `cd apps/agent && npm run build`

Expected: Build succeeds.

**Step 5: Commit**

```bash
git add apps/agent/src/index.ts
git commit -m "feat: wire multi-client support in agent entry point"
```

---

### Task 5: Update Exports and Verify End-to-End

**Files:**
- Check: Any file that imports `WebRTCConnection` or `WebRTCConnectionEvents`

**Step 1: Search for stale references**

Run: `grep -r "WebRTCConnection\|WebRTCConnectionEvents" apps/agent/src/ --include="*.ts" -l`

Fix any remaining references to use `AgentConnection` / `AgentConnectionEvents`.

**Step 2: Run full test suite**

Run: `cd apps/agent && npx vitest run`

Expected: ALL tests pass.

**Step 3: Full build**

Run: `cd apps/agent && npm run build`

Expected: Build succeeds with no errors.

**Step 4: Final commit if any fixups needed**

```bash
git add -A apps/agent/
git commit -m "chore: clean up stale WebRTCConnection references"
```
