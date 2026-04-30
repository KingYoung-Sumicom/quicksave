# Quicksave System Architecture

> **Maintenance rule**: this document must be updated in the same change whenever any of the following are modified:
> - Adding or removing submodules under `apps/` or `packages/`
> - Changing WebSocket message types (`packages/shared/src/types.ts`)
> - Changing routing logic in `MessageHandler`
> - Changing the interface or lifecycle of `SessionManager` or `CodingAgentProvider`
> - Changing `AgentConnection`'s encryption or PubSub mechanism
> - Changing the PWA store's state shape or hook API
> - Adding or removing AI provider implementations (e.g. `ClaudeCodeProvider`, `CodexAppServerProvider`)

---

## 一、Monorepo Structure

```
quicksave/
├── apps/
│   ├── agent/          # Desktop daemon: AI service + Git + encrypted comms
│   ├── pwa/            # React PWA: mobile/desktop web UI
│   └── relay/          # WebRTC signaling relay server (minimal implementation)
├── packages/
│   └── shared/         # Shared TypeScript types, crypto utilities
├── docs/
│   ├── guidelines.md   # Index of design guidelines
│   ├── plans/          # Feature plans
│   └── references/     # Technical reference docs (including this one)
└── tests/              # E2E tests
```

---

## 二、apps/agent — Core Daemon

### Directory Structure

```
apps/agent/src/
├── index.ts                # CLI entry (`quicksave-agent` binary, commander)
├── config.ts               # AgentConfig load/save + peer pubkey pinning
├── tombstoneCheck.ts       # Tombstone signature verify + fetch
├── service/
│   ├── run.ts              # Daemon entry (`quicksave service run`); event wiring
│   ├── ipcServer.ts        # IPC JSON-RPC server (Unix socket)
│   ├── ipcClient.ts        # JSON-RPC client used by the CLI subcommands
│   ├── ensureDaemon.ts     # CLI helper: spawn the daemon if not running
│   ├── singleton.ts        # Singleton lock (prevents duplicate starts)
│   ├── stateStore.ts       # Service state persistence (service.json)
│   ├── pushClient.ts       # Signed HTTP client → relay push routes
│   ├── debugHttpServer.ts  # Optional debug HTTP (QUICKSAVE_DEBUG=1)
│   └── types.ts            # IPC types + dev/debug flags
├── handlers/
│   ├── messageHandler.ts   # Routing and handling for all WebSocket messages
│   └── legacyBusAdapter.ts # `LEGACY_BUS_VERBS` allowlist + bus→messageHandler bridge
├── messageBus/
│   └── busServerTransport.ts  # Filters `bus:frame` off AgentConnection for MessageBusServer
├── connection/
│   ├── connection.ts       # AgentConnection: E2E encryption + message routing
│   ├── relay.ts            # SignalingClient: WebRTC signaling
│   └── pubsub.ts           # Topic-based PubSub (broadcast fan-out)
├── storage/
│   └── eventStore.ts       # SQLite per-session event log (cards, cache touches, ...)
├── ai/
│   ├── provider.ts             # CodingAgentProvider interface + permission level helpers
│   ├── sessionManager.ts       # SessionManager: generic session coordination (extends EventEmitter)
│   ├── claudeCodeProvider.ts   # ClaudeCodeProvider: agent-id 'claude-code'; delegates to CLI or SDK transport
│   ├── claudeCliProvider.ts    #   CLI transport: spawns `claude` and parses stream-json
│   ├── claudeSdkProvider.ts    #   SDK transport: @anthropic-ai/claude-agent-sdk in-process
│   ├── codexMcpProvider.ts     # (legacy MCP-based codex provider; unregistered by default)
│   ├── codexAppServer/         # Codex provider — JSON-RPC v2 client speaking `codex app-server`
│   │   ├── provider.ts         #   CodexAppServerProvider + CodexAppServerSession (lifecycle / runTurn / interrupt)
│   │   ├── processManager.ts   #   Spawn `codex app-server`, run initialize handshake, version pin check
│   │   ├── rpcClient.ts        #   JSON-RPC 2.0 dispatcher (request/response/notification/server-request)
│   │   ├── stdioTransport.ts   #   JSONL framing on the spawned child's stdio
│   │   ├── cardAdapter.ts      #   v2 notifications → StreamCardBuilder method calls
│   │   ├── tokenAccounting.ts  #   Per-turn delta + cumulative usage tracking
│   │   ├── overrideStore.ts    #   Pending/effective per-turn overrides (model/effort/permission)
│   │   ├── approvalMapping.ts  #   tool-name + sandbox toggle → AskForApproval matrix
│   │   ├── permissionMapping.ts# PermissionLevel → AskForApproval / SandboxPolicy / ApprovalsReviewer matrix
│   │   ├── version.ts          #   Pinned `codex` minimum-version check
│   │   └── schema/generated/   #   Vendored TS bindings from `codex app-server generate-ts`
│   ├── codexLogin.ts           # `codex login --device-auth` orchestration
│   ├── cardBuilder.ts          # StreamCardBuilder: stream-json events → CardEvent
│   ├── sessionStore.ts         # Per-session JSONL message history (cold-resume reads)
│   ├── sessionRegistry.ts      # SessionRegistry: active+archived metadata (see below)
│   ├── enrichEntry.ts          # Decorate registry entries for /sessions/history snapshot
│   ├── systemPrompt.ts         # `--append-system-prompt` builder
│   ├── sandboxMcp.ts           # In-process MCP server: SandboxBash + UpdateSessionStatus tool defs
│   ├── sandboxMcpStdio.ts      # stdio adapter for the same MCP server when run as a subprocess
│   ├── debugLogger.ts          # Per-session NDJSON debug log (QUICKSAVE_DEBUG=1)
│   ├── asyncQueue.ts           # Single-flight async queue helper
│   ├── commitSummary.ts        # CommitSummaryService: commit message via Anthropic SDK (requires API key)
│   ├── commitSummaryCli.ts     # CommitSummaryCliService: commit message via `claude -p` (agentic, uses Claude subscription)
│   └── commitSummaryStore.ts   # CommitSummaryStateStore: per-repo generation state + token guard
├── terminal/
│   └── terminalManager.ts    # PTY pool + scrollback buffer per terminal
├── files/
│   └── fileBrowser.ts        # Read-only file browser (list / read, with path sandboxing)
└── git/
    └── operations.ts         # Git command execution
```

> **Terminal subsystem**: `TerminalManager` (above) is a standalone EventEmitter that does not share state with AI sessions. It uses `node-pty` to open a shell (default `$SHELL -l`) and retains the raw output of each PTY (including ANSI codes) in a ring buffer capped at 256 KiB. The PWA reconstructs the terminal screen by subscribing to two buses, `/terminals` and `/terminals/:id/output`; on offline reconnect the snapshot brings back the entire scrollback so the screen returns to its pre-disconnect state immediately.

> **File browser subsystem**: `FileBrowser` (`apps/agent/src/files/fileBrowser.ts`) is a pure request-response, stateless, read-only module — no EventEmitter, no bus subscription, because file content is fetched on-demand rather than streamed. Each request carries `cwd` (project root) + `path` (relative path); `resolveWithinRoot()` resolves the target to an absolute path and asserts it is still inside `realpath(cwd)`, rejecting anything outside. Binary detection uses a NUL-byte sniff over the first 8 KiB; the default preview cap is 100 KiB (`maxBytes` can override but is hard-clamped at 512 KiB).

### Startup Sequence (`service/run.ts → runDaemon()`)

```
acquireLock()
  → ipcServer.listen(socketPath)                     # Unix socket (IPC)
  → getOrCreateConfig()                              # Read ~/.quicksave/config.json
  → new AgentConnection(...)                         # Establish signaling connection
  → busTransport = new BusServerTransport(connection)
  → bus = new MessageBusServer(busTransport)         # MessageBus on top of E2E channel
  → new MessageHandler(repos, license, codingPaths, isProduction)
      // MessageHandler internally does:
      //   new SessionManager([new ClaudeCodeProvider(), new CodexAppServerProvider()])
  → claudeService = messageHandler.getClaudeService()
  → bus.onSubscribe('/sessions/active'|'/preferences'|'/sessions/history'|
                    '/repos/commit-summary'|'/sessions/config'|
                    '/sessions/:sessionId/cards'|'/sessions/:sessionId/attention'|
                    '/terminals'|'/terminals/:terminalId/output', ...)
  → claudeService.on('card-event' | 'card-stream-end' | …) → bus.publish(...)
  → wireLegacyBusVerbs(bus, messageHandler)          # Bridge LEGACY_BUS_VERBS → handleMessage
  → writeServiceState()                              # Write service.json (ready)
  → heartbeatLoop(30s)
```

### Session Lifecycle (Layered Architecture)

The architecture uses a layered design: `SessionManager` provides unified coordination across multiple `CodingAgentProvider` implementations (`ClaudeCodeProvider`, `CodexAppServerProvider`, …) registered at construction time; each provider hides agent-specific details.

#### Layer Breakdown

1. **`ClaudeCodeProvider` (id `'claude-code'`)** — thin facade picking either:
   - **`ClaudeCliProvider`** — spawns the `claude` CLI and parses stream-json events
     (stream_event / assistant / user / system / result / control_request). Manages
     ChildProcess lifecycle and stdin framing.
   - **`ClaudeSdkProvider`** — equivalent in-process driver using
     `@anthropic-ai/claude-agent-sdk`. Selected via `QUICKSAVE_CLAUDE_TRANSPORT` /
     `QUICKSAVE_PROVIDER` env vars; CLI is the default.

2. **`CodexAppServerProvider` (id `'codex'`)** — JSON-RPC v2 client speaking
   `codex app-server` (initialize handshake → newConversation → sendUserTurn →
   notification stream). See `apps/agent/src/ai/codexAppServer/`.

3. **`SessionManager`** — Generic coordination layer (extends EventEmitter)
   - Session state management (`ManagedSession` map + per-session agent / permission / sandbox / config side maps)
   - Card assembly and history (StreamCardBuilder, buildCardsFromHistory, loadPersistedCards)
   - Permission flow (auto-approve table, runtime allow patterns, PWA forwarding via `handlePermissionRequest` callback)
   - Preferences and per-session config
   - Event emission (`card-event`, `card-stream-end`, `user-input-request`, `user-input-resolved`, `session-updated`, `preferences-updated`, `session-config-updated`)
   - Session registry integration; on-disk bypass-flag sentinel for CLI auto-approve hook
   - Cold-resume queueing via `coldResumeInFlight` so prompts arriving during a respawn don't get lost

#### Session Operation Flow

```
claude:start → MessageHandler.handleClaudeStart()
  → SessionManager.startSession(opts)
    → provider.startSession(opts, cardBuilder, callbacks)   // returns { sessionId, session: ProviderSession }
       For ClaudeCliProvider:
         spawn('claude', ['--output-format', 'stream-json', '--input-format', 'stream-json',
                          '--permission-prompt-tool', 'stdio', '--append-system-prompt', '...', ...])
         → Wait for system:init event on stdout to obtain session_id
         → stdin write { type: 'user', message: { role: 'user', content: prompt } }
         → consumeStream loop on stdout:
             control_request → callbacks.handlePermissionRequest → allow/deny via stdin control_response
             stream_event/assistant/user/system → CardBuilder → callbacks.emitCardEvent
             result → callbacks.emitStreamEnd
       For CodexAppServerProvider:
         processManager.ensureRunning() (initialize handshake first time)
         conversation = await rpc.request('newConversation', {…})
         await rpc.request('sendUserTurn', {…}); cardAdapter translates v2 notifications → CardBuilder
    → SessionManager registers ManagedSession + permission table + bypass-flag sentinel
  ← sessionId

claude:resume → SessionManager.resumeSession(opts)
  → 1. Hot resume (active turn): existing.streaming && providerSession.alive
       → providerSession.sendUserMessage(prompt); the provider consumes the next prompt after the current turn ends
  → 2. Hot resume (idle): !existing.streaming && providerSession.alive && !modelChanged && !contextWindowChanged
       → Reuse the same process: providerSession.sendUserMessage(prompt). Avoids the latency and "ghost inactive" flicker of kill+spawn.
       → For Claude CLI, a contextWindow change can be applied live via providerSession.updateContextWindow(...) before sending.
  → 3. Cold resume: providerSession is dead, the model changed, or the auto-compact tier changed for a non-CLI provider
       → provider.resumeSession(opts, ...): for the CLI this is `spawn('claude', [..., '--resume', sessionId])`
       → Note: the CLI's --resume may fork a new session_id (reported by the init event).
         If the new id differs from opts.sessionId, SessionManager rekeys the sessions map
         and side maps (migrateSessionIdState) and emits isActive=false for the old id,
         so the PWA clears the old active state.
       → Cold resumes are guarded by `coldResumeInFlight`; concurrent prompts are queued and drained on the new session.

claude:cancel → SessionManager.cancelSession(sessionId)
  → providerSession.interrupt()                       // CLI: stdin control_request {subtype:'interrupt'}; Codex: rpc 'interrupt'
  → cancelPendingInputsForSession(sessionId)          // resolve outstanding permission promises with deny

claude:close → SessionManager.closeSession(sessionId)
  → providerSession.kill()                            // CLI: SIGTERM the child; Codex: closeConversation rpc
  → applyBypassFlag(token, false) + sessions.delete + cancelPendingInputsForSession + emitSessionUpdate(isActive=false)
  (Used by Advanced > Terminate Coding Agent Process; the registry entry is left as-is in the active subtree)

claude:end-task → MessageHandler.handleClaudeEndTask
  → 1. SessionManager.getSessionCwd(sessionId) (while alive); fall back to
       getSessionRegistry().findBySessionId so cold sessions can also be archived.
  → 2. SessionManager.closeSession(sessionId) — kill the live process if any
  → 3. registry.updateEntry(cwd, sessionId, { archived: true })
       + onHistoryUpdated(cwd, entry, 'upsert') broadcasts /sessions/history
  The PWA's End Task button takes this path; the session disappears from the active list and moves to archived.

Provider process exits naturally (stdout EOF, RPC close, or crash):
  → callbacks.onSessionExited(sessionId, providerSession) (after a synthetic streamEnd if no result was emitted)
  → SessionManager.onSessionExited:
      - If the providerSession in the current slot is still the same one (not replaced by cold resume)
        → sessions.delete(sessionId) + emitSessionUpdate(isActive=false)
      - providerSession identity check guards against a stale callback from an old process dying
        during a cold resume and accidentally clearing the new process's session.
```

**Permission handling — control_request/control_response protocol:**
```
CLI stdout: { type: 'control_request', request_id: 'uuid', request: { subtype: 'can_use_tool', tool_name, input, tool_use_id } }
  → SessionManager.shouldAutoApprove(toolName)? 
    → stdin: { type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'allow' } } }
  → Otherwise: build a ToolCallCard with pendingInput → emit card-event → PWA shows Allow/Deny
  → After the user responds: sessionManager.handleUserInputResponse() → stdin: control_response with allow/deny
```

**ManagedSession data structure** (`ai/sessionManager.ts`):
```typescript
interface ManagedSession {
  sessionId: string;
  agentId: AgentId;                   // 'claude-code' | 'codex'
  providerSession: ProviderSession | null;
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  cardBuilder: StreamCardBuilder | null;
  spawnedModel?: string;              // forces cold resume on model change
  spawnedContextWindow?: number;      // tracks live auto-compact ceiling (CLI only)
  bypassToken: string;                // sentinel-file token for the PermissionRequest hook
  lastCacheTouchAt?: number;          // anchor for the PWA prompt-cache countdown
  lastPersistedCacheTouchAt?: number; // throttle for cache_touched event store writes
}
```

Pending permission requests live in a separate `pendingInputRequests` map on `SessionManager`, keyed by `requestId`.

**ProviderSession interface** (`ai/provider.ts`):
```typescript
interface ProviderSession {
  sendUserMessage(prompt: string): void;
  interrupt(): void;
  kill(): void;
  readonly alive: boolean;
  /** Optional — Claude Code CLI only. Queries `get_context_usage` and returns a
   *  category-level breakdown of the current context window. */
  getContextUsage?(): Promise<ContextUsageBreakdown | null>;
  /** Optional — live-switch the auto-compact ceiling without respawning.
   *  Only the Claude CLI implements it; SDK / Codex providers omit it and
   *  SessionManager falls back to cold-respawn. */
  updateContextWindow?(window: number, decoratedModel?: string): Promise<void>;
}
```

The provider receives a `ProviderCallbacks` bundle (`emitCardEvent`, `emitStreamEnd`, `handlePermissionRequest`, `onToolUse`, `onCacheTouch`, `onModelDetected`, `onSessionExited`) so it can drive `SessionManager` without a back-reference. There is no `cancelSession` / `closeSession` on the provider interface — those live on `SessionManager` and are implemented by calling `interrupt()` / `kill()` on the held `ProviderSession`.

### Session Registry (persistence)

`SessionRegistry` (`ai/sessionRegistry.ts`) is responsible for persisting session metadata, split across two on-disk subtrees:

```
~/.quicksave/state/session-registry/
├── {encoded-cwd}/                        # Active subtree — fully loaded into memory at daemon startup
│   └── {sessionId}.json
└── archived/
    └── {encoded-cwd}/                    # Archived subtree — read from disk only when needed, never in memory
        └── {sessionId}.json
```

- `encoded-cwd` replaces `/` with `-` (matching the convention of Claude Code's `~/.claude/projects/`)
- **Memory only holds active entries**: after archiving, daemon memory footprint and `/sessions/history` snapshot size scale with the number of "in-use" sessions, not total history
- `upsertEntry(entry)` automatically routes to the correct subtree based on `entry.archived` and deletes the stale file on the other side; `updateEntry()` can locate an entry in memory or on the archived disk subtree, and automatically migrates it when the `archived` flag flips
- `loadAll()` ignores the `archived/` subdirectory; if it encounters a legacy file with `archived: true` in the active subtree, it auto-migrates it to the archived subtree (one-time migration)
- For reading archived metadata (e.g. an unarchive UI): `readArchivedEntry(cwd, id)` / `listArchivedEntries(cwd?)` both read on-demand from disk

### AI Provider Events

`SessionManager` extends `EventEmitter` and emits the following events (driven by whichever provider is active):

| Event Name | Payload Type | When |
|---|---|---|
| `card-event` | `CardEvent` | On every card add/update/append_text |
| `card-stream-end` | `CardStreamEnd` | When a turn ends or errors |
| `user-input-request` | `ClaudeUserInputRequestPayload` | When user approval of a tool is required |
| `user-input-resolved` | `{ requestId, sessionId }` | When a pending input has been answered or cancelled |
| `session-updated` | `SessionUpdatePayload` | On session state change (active / streaming / pending) |
| `preferences-updated` | `ClaudePreferences` | After `setPreferences` writes to disk |
| `session-config-updated` | `SessionConfigUpdatedPayload` | After `setSessionConfig` (or sandbox MCP `UpdateSessionStatus`) writes |

**Provider interface** (`ai/provider.ts`):
```typescript
interface CodingAgentProvider {
  readonly id: AgentId;                                 // 'claude-code' | 'codex'
  readonly historyMode: 'claude-jsonl' | 'memory';

  startSession(
    opts: StartSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }>;

  resumeSession(
    opts: ResumeSessionOpts,
    cardBuilder: StreamCardBuilder,
    callbacks: ProviderCallbacks,
  ): Promise<{ sessionId: string; session: ProviderSession }>;
}
```

To add a new provider, implement this interface and include it in the array passed to the `SessionManager` constructor:
```typescript
const sessionManager = new SessionManager([
  new ClaudeCodeProvider(),
  new CodexAppServerProvider(),
  new MyCustomProvider(),
]);
```
`MessageHandler` constructs the default lineup `[ClaudeCodeProvider, CodexAppServerProvider]` unless an `options.sessionManager` is injected (used by the e2e harness with a `StubProvider`).

### Permission Modes

Claude Code (`ClaudePermissionMode` in `ai/provider.ts`):

| `permissionMode` | Description | Auto-approved Tools |
|---|---|---|
| `bypassPermissions` | Most permissive | Edit, Write, NotebookEdit, TodoWrite, Agent, EnterWorktree/ExitWorktree, WebFetch, WebSearch, Bash, Skill, ToolSearch, Config, Cron*, RemoteTrigger, EnterPlanMode/ExitPlanMode, TaskOutput, TaskStop |
| `acceptEdits` | Accept edits | Edit, Write, NotebookEdit, TodoWrite, Agent, EnterWorktree/ExitWorktree, EnterPlanMode |
| `default` | Standard | TodoWrite, EnterWorktree/ExitWorktree, Agent, EnterPlanMode |
| `auto` | Same allowlist as `default`; PWA default for new sessions | TodoWrite, EnterWorktree/ExitWorktree, Agent, EnterPlanMode |
| `plan` | Planning only | EnterPlanMode |

Codex (`CodexPermissionPreset`): `read-only`, `default`, `auto-review`, `full-access` — see `CODEX_AUTO_APPROVE` in `sessionManager.ts`. Compatibility shims in `normalizePermissionLevelForAgent` map legacy Claude-only values (`bypassPermissions` → `full-access`, `plan` → `read-only`, `auto` → `auto-review`, `acceptEdits` → `default`).

**Sandbox MCP tool permissions:**
- `UpdateSessionStatus` — always auto-approved; handled in `sessionManager.shouldAutoApprove`, which writes
  `subject` / `stage` / `blocked` / `note` back to the session config and `SessionRegistryEntry`,
  and triggers the `session-config-updated` event. The `note` field is append-only: each call with a non-empty `note`
  appends an entry `{ts, text}` to `SessionRegistryEntry.noteHistory`; when the list exceeds
  `SESSION_NOTE_HISTORY_CAP` (50) it is trimmed oldest-first. The latest line is also mirrored to `note` for quick display
  on the home screen. `noteHistory` is broadcast via the existing `/sessions/history` bus channel.
- `SandboxBash` (sandbox ON) — auto-approved, executed inside the kernel sandbox
- `SandboxBash` (sandbox OFF) — treated as `Bash`, subject to the auto-approve rules of the current permissionMode

### System Prompt

Injected via the `--append-system-prompt` CLI argument; passed on both start and resume. Fixed contents:
- Steers Claude to prefer `SandboxBash` for read-only commands
- Requires Claude to call `UpdateSessionStatus` on the first turn of every new session (ticket model:
  `subject` + `stage ∈ {investigating, working, verifying, done}` + `blocked` flag + `note`),
  and to update again when the stage changes, when a block clears, or when there is reportable progress. The `note` is written
  to the session's append-only event log (`noteHistory`); for long tasks (research / large refactors), Claude is encouraged to
  emit a note at each sub-goal or finding, so that when the user opens the session they can skim the most recent entries as a progress signal
- A PWA agent type can append a custom system prompt

### Commit Message Generation (two paths)

The `ai:generate-commit-summary` payload carries `source: 'api' | 'claude-cli'` (default `'api'`). `handleGenerateCommitSummary` branches on this:

- **`source: 'api'`** → `CommitSummaryService` (`commitSummary.ts`)
  - Calls the API directly through the Anthropic SDK (the user must configure an Anthropic API key in Settings)
  - Truncates the staged diff and stuffs it into a single prompt — fast, but lacks cross-file context
  - Has an in-memory cache (5-minute TTL, keyed on diff + model + context)

- **`source: 'claude-cli'`** → `CommitSummaryCliService` (`commitSummaryCli.ts`)
  - One-shot `spawn` of `claude -p "<prompt>"` with `--output-format stream-json --verbose --no-session-persistence`
  - Whitelists only read-only tools: `Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(git show:*),Bash(git blame:*)`
  - Uses the user's local Claude Code subscription/login — **no** Anthropic API key required
  - Agentic loop: Claude runs `git diff --cached`, greps relevant callers, reads neighboring files, then writes the message
  - Stream-json events are parsed by `interpretStreamEvent()` into `CommitSummaryProgress` (`preparing` / `inspecting` / `generating` / `finalizing`) and pushed all the way to the PWA
  - No caching (output is non-deterministic); 120s timeout; exit code / stderr is mapped to `NO_CLI_BINARY` / `NO_CLI_AUTH` / `CLI_TIMEOUT` / `CLI_PARSE_ERROR` / `CLI_ERROR` and returned to the UI

#### Agent-Owned Commit Summary State

Generation can take ~2 minutes; if state lived in the PWA it would be interrupted by a reload or tab switch. So the AI-generated suggestion's state is moved to the agent and held by `CommitSummaryStateStore` (`ai/commitSummaryStore.ts`):

- Bucketed by `repoPath`; one `CommitSummaryState` per bucket (status: `idle` / `generating` / `ready` / `error`)
- `startGenerating()` returns an opaque `Symbol` token; subsequent progress / result / error writes must carry the token, and writes whose token does not match are dropped (preventing a stale or superseded run from overwriting newer state)
- Every state change emits `state-updated`; `service/run.ts` bridges this event to `connection.broadcast('ai:commit-summary:updated', state)`, so all connected peers stay in sync
- Message API:
  - `ai:generate-commit-summary` — kickoff (synchronously returns the kickoff response; subsequent updates flow via push)
  - `ai:commit-summary:clear` — invoked when the user dismisses or applies the suggestion; kills any running CLI
  - `/repos/commit-summary` bus subscription — when the PWA connects it automatically receives a snapshot + deltas; on reconnect the bus auto-resends the sub (replacing the now-removed `ai:commit-summary:get` command)
  - `ai:commit-summary:updated` — agent → PWA state push. (Note: `CROSS_TAB_MESSAGE_TYPES` in `apps/pwa/src/lib/websocket.ts` is currently empty; cross-tab BroadcastChannel fan-out is wired but no message types are routed through it today.)
- After a successful commit, `handleCommit` automatically calls `commitSummaryStore.clear(repoPath)` (the suggestion is now stale)
- The PWA gitStore only mirrors: on receiving `ai:commit-summary:updated` → `applyCommitSummaryState()`; the user-typed commit draft still lives in PWA localStorage and is not sent to the agent

---

## 三、Communication Architecture

### End-to-End Encryption Flow

```
PWA                           Relay Server                  Agent Daemon
 |                                |                              |
 |──── handshake (pubkey) ───────>|──── forward ──────────────>|
 |<─── handshake:ack (pubkey) ────|<─── forward ─────────────--|
 |                                |                              |
 |  X25519 ECDH key exchange → derive DEK (Data Encryption Key)  |
 |                                |                              |
 |──── [encrypt+gzip] message ───>|──── forward ──────────────>|
 |<─── [encrypt+gzip] message ────|<─── forward ─────────────--|
```

- Each peer has its own DEK; the relay server cannot decrypt content
- Messages are gzip-compressed before encryption and transmission

### MessageBus (`packages/message-bus`) — RPC + PubSub between PWA and Agent

All request-response, state subscribe, and server push between PWA and Agent go through MessageBus. A `bus:frame` envelope sits on top of the existing `Message` and encapsulates three primitives: `command` / `subscribe(+snapshot)` / `publish`:

- **Server transport** (`apps/agent/src/messageBus/busServerTransport.ts`) wraps `AgentConnection`, filtering messages where `type === 'bus:frame'`; other messages (handshake, `push:subscription-offer`) take the legacy path.
- **Client transport** (`apps/pwa/src/lib/busClientTransport.ts`) is driven externally (`notifyMessage` / `notifyConnected` / `notifyDisconnected`) because `WebSocketClient` only has a single `onMessage` callback.
- **Snapshot-on-subscribe**: a `sub` frame's snapshot is delivered atomically; after a disconnect-reconnect, `MessageBusClient` automatically resends `sub`, the server sends the current snapshot again, and the "stale-after-reconnect" window is eliminated.
- **Command queueing**: the PWA's `bus.command(verb, payload, { queueWhileDisconnected: true })` holds requests while disconnected and auto-flushes on reconnect, avoiding lost requests due to reconnect races.

**Current subscribe paths:**
| Path | Snapshot Type | Update Type | Source |
|---|---|---|---|
| `/sessions/active` | `SessionUpdatePayload[]` | `SessionUpdatePayload` | `claudeService.snapshotActiveSessions()` + `session-updated` event |
| `/preferences` | `ClaudePreferences` | `ClaudePreferences` | `claudeService.getPreferences()` + `preferences-updated` event |
| `/sessions/history` | `BroadcastSessionEntry[]` | `SessionHistoryUpdatedPayload` | `sessionRegistry.getEntriesForProject().map(enrichEntry)` (active only; archived not in this snapshot) + `messageHandler.onHistoryUpdated` |
| `/repos/commit-summary` | `CommitSummaryState[]` | `CommitSummaryState` | `commitSummaryStore.snapshot()` + `state-updated` event |
| `/sessions/config` | `Record<sessionId, Record<key, ConfigValue>>` | `SessionConfigUpdatedPayload` | `claudeService.getAllSessionConfigs()` + `session-config-updated` event |
| `/sessions/:sessionId/cards` | `CardHistoryResponse` (offset=0, with pendingInput overlay + title) | `SessionCardsUpdate` (`{ kind: 'card', event }` or `{ kind: 'stream-end', result }`) | `claudeService.getCards()` + `card-event` / `card-stream-end` events |
| `/sessions/:sessionId/attention` | `null` (presence-only) | — | The PWA only subscribes when on the session page and the tab is visible+focused; `subscriberCount === 0` acts as the push gate |
| `/terminals` | `TerminalSummary[]` | `TerminalsUpdate` (`{ kind: 'upsert', terminal }` or `{ kind: 'remove', terminalId }`) | `terminalManager.listSummaries()` + `terminals-updated` / `terminal-updated` events |
| `/terminals/:terminalId/output` | `TerminalOutputSnapshot \| null` (scrollback + seq + size + exit status) | `TerminalOutputChunk` (next chunk of output, monotonic `seq`) | `terminalManager.outputSnapshot()` + PTY `'data'` event |

**Command adapter** (`handlers/legacyBusAdapter.ts` — `LEGACY_BUS_VERBS` + `wireLegacyBusVerbs`):
`service/run.ts` calls `wireLegacyBusVerbs(bus, messageHandler)` at startup. Every request-response verb in the `LEGACY_BUS_VERBS` array (`git:*`, `ai:*`, `agent:*`, `claude:*`, `session:*`, `project:*`, `push:*`, `codex:*`, `terminal:*`, `files:*`, plus `ping`) is registered as `bus.onCommand(verb, ...)`. The adapter wraps the payload back into a `Message` envelope, dispatches it to the existing `messageHandler.handleMessage`, then translates the result back into a resolved payload or a rejected Error. Structured errors are encoded as `"CODE: message"` strings (the PWA detects them via `err.message.startsWith('REPO_MISMATCH')`).

> ⚠️ **Gotcha — adding a new request/response verb requires updates in three places**: `LEGACY_BUS_VERBS` is an explicit allowlist; a verb not in it will not be registered as a bus handler even if `messageHandler`'s `switch` has a case, and the PWA will receive a `"Unknown command: <verb>"` reject. When adding any PWA→Agent command, three places must be touched: (1) the `MessageType` union in `packages/shared/src/types.ts` and the request→response mapping in `protocol.ts`; (2) the switch case + handler in `messageHandler.ts`; (3) the `LEGACY_BUS_VERBS` array in `handlers/legacyBusAdapter.ts`.

**The `__repoPath` smuggle for `git:*`**: the bus protocol has no envelope-level metadata, so `useGitOperations.sendCommand` stuffs the current repoPath into the reserved `__repoPath` field on the payload; the adapter pulls it out and puts it back into `msg.repoPath` for the REPO_MISMATCH guard to check, then on response mirrors the server-acknowledged repoPath back to `data.__repoPath` so the PWA can validate scope.

**PubSub internals (`connection/pubsub.ts`)**:
`AgentConnection` still keeps a topic-based pubsub internally for `connection.broadcast()` to use (global broadcast to all peers), but PWA ↔ Agent session/state events have all moved to MessageBus `/path` subscriptions; topics like `session:{id}` are no longer needed. Broadcast topics are mainly retained for relay-side event fan-out.

### Web Push Side Channel (signed HTTP)

When the PWA is offline (tab closed or backgrounded) but a session needs attention, the agent triggers a Web Push notification through the relay's signed HTTP routes.

**Keys** (alongside the existing box keypair):
- **Agent Ed25519 signing keypair** (`config.signKeyPair`) — identifies who is signing the HTTP request
- **Relay VAPID keypair** — proves the relay's identity to FCM/APNs / Mozilla autopush

**Endpoints**:
| Route | Caller | Purpose |
|---|---|---|
| `POST /push/{signPubKey}/register` | Agent | Add a PushSubscription to the relay store |
| `POST /push/{signPubKey}/unregister` | Agent | Remove an endpoint |
| `POST /push/{signPubKey}/notify` | Agent | Send a notification to all subscriptions for that agent |

**Signing protocol** (`apps/relay/src/sigVerify.ts`):
- Canonical body: `${action}|${signPubKey}|${ts}|${nonce}|${extra.join('|')}`
- Ed25519 self-signed (no server-issued challenge) → avoids pending-channel DoS
- Replay protection: 60s `ts` window + 120s `nonce` TTL cache; `NONCE_TTL_MS >= TS_WINDOW_MS` is an invariant

**Data flow**:
```
PWA ──[browser subscribe()]──▶ FCM/APNs
 │  PushSubscription {endpoint, p256dh, auth}
 │
 │ [E2E WS: push:subscription-offer]
 ▼
Agent ──[POST /push/{signPubKey}/register, signed]──▶ Relay store (in-memory + JSON snapshot)
Agent ──[POST /push/{signPubKey}/notify,   signed]──▶ Relay → web-push (VAPID+ECE) → FCM/APNs
```

**Agent trigger conditions** (event hooks in `run.ts`):
- `user-input-request`, when `bus.subscriberCount('/sessions/:id/attention') === 0` (no peer is watching this session) → notify
- `card-stream-end`, when `bus.subscriberCount('/sessions/:id/attention') === 0`, not interrupted, and `hasPendingInputForSession` is false → notify

Both triggers produce the same `{title, body, sessionId, tag, agentId}` shape; `tag: sessionId` makes follow-up messages collapse into a single notification on the browser side.

**Why `attention` rather than `cards`**: with multiple devices on the same account, a backgrounded tab on another device would still keep the cards subscription, swallowing the notification entirely. `/sessions/:id/attention` is only subscribed when `document.visibilityState === 'visible' && document.hasFocus()`, and listens to `visibilitychange` / `focus` / `blur` / `pagehide` to unsubscribe immediately; leaving the session page or closing the tab also releases it. This way the push gate only reflects "is any device currently being held in hand to view this session", and other backgrounded devices do not affect the decision.

**PWA side** (`apps/pwa/src/lib/pushSubscription.ts` + `components/NotificationPrompt.tsx`):
- Service worker: `apps/pwa/src/sw.ts` (using the `injectManifest` strategy) handles `push` and `notificationclick`
- Permission prompt: after the first connection, if `Notification.permission === 'default'` a banner is shown
- Auto-offer: every time a connection completes with permission `granted`, `App.tsx` re-sends `push:subscription-offer` (the agent's register is upsert and idempotent)

### PWA Group Sync (shared-mailbox sync)

The "machine list / machine tombstones / apiKey / masterSecret" between PWAs flows through the relay's signed sync mailbox, not WebRTC:

- All PWAs on the same account derive the same `masterSecret` (stored in IndexedDB) → `deriveSharedKeys()` produces a shared X25519 + Ed25519 keypair
- A single mailbox address = `hash(shared_X25519_pubkey)`; all paired PWAs read and write the same mailbox
- The client (`apps/pwa/src/lib/syncClient.ts`) PUSHes via `SignedSyncEnvelope` (Ed25519-signed) on every push; the relay serializes PUTs with a per-mailbox mutex (10s TTL); on 409, the client retries with exponential backoff
- The payload is `SyncPayloadV3` (`apps/pwa/src/lib/syncMerge.ts`), with field-level `Timestamped<T>` + LWW merge

### Agent TOFU Trust Anchor + Tombstone Catch-up

The agent does not hold `masterSecret`; it only TOFU-pins the PWA group's shared pubkey:

- `AgentPairState = 'unpaired' | 'paired' | 'closed'`
- **unpaired** → on first signed handshake, write the peer's X25519 + Ed25519 pubkeys into `~/.quicksave/config.json` as `peerPWAPublicKey` / `peerPWASignPublicKey`
- **paired** → subsequent handshakes must be signed by the pinned Ed25519 pubkey; mismatches are rejected
- **closed** (runtime flag) → reject all incoming handshakes; unlocked by the CLI `quicksave pair`
- Tombstone checks use a catch-up GET: the relay's `'connected'` event triggers `runTombstoneCheck` (`apps/agent/src/tombstoneCheck.ts`); after signature verification it clears the peer pubkey from config, emits `'tombstoned'`, and sets the closed flag

CLI:
- `quicksave status` → prints state / agentId / peers / peerPWA pubkey
- `quicksave pair` → unlock closed + show QR/URL

For full design details see `docs/guidelines/sync-security.en.md`.

### Request-Response Pattern (MessageBus command)

```typescript
// PWA side (useClaudeOperations.ts / useGitOperations.ts)
const result = await busRef.current.command<ResponseType, RequestPayload>(
  'claude:start',
  payload,
  { timeoutMs: 30_000, queueWhileDisconnected: true },
);
// Internally the bus pairs cmd/result frames by id; errors are rejected as Error
```

On the agent side, each verb is registered as `bus.onCommand(verb, handler)` by `wireLegacyBusVerbs` (`handlers/legacyBusAdapter.ts`), invoked from `service/run.ts`; the adapter wraps the payload back into a Message envelope → `messageHandler.handleMessage` → returns a result frame. See "MessageBus Command adapter" above.

---

## 四、WebSocket Message Protocol

All messages share the format:
```typescript
interface Message {
  type: MessageType;
  id?: string;       // With id = request/response pairing; without id = push notification
  payload?: unknown;
}
```

### Naming Conventions

`{subsystem}:{action}` or `{subsystem}:{action}:response`

| Subsystem | Purpose |
|---|---|
| `claude:` | AI session control (start/resume/cancel/close/end-task/...; many types) |
| `session:` | Session config + history (`set-config`, `control-request`, `update-history`, `delete-history`, `list-archived`, `history-updated`, `config-updated`) |
| `git:` | Git operations (status/diff/stage/commit/...) |
| `agent:` | Daemon management (list-repos/add-repo/clone-repo/check-update/update/restart/...) |
| `ai:` | AI utilities (generate-commit-summary, commit-summary:clear, commit-summary:updated, set-api-key, get-api-key-status) |
| `codex:` | Codex model list + device-auth login flow (`list-models`, `login-start/-status/-cancel`, `login-updated`) |
| `project:` | Project summaries (`list-summaries`, `list-repos`, `delete`) |
| `push:` | Web Push subscription handoff (`push:subscription-offer`) |
| `terminal:` | PTY terminal (create/input/resize/rename/close) |
| `files:` | Read-only file browser (list / read; pure request-response, no bus subscription) |
| `bus:frame` | MessageBus envelope (transports opaque bus frames; see `packages/message-bus`) |
| `ping`/`pong` | Heartbeat |
| `handshake`/`handshake:ack` | Connection establishment |

### Claude-Related Message Types

PWA↔Agent session/cards/preferences events now all flow through MessageBus `/path` subscriptions (see the "MessageBus" section). The "Message type" column below is the verb name still used internally by `MessageHandler`; the corresponding bus usage is in the "bus equivalent" column.

| Type | Direction | Bus Equivalent | Description |
|---|---|---|---|
| — | Agent→PWA push | `bus.subscribe('/sessions/history')` | Full snapshot of historical sessions + incremental updates (replaces the now-removed `claude:list-sessions` command, avoiding races with `/sessions/active`) |
| `claude:start` | PWA→Agent | `bus.command('claude:start', …)` | Start a new session |
| `claude:resume` | PWA→Agent | `bus.command('claude:resume', …)` | Resume a session |
| `claude:cancel` | PWA→Agent | `bus.command('claude:cancel', …)` | Cancel streaming |
| `claude:close` | PWA→Agent | `bus.command('claude:close', …)` | Kill the underlying CLI process only; registry untouched (used by Advanced > Terminate) |
| `claude:end-task` | PWA→Agent | `bus.command('claude:end-task', …)` | Kill process **and** archive registry entry (the End Task button) |
| `claude:get-cards` | PWA→Agent | `bus.command('claude:get-cards', …)` | Page through historical cards (offset>0) |
| `claude:user-input-response` | PWA→Agent | `bus.command('claude:user-input-response', …)` | Reply to a tool approval/permission prompt |
| `claude:set-preferences` | PWA→Agent | `bus.command('claude:set-preferences', …)` | Write global preferences (reads go through the `/preferences` sub) |
| `claude:set-session-permission` | PWA→Agent | `bus.command('claude:set-session-permission', …)` | Change a session's permission mode |
| — | Agent→PWA push | `bus.subscribe('/sessions/:id/cards')` → `{kind: 'card', event}` / `{kind: 'stream-end', result}` | The old `claude:card-event` / `claude:card-stream-end` / `claude:user-input-request` have all moved to this path (CardBuilder carries the input request inside the pendingInput overlay) |
| — | Agent→PWA push | `bus.subscribe('/sessions/active')` | Replaces the removed `claude:active-sessions` command and `claude:session-updated` push |
| — | Agent→PWA push | `bus.subscribe('/preferences')` | Replaces the removed `claude:get-preferences` command and `claude:preferences-updated` push |
| — | Agent→PWA push | `bus.subscribe('/sessions/config')` | Config dict for all sessions (replaces the removed `session:get-config` command; for one-shot reads use `bus.getSnapshot('/sessions/config')`) |
| — | Agent→PWA push | `bus.subscribe('/repos/commit-summary')` | AI commit summary state for all repos (replaces the removed `ai:commit-summary:get` command) |
| `bus:frame` | Bidirectional | — | MessageBus envelope: payload is `ClientFrame` / `ServerFrame` (sub / unsub / cmd / snap / upd / result / sub-error) |
| `push:subscription-offer` | PWA→Agent | Goes through the legacy WS path (`connection.send`) | Multi-agent routing requires `sendToAgent`; the bus is single-active-agent |
| `push:subscription-offer:response` | Agent→PWA | Registration result `{success, error?}` |

---

## 五、packages/shared — Shared Types

### Key Type Locations

| Type | Path (types.ts line number) |
|---|---|
| `Message` envelope | line 5 |
| `MessageType` union | line 22 |
| `ClaudeSessionSummary` | line 1170 |
| `ClaudeHistoryMessage` | line 1389 |
| `ClaudeSubagentBlock` | line 1401 |
| `ClaudeGetMessagesResponsePayload` | line 1411 |
| `Card` / `CardEvent` | `cards.ts` |
| `AgentId` (`'claude-code' \| 'codex'`) | line 324 |
| `SessionRegistryEntry` | line 390 |
| `BroadcastSessionEntry` | line 471 |

### Card Data Model

Cards are the smallest unit of display in the PWA, assembled by `StreamCardBuilder` from CLI stream-json events:

```typescript
// packages/shared/src/cards.ts
type Card = {
  id: string;
  type: CardType;
  // ... different fields per type
};

type CardType =
  | 'user'           // User input
  | 'assistant_text' // Claude text reply
  | 'thinking'       // Extended thinking
  | 'tool_call'      // Tool call (with result)
  | 'subagent'       // Subagent execution block
  | 'system';        // System message
```

---

## 六、apps/pwa — React Frontend

### State Management (Zustand)

```
claudeStore.ts
  sessions: Record<sessionId, StoredSessionSummary>   // SessionMap, not array
  activeSessionId: string | null
  isStreaming: boolean
  streamError: string | null
  cards: Card[]
  historyTotal / historyHasMore / isLoadingHistory / historyError
  // Session preference fan-out (mirrors agentPrefs[selectedAgent])
  selectedAgent: AgentId               // 'claude-code' | 'codex'
  agentPrefs: Record<AgentId, AgentPrefs>
  selectedModel / selectedPermissionMode / selectedReasoningEffort
  sandboxEnabled / contextWindow
  sessionConfigs: Record<sessionId, Record<key, ConfigValue>>

identityStore.ts
  publicKey: string | null             // base64 X25519 group pubkey (same across all PWAs)
  initialized: boolean
  // All keypairs are derived from `masterSecret`; the store itself holds no keypair
  getSecretKey() / getSigningSecretKey() / getSigningPublicKey()
  rotateIdentity()  // Generates a new masterSecret → returns the old signing keys for tombstone purposes
  clearAll()        // Clears masterSecret
```

For the detailed threat model and key derivation see `docs/guidelines/sync-security.en.md`.

### Hook API (`useClaudeOperations.ts`)

```typescript
// Session operations
startSession(prompt, opts?)
resumeSession(sessionId, prompt, cwd?)
cancelSession(sessionId)
closeSession(sessionId)        // claude:close — kill process, keep registry entry
endSession(sessionId)          // claude:end-task — kill + archive
restoreSession(sessionId, cwd) // session:update-history { archived: false }

// History (the session list is provided by the `/sessions/history` + `/sessions/active`
// bus subscriptions; there is no corresponding command. For one-shot reads use
// `bus.getSnapshot('/sessions/history')`)
getSessionCards(sessionId, offset?, limit?, cwd?)

// Input/approval
respondToUserInput(response)
setSessionPermission(sessionId, permissionMode)
unsubscribeSession(sessionId)
```

### Component Hierarchy

```
App.tsx
└── ClaudePanel              # Single React component owning the session view + composer
    ├── SessionList          # (chat/SessionList.tsx) Session list with the New Session button
    ├── CardRenderer         # (chat/CardRenderer.tsx) Renders by card.type into one of:
    │   ├── UserMessage      #   chat/UserMessage.tsx        ('user')
    │   ├── AssistantMessage #   chat/AssistantMessage.tsx   ('assistant_text')
    │   ├── ThinkingMessage  #   chat/ThinkingMessage.tsx    ('thinking')
    │   ├── ToolCallMessage  #   chat/ToolCallMessage.tsx    ('tool_call', with result + pending input)
    │   ├── SubagentBlockMessage # chat/SubagentBlockMessage.tsx ('subagent')
    │   └── SystemMessage    #   chat/SystemMessage.tsx      ('system')
    └── (textarea + send)    # Inline composer inside ClaudePanel; not a separate component
```

---

## 七、IPC Protocol and Debug CLI

### IPC Architecture

The daemon exposes a JSON-RPC 2.0 API over a Unix domain socket; CLI clients connect and invoke methods.

```
CLI (index.ts)
  → IpcClient.connect(socketPath)
  → client.request('method', params)
  → IpcServer (ipcServer.ts)
    → registered method handler
  ← JSON-RPC response
```

### IPC Method Index

| Method | Purpose | Return Type |
|---|---|---|
| `hello` / `ping` / `status` | Built-in handshake / heartbeat / daemon status | `HelloResult` / `PingResult` / `StatusResult` |
| `get-agent-state` | Coarse pair state + identity snapshot (used by `quicksave status`) | `AgentStateResult` |
| `unlock-pairing` | Exit `closed` state and rotate keypair | `UnlockPairingResult` |
| `get-pairing-info` | QR code / pairing URL | `PairingInfoResult` |
| `list-repos` | Managed repos | `{ repos: RepoInfo[] }` |
| `add-repo` / `remove-repo` | Add/remove a repo | `{ added/removed: boolean }` |
| `subscribe-events` | Subscribe to peer connection events | — |
| `shutdown` / `restart` | Stop/restart the daemon | — |
| `debug` | Full internal state snapshot | `DebugResult` |
| `resolve-input` | Force-resolve a stuck permission request | `{ resolved: boolean }` |
| `list-sessions` | List CLI sessions (with live state) | `{ sessions: [...] }` |
| `get-cards` | Get a session's card history | `CardHistoryResponse` |

### Debug CLI Commands

> **Note:** debug commands are disabled by default in production builds; set `QUICKSAVE_DEBUG=1` to enable.
> They are enabled by default in dev mode.

| CLI Command | IPC Method | Purpose |
|---|---|---|
| `service debug` | `debug` | Peers, PubSub subscriptions, pending permissions, active sessions |
| `service sessions [--cwd]` | `list-sessions` | List of all sessions (JSONL + live state) |
| `service cards <id> [--cwd] [--limit]` | `get-cards` | Session card history + pending inputs |
| `service resolve <id> [--deny]` | `resolve-input` | Manually resolve a stuck permission |

### DebugResult Data Structure

```typescript
interface DebugResult {
  pid: number;
  uptime: number;
  peers: Array<{ address: string; connectedAt: number; topics: string[] }>;
  subscriptions: Record<string, string[]>;   // topic → peer addresses
  pendingInputs: Array<{ requestId: string; sessionId: string; toolName?: string; agentId?: string; inputType: string }>;
  activeSessions: Array<{ sessionId: string; cwd: string; isStreaming: boolean; hasPendingInput: boolean; permissionMode: string }>;
}
```

---

## 八、End-to-End Data Flow

```
User enters a prompt
  ↓ useClaudeOperations.startSession()
  ↓ bus.command('claude:start', payload, { queueWhileDisconnected: true })
  ↓ bus:frame { kind: 'cmd', verb: 'claude:start' } → [encrypt] → WebRTC → [decrypt]
  ↓ BusServerTransport → bus.onCommand('claude:start') (registered by wireLegacyBusVerbs)
  ↓ legacyBusAdapter wraps the payload back into a Message → MessageHandler.handleClaudeStart()
  ↓ SessionManager.startSession()
    ↓ ClaudeCodeProvider.startSession() → ClaudeCliProvider (or ClaudeSdkProvider per env)
      ↓ spawn('claude', ['--input-format', 'stream-json', '--output-format', 'stream-json',
      ↓                    '--permission-prompt-tool', 'stdio', '--append-system-prompt', '...', ...])
      ↓ stdin.write({ type: 'user', message: { role: 'user', content: prompt } })
      ↓ return { sessionId, session: ProviderSession }
    ↓ SessionManager registers ManagedSession + permission table + bypass-flag sentinel
    ↓ consumeStream() loop in the provider:
       for await (line of readline(proc.stdout))
         if control_request → callbacks.handlePermissionRequest → emit card → wait for user → sendControlResponse()
         else → routeMessage() → StreamCardBuilder → CardEvent → callbacks.emitCardEvent
  ↓ claudeService.on('card-event') → bus.publish('/sessions/:id/cards', { kind: 'card', event })
  ↓ bus:frame { kind: 'upd', path: '/sessions/.../cards' } → [encrypt] → WebRTC → [decrypt]
  ↓ MessageBusClient dispatch → applySessionCardsUpdate(sessionId, update)
  ↓ claudeStore.handleCardEvent() → React re-render → CardRenderer
  ↓ on 'result': turn complete, process stays alive for next stdin message
```

---

## 九、Key Design Patterns

| Pattern | Location | Purpose |
|---|---|---|
| EventEmitter | `SessionManager` | AI event broadcast |
| Strategy Pattern | `CodingAgentProvider` interface | Pluggable AI provider implementations |
| MessageBus (RPC + PubSub) | `packages/message-bus` + `busServerTransport` / `busClientTransport` | PWA↔Agent command / subscribe / publish |
| Snapshot-on-subscribe | `bus.onSubscribe(path, { snapshot })` | Auto-replays current state on disconnect-reconnect, eliminating the stale window |
| Command adapter | `handlers/legacyBusAdapter.ts — LEGACY_BUS_VERBS` + `wireLegacyBusVerbs` (called from `service/run.ts`) | Wraps every verb as a bus command, delegating to the existing `messageHandler.handleMessage` |
| Zustand Store | `claudeStore.ts` / `gitStore.ts` | Centralized PWA state |
| Singleton Lock | `singleton.ts` | Ensures a single daemon |
| JSONL Append | `sessionStore.ts` | Session history persistence |

---

## 十、Reference Documents

| Document | Description |
|---|---|
| `docs/references/claude-agent-sdk-message-types.en.md` | Reference for Claude CLI stream-json event types |
| `docs/plans/2026-04-10-codex-integration-plan.md` | Codex integration plan |
| `docs/guidelines/ui-design-rules.md` | PWA UI design rules |
