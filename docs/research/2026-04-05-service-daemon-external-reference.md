# Service Daemon External References

**Date:** 2026-04-05
**Status:** Reference

This document captures prior inspection notes from external projects that informed the `quicksave` service daemon design. It is reference material, not a product commitment.

## Inspected Versions

| Project | Repo | Version inspected | Notes |
|---------|------|-------------------|-------|
| VS Code Tunnel | `microsoft/vscode` | `ffa49fc36519` (2026-04-03) | Tunnel CLI and service management |
| Happy | `slopus/happy` | `17d773ee1254` (2026-04-03) | `packages/happy-cli/README.md` notes it migrated from `happy-coder` |

## VS Code Tunnel

### Key Source Locations

- `cli/src/singleton.rs:54-136`
  Singleton acquisition, lock file ownership, lockfile metadata, and client attach flow.
- `cli/src/commands/tunnels.rs:268-305`
  `code tunnel service install|uninstall|log|internal-run` command handling.
- `cli/src/tunnels/dev_tunnels.rs:947-1088`
  `ActiveTunnelManager::spawn_tunnel()` setup and reconnect loop.
- `cli/src/tunnels/dev_tunnels.rs:1235-1240`
  Active host detection via `host_connection_count`.
- `cli/src/tunnels/service_macos.rs:42-64,128-140`
  `launchd` registration and plist generation.
- `cli/src/tunnels/service_linux.rs:71-121,194-210`
  user `systemd` registration and service unit with restart policy.
- `cli/src/tunnels/service_windows.rs:51-84,91-110`
  per-user Windows auto-start registration and detached hidden process launch.

### Single Daemon / Single Server Connection

- Uses a singleton layer in `cli/src/singleton.rs`.
- Startup first tries to acquire an exclusive lock file.
- The winning process becomes the singleton server and writes runtime metadata including PID and socket path.
- A second `code tunnel` invocation does not become a second daemon. It reads the singleton metadata and talks to the existing process over local IPC.
- The actual dev tunnel host connection is managed in `cli/src/tunnels/dev_tunnels.rs` by `ActiveTunnelManager::spawn_tunnel()`.
- That manager owns one reconnecting relay connection for the tunnel host rather than spinning up duplicate primary connections.
- Tunnel metadata is also checked before takeover; if a named tunnel already has an active host connection, the CLI treats it as in use instead of attaching a second host.

### Auto-Start

- Auto-start is explicit OS service registration, not implicit backgrounding on every command.
- The CLI exposes `code tunnel service install`.
- macOS implementation writes a `launchd` plist with `KeepAlive=true`.
- Linux implementation writes a user `systemd` unit with `Restart=always`, then enables and starts it.
- Windows implementation registers a per-user auto-start entry and launches the background process detached.

### Session Process Management

- Not applicable in the Claude/Codex sense.
- VS Code Tunnel manages the code server and tunnel host lifecycle, but not per-request AI session workers.
- The useful pattern here is singleton + IPC + explicit service install, not AI runtime supervision.

### Takeaways for Quicksave

- Lock file plus local IPC is a strong singleton pattern for a machine agent.
- Only the daemon should own the primary signaling or tunnel connection.
- Optional OS login install should sit on top of a working daemon, not block the first release.

## Happy

### Key Source Locations

- `packages/happy-cli/src/persistence.ts:338-379`
  Exclusive daemon lock acquisition with stale-lock cleanup.
- `packages/happy-cli/src/daemon/run.ts:109-130`
  Daemon version check and lock acquisition.
- `packages/happy-cli/src/daemon/run.ts:156-196`
  Session webhook handling and PID-to-session tracking.
- `packages/happy-cli/src/daemon/run.ts:527-589`
  Daemon spawning detached Happy child processes for sessions and waiting for webhook completion.
- `packages/happy-cli/src/index.ts:534-562`
  `happy daemon start` spawning `happy daemon start-sync`.
- `packages/happy-cli/src/index.ts:772-788`
  Default on-demand daemon auto-start path for the main `happy` command.
- `packages/happy-cli/src/utils/spawnHappyCLI.ts:70-107`
  Cross-platform `spawnHappyCLI()` implementation that directly launches `dist/index.mjs`.
- `packages/happy-cli/src/claude/runClaude.ts:174-177,275-294`
  Session self-report to daemon plus hook server and temporary hook settings creation.
- `packages/happy-cli/src/claude/utils/generateHookSettings.ts:20-49`
  Temporary settings file with Claude `SessionStart` hook.
- `packages/happy-cli/src/claude/utils/startHookServer.ts:94-135`
  Local HTTP hook receiver for `/hook/session-start`.
- `packages/happy-cli/src/claude/claudeLocal.ts:185-297`
  Local Claude launcher spawn path.
- `packages/happy-cli/src/claude/claudeRemote.ts:158-213`
  Remote Claude SDK `query()` path and session ID detection.
- `scripts/claude_local_launcher.cjs`
  Direct `import()` of Claude Code's `cli.js`; monkey-patches `global.fetch` to emit thinking-state events on fd 3.
- `scripts/claude_version_utils.cjs`
  Resolves Claude CLI path from npm global, Homebrew, or native installer.
- `scripts/session_hook_forwarder.cjs`
  Reads hook payload from stdin and POSTs to Happy's local hook server for session ID discovery.
- `scripts/claude_remote_launcher.cjs`
  Thin wrapper for remote mode; imports `cli.js` via `claude_version_utils.cjs`. Referenced by SDK's `pathToClaudeCodeExecutable`.
- Compiled: `dist/index-B3gQr6vs.mjs:1523-1647` — `PushableAsyncIterable` class.
- Compiled: `dist/index-B3gQr6vs.mjs:1662-1813` — `claudeRemote()` function (SDK query, multi-turn loop, stream consumption).
- Compiled: `dist/index-B3gQr6vs.mjs:1886-2186` — `PermissionHandler` class (canCallTool callback, RPC handler, tool allowlists).
- Compiled: `dist/index-B3gQr6vs.mjs:2308-2523` — `SDKToLogConverter` class (SDK messages → Happy log format with UUID chains).
- Compiled: `dist/index-B3gQr6vs.mjs:2525-2660` — `OutgoingMessageQueue` class (ordered, delayed message delivery to PWA).
- Compiled: `dist/index-B3gQr6vs.mjs:2662-2995` — `claudeRemoteLauncher()` (outer session loop, abort handling, permission wiring, message pipeline).

### Single Daemon / Server Connection

- Uses state and lock files under `~/.happy`, including `daemon.state.json` and `daemon.lock`.
- Lock acquisition uses `O_CREAT | O_EXCL`; stale locks are cleaned up by checking whether the recorded PID still exists.
- `packages/happy-cli/src/daemon/run.ts` compares the current CLI version with the stored daemon version and exits early if the same daemon is already active.
- The daemon heartbeat also re-checks state ownership; if the state file no longer belongs to the current PID, the daemon exits.
- Local control traffic uses a localhost HTTP control server rather than a Unix socket singleton.
- This guarantees one daemon control plane, but not one total upstream connection.
- Each Claude or Codex session can still establish its own session-scoped sync connection to Happy's backend.

### Auto-Start

- Default behavior is on-demand auto-start.
- Normal commands such as `happy`, `happy claude`, and `happy acp ...` first check whether the daemon exists.
- If not, the CLI spawns `happy daemon start-sync` as a detached background process and then talks to it.
- The repo also contains a macOS `launchd` installer path, but the code comments mark it as not currently used.

### Claude Session Process Management

- The daemon acts as a session supervisor rather than running all Claude work inline.
- There are two spawn layers:
- Layer 1: the daemon spawns a detached Happy CLI child with `spawnHappyCLI(args, { detached: true, stdio: 'ignore' })`.
- `spawnHappyCLI()` does not shell out to the `happy` wrapper. It directly runs `node --no-warnings --no-deprecation dist/index.mjs ...args`.
- When the backend requests a new session, this daemon-spawned Happy child is the process whose PID gets tracked first.
- The daemon attaches `exit` and `error` handlers and waits for a `/session-started` callback before treating spawn as successful.
- Session stop uses tracked PID and session ID. Daemon-spawned sessions are terminated directly; externally started sessions can also be killed by PID.
- `runClaude()` creates Happy-side session metadata such as `hostPid`, `startedBy`, and `flavor`, then establishes a session-scoped sync bridge.
- This means Happy has one daemon plus multiple session-level backend connections.
- Claude session identity is not guessed by the daemon. Happy starts a local hook server and injects a temporary Claude settings file so the Claude `SessionStart` hook reports the real upstream session ID back to the current Happy process.
- Layer 2 depends on Claude mode:
- In local mode, Happy builds Claude CLI args such as `--resume`, `--append-system-prompt`, optional MCP/tool flags, and `--settings <hook-settings-path>`, then spawns `node <claude_local_launcher.cjs> ...args`.
- That launcher is a wrapper around the Claude CLI and also exposes extra side-channel output for Happy's thinking-state tracking.
- In remote mode, Happy does not use the official `@anthropic-ai/claude-agent-sdk`. It has its own `query()` function and `Query` class that spawn the Claude CLI as a subprocess with `--output-format stream-json --input-format stream-json --permission-prompt-tool stdio`, then drive the session via stdin/stdout JSON protocol.
- In remote mode it still passes the temporary hook settings path via `--settings` so Claude session identity can be discovered and persisted.
- Session lifecycle logic is separated from the daemon entrypoint into dedicated loop and session objects.

### Claude Integration: Local Mode

Local mode imports the Claude Code CLI directly rather than spawning it as a separate binary.

**Launcher architecture:**

- `scripts/claude_local_launcher.cjs` resolves the Claude CLI path using `scripts/claude_version_utils.cjs`, which searches npm global (`node_modules/@anthropic-ai/claude-code/cli.js`), Homebrew, or native installer paths in order.
- The launcher calls `import(pathToFileURL(cliPath))` to load `cli.js` in-process. This is not a documented integration method.
- Before importing, it monkey-patches `global.fetch` to write `fetch-start` and `fetch-end` events to file descriptor 3 (a side-channel pipe) so the parent can track thinking state.

**Process spawning:**

- The Happy child spawns the launcher via `child_process.spawn("node", ["claude_local_launcher.cjs", ...args])`.
- stdio is `["inherit", "inherit", "inherit", "pipe"]` — stdin/stdout/stderr inherited, fd 3 is a pipe for thinking-state events.
- CLI arguments include: `--resume <sessionId>`, `--append-system-prompt <text>`, `--mcp-config <path>`, `--allowedTools <tools>`, `--settings <hook-settings-path>`.

**Multi-turn handling:**

- Local mode uses a while-loop that re-spawns the Claude process for each conversation turn.
- After the first turn, `consumeOneTimeFlags()` strips `--resume` and `--continue` from the argument list so subsequent turns do not re-apply them.
- Each iteration waits for the child process to exit before deciding whether to spawn the next turn.

**Thinking-state tracking:**

- The fd 3 pipe receives newline-delimited JSON: `{"type":"fetch-start","id":"<uuid>"}` and `{"type":"fetch-end","id":"<uuid>"}`.
- The parent maintains a `Map` of active fetch IDs. When the map is non-empty, thinking is `true`.
- After the last `fetch-end` clears the map, the parent waits 500ms before setting thinking to `false` (debounce against rapid sequential fetches).

### Claude Integration: Remote Mode

Remote mode does **not** use the official `@anthropic-ai/claude-agent-sdk`. Happy has its own `query()` function and `Query` class that spawn the Claude CLI as a subprocess and communicate via stdin/stdout JSON protocol. This is the mode most relevant to Quicksave's PWA-based architecture.

**Launcher:**

- `scripts/claude_remote_launcher.cjs` is a thin wrapper that imports `cli.js` via `claude_version_utils.cjs` (same as local mode).
- Happy's `query()` function uses `pathToClaudeCodeExecutable` to spawn this launcher.

**Happy's custom `query()` function:**

- Located at compiled `dist/index-B3gQr6vs.mjs:1354-1461`.
- Builds CLI args: `--output-format stream-json --verbose`, plus optional `--input-format stream-json`, `--permission-prompt-tool stdio`, `--resume`, `--model`, `--permission-mode`, `--settings`, `--allowedTools`, `--disallowedTools`, etc.
- Spawns: `child_process.spawn(executable, [pathToClaudeCodeExecutable, ...args], { stdio: ["pipe", "pipe", "pipe"] })`.
- If prompt is a string: uses `--print <prompt>` and closes stdin.
- If prompt is an `AsyncIterable`: uses `--input-format stream-json` and streams messages to stdin via `streamToStdin()` (JSON + newline per message).
- Returns a `Query` instance (not the official SDK's `Query`).

**Happy's `Query` class:**

- Located at compiled `dist/index-B3gQr6vs.mjs:1162-1353`.
- Reads newline-delimited JSON from Claude's stdout via `readline`.
- Filters out `control_response` and `control_request` messages from the stream; all other messages are yielded as SDK-compatible events.
- Handles `control_request` with subtype `can_use_tool` by calling the `canCallTool` callback and writing a `control_response` back to stdin.
- Handles `control_cancel_request` by aborting pending permission requests.
- **Only supports `can_use_tool` subtype** — all other control request subtypes throw `Error("Unsupported control request subtype")`.
- Implements `interrupt()` by writing a `control_request` with `subtype: "interrupt"` to stdin.
- Implements `AsyncIterableIterator` so callers can `for await (const message of query)`.

**`claudeRemote()` invocation:**

- Calls Happy's own `query({ prompt: messages, options: sdkOptions })`.
- `prompt` is always a `PushableAsyncIterable` (never a plain string), even for the first turn.
- The first user message is pushed into the iterable before calling `query()`.
- Key SDK options passed:
  - `cwd`: workspace path
  - `resume`: session ID to resume (if any; validated by `claudeCheckSession()` first)
  - `mcpServers`: MCP server configurations
  - `permissionMode`: `"plan"` or `"default"` (never `"bypassPermissions"` — permissions are user-controlled)
  - `model`, `fallbackModel`: model selection
  - `appendSystemPrompt`: Happy's system prompt appended to user's custom prompt
  - `allowedTools`: merged from session and user-configured tools
  - `canCallTool`: callback → `PermissionHandler.handleToolCall()`
  - `abort`: `AbortController.signal`
  - `pathToClaudeCodeExecutable`: path to `claude_remote_launcher.cjs`
  - `settingsPath`: path to temporary hook settings file

**`PushableAsyncIterable` implementation:**

- Single-consumer async iterable with a queue and waiter list.
- `push(value)` — if a consumer is waiting (`this.waiters`), resolves its promise immediately; otherwise enqueues the value.
- `next()` — if the queue is non-empty, shifts and returns; if done, returns `{ done: true }`; otherwise creates a promise and adds to `this.waiters`.
- `end()` — marks done and resolves all waiting consumers with `{ done: true }`.
- `setError(err)` — marks done and rejects all waiting consumers.
- Enforces single iteration: `[Symbol.asyncIterator]()` throws if called a second time.
- Also implements `return()` (calls `end()`) and `throw(e)` (calls `setError()`).

**Multi-turn flow:**

- The `for await (const message of response)` loop processes SDK messages.
- When a `result` message arrives (turn complete):
  1. Calls `opts.onReady()` — notifies the PWA that Claude is idle and waiting.
  2. Calls `await opts.nextMessage()` — suspends until the user sends the next message.
  3. If `nextMessage()` returns `null`, calls `messages.end()` and returns (session over).
  4. If the next message's mode hash differs from the current one (e.g., model or permission change), the message is stored as `pending` and `null` is returned — this causes the current `claudeRemote()` invocation to exit, and `claudeRemoteLauncher()` re-invokes it with fresh SDK options.
  5. Otherwise, pushes `{ type: "user", message: { role: "user", content: next.message } }` into the `PushableAsyncIterable`.
  6. The SDK sees the new value from the iterable and starts the next turn without a new `query()` call.

**`nextMessage()` callback (in `claudeRemoteLauncher`):**

- Delegates to `session.queue.waitForMessagesAndGetAsString(signal)` — an async wait on a message queue fed by the PWA via the Happy backend.
- The queue carries messages with `{ message, mode, hash, isolate }`.
- `hash` is a mode fingerprint; if it changes, the caller knows SDK options must be re-created.
- `isolate` flag forces a new `claudeRemote()` invocation even without mode change.

**Permission handling via `canCallTool` callback:**

- Happy's `query()` function passes `--permission-prompt-tool stdio` to the Claude CLI, causing Claude to emit `control_request` JSON on stdout for tool approvals.
- Happy's `Query` class intercepts these `control_request` messages and calls the `canCallTool` callback internally, then writes the `control_response` back to stdin.
- From the caller's perspective (`claudeRemote()`), this looks like an in-process callback, but underneath it's stdin/stdout IPC with the Claude CLI subprocess.
- `PermissionHandler.handleToolCall(toolName, input, mode, options)` is the callback:
  1. Checks if the tool is already in the allowed set (remembered from prior approvals).
  2. For `Bash`, checks allowed literal commands and prefix patterns (e.g., `Bash(npm:*)` allows `npm install`, `npm test`, etc.).
  3. If `permissionMode === "bypassPermissions"`, auto-allows.
  4. If `permissionMode === "acceptEdits"` and the tool is an edit tool, auto-allows.
  5. Otherwise, creates a `Promise` stored in `pendingRequests` keyed by tool call ID.
  6. Sends a push notification to all devices: `"Claude wants to ${getToolName(toolName)}"`.
  7. Updates `agentState.requests` so the PWA can render the permission prompt.
  8. Returns the promise — the SDK blocks tool execution until resolved.
- `PermissionHandler.setupClientHandler()` registers an RPC handler for `"permission"` messages from the PWA.
- When the user approves/denies in the PWA:
  1. The PWA sends an RPC `{ id, approved, reason?, mode?, allowTools? }`.
  2. The handler resolves the pending promise with `{ behavior: "allow" }` or `{ behavior: "deny", message }`.
  3. If `allowTools` is provided, those tools are added to the remembered allowed set for the session.
  4. If `mode` is provided (e.g., user switches to `acceptEdits`), the permission mode updates.
  5. `agentState` is updated: request moves from `requests` to `completedRequests`.

**ExitPlanMode special handling:**

- When Claude calls `ExitPlanMode`, the tool call is intercepted by the permission handler.
- If the user approves the plan, the handler does **not** resolve with `allow`. Instead:
  1. It injects `PLAN_FAKE_RESTART` ("PlEaZe Continue with plan.") into `session.queue.unshift()`.
  2. It resolves with `{ behavior: "deny", message: PLAN_FAKE_REJECT }` — a fake rejection that tells Claude to stop.
  3. The `PLAN_FAKE_REJECT` message in the `user` tool_result is later rewritten to `"Plan approved"` by `onMessage()` before reaching the log converter.
  4. The injected `PLAN_FAKE_RESTART` becomes the next user message, which re-enters Claude with the updated permission mode.
- This hack is necessary because `ExitPlanMode` needs to change the SDK's `permissionMode` mid-session, which requires re-creating the `query()` call.

**SDK message → PWA message pipeline:**

- `onMessage(message)` in `claudeRemoteLauncher` receives every SDK message.
- `SDKToLogConverter.convert(message)` transforms SDK messages into Happy's log format with UUID chains:
  - Assigns a `uuid` and links to `parentUuid` (previous message in the chain).
  - Tracks sidechain messages (sub-agent) separately via `parent_tool_use_id` → `sidechainLastUUID` map.
  - Copies `type`, `message`, `requestId` and context fields (`cwd`, `sessionId`, `version`, `gitBranch`).
  - `result` messages are not converted (they are handled by the loop).
- `OutgoingMessageQueue` orders and sends converted messages to the PWA:
  - Messages are enqueued with an incrementing ID for ordering.
  - `assistant` messages containing `tool_use` blocks are **delayed 250ms** to allow tool results to arrive and be grouped.
  - When a `tool_result` message arrives for a delayed tool call, `releaseToolCall(id)` fires it immediately.
  - The queue processes items in strict ID order — a delayed message blocks all subsequent messages until released.
  - `sendFunction` is `session.client.sendClaudeSessionMessage(logMessage)`.

**Ongoing tool call tracking and cleanup:**

- `ongoingToolCalls` is a `Map<toolCallId, { parentToolCallId }>` tracking in-flight tool calls.
- On `assistant` messages: tool_use blocks are added to the map.
- On `user` messages: tool_result blocks remove from the map.
- On session exit (finally block): all remaining `ongoingToolCalls` are terminated by generating `generateInterruptedToolResult()` messages with `is_error: true` and `"[Request interrupted by user for tool use]"`.
- This ensures the PWA always sees a tool result for every tool use, even on abort.

**Session ID discovery:**

- When `system:init` arrives with `session_id`, Happy calls `awaitFileExist()` to poll until the JSONL file appears on disk (up to 10s, polling every 1s).
- Only then calls `opts.onSessionFound(sessionId)` to update the session ID in the converter and notify the parent.

**Thinking state (remote mode):**

- Remote mode does not use fd 3. Instead it tracks thinking state by message types:
  - Set `thinking = true` when `system:init` arrives or when starting a new query.
  - Set `thinking = false` when `result` arrives.
  - The `updateThinking()` callback propagates to `opts.onThinkingChange`.

**Error handling:**

- If `claudeRemote()` throws (non-abort), `claudeRemoteLauncher` catches it, sends `"Process exited unexpectedly"` to the PWA, and `continue`s the while loop (re-invokes `claudeRemote()`).
- If the abort signal fires, `claudeRemote()` catches `AbortError` and returns cleanly.

**Mode switching (remote ↔ local):**

- `claudeRemoteLauncher` returns an `exitReason`: `"exit"` (quit) or `"switch"` (to local mode).
- The outer `loop()` function alternates between `claudeLocalLauncher(session)` and `claudeRemoteLauncher(session)` based on the returned reason.
- The user can trigger a switch via double-space in the TTY UI, or via an RPC `"switch"` command from the PWA.

### Session ID Discovery

Claude assigns a session ID internally. Happy needs to learn this ID to persist session metadata and support resume.

**Hook settings file generation:**

- `generateHookSettingsFile()` writes a temporary JSON file at `~/.happy/tmp/hooks/session-hook-<PID>.json`.
- The file contains a Claude settings override: `hooks.SessionStart[0].hooks[0].command = "node <session_hook_forwarder.cjs> <port>"`.
- This file is passed to Claude via `--settings <path>` so Claude executes the hook when the session starts.

**Hook server:**

- `startHookServer()` opens a localhost HTTP server on a random available port.
- It listens for `POST /hook/session-start` with a JSON body containing `session_id`.
- When the POST arrives, the `onSessionHook(sessionId)` callback fires, giving Happy the real Claude session ID.

**Hook forwarder:**

- `scripts/session_hook_forwarder.cjs` is the bridge between Claude's hook execution and Happy's HTTP server.
- Claude invokes the forwarder as a subprocess. The forwarder reads the hook payload from stdin and POSTs it to `http://localhost:<port>/hook/session-start`.
- This indirection is necessary because Claude hooks are shell commands, not HTTP calls.

### Cancellation

- Both local and remote modes use an `AbortController`.
- The abort signal is passed to the spawn call (local) or SDK query (remote).
- In local mode, cancellation also sends an explicit `child.kill("SIGTERM")` to the Claude process.
- The abort controller is triggered when the user cancels, the daemon requests session stop, or a timeout fires.

### Daemon Update and Session Survival

**Version check on startup:**

- `isDaemonRunningCurrentlyInstalledHappyVersion()` compares `daemon.state.json`'s `startedWithCliVersion` against the current `package.json` version.
- If versions differ, the new CLI calls `stopDaemon()` (HTTP POST `/stop` → graceful; fallback to `SIGKILL`) then starts a fresh daemon.
- If versions match, exits with `"Daemon already running with matching version"`.

**Heartbeat-based self-restart:**

- The running daemon checks its own version every 60s (configurable) against the installed `package.json`.
- If the installed version has changed (e.g., `npm update`), the daemon spawns `happy daemon start` as a detached process and then hangs for 10s before calling `process.exit(0)`.
- The newly spawned daemon start process will see the version mismatch and kill the old daemon via `stopDaemon()`.

**Sessions survive daemon restart:**

- Session child processes are spawned with `detached: true` and `stdio: ["ignore", "pipe", "pipe"]`.
- The `detached: true` flag means session processes are not killed when the daemon exits.
- The help text confirms: `"happy daemon stop — Stop the daemon (sessions stay alive)"`.
- However, after daemon restart, the new daemon has **no knowledge of pre-existing sessions**. The `pidToTrackedSession` map starts empty.
- `listDaemonSessions()` warns: `"No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)"`.
- Externally-started sessions (including survivors from a previous daemon) can still self-report via the session webhook (`/session-started` POST to control server), but only if they happen to trigger a webhook again.

**Daemon shutdown cleanup:**

- On shutdown: updates remote state to `"shutting-down"`, stops control server, cleans up state file, releases lock, stops caffeinate.
- Does **not** kill child session processes.
- Ongoing tool calls in remote sessions are not gracefully terminated — the daemon simply exits and detached sessions keep running independently.

**Implications for Quicksave:**

- Happy's model of "sessions survive daemon restart" is achievable because sessions are detached processes.
- But the new daemon loses all in-memory tracking — it cannot manage, cancel, or communicate with survivor sessions.
- If Quicksave wants true session continuity across daemon restarts, session processes need a way to re-register with the new daemon (e.g., polling a known socket path, or writing their own PID/state to a file that the new daemon scans on startup).

### Takeaways for Quicksave

- On-demand auto-start is the best default for a CLI-first agent.
- A daemon should supervise sessions, not embed every long-lived AI runtime inside the foreground command process.
- Persist session metadata before or during spawn so crashes can be represented as `interrupted` rather than disappearing.
- If the upstream provider has its own session identity, plan for an explicit mechanism to learn and persist that ID.
- "Single daemon" does not necessarily mean "one upstream connection total" once concurrent AI sessions exist.
- If Quicksave supports both local CLI-backed and SDK-backed Claude execution paths, document those two paths separately because their lifecycle and kill semantics differ.
- Happy's remote mode is **not** using the official Agent SDK — it has a custom CLI wrapper. This means Quicksave's use of the official SDK is actually a different (and more officially supported) integration path.
- Happy's `canCallTool` only handles `can_use_tool` requests and loses `suggestions`, `blockedPath`, `decisionReason` metadata. Quicksave should use the official SDK's richer `canUseTool` callback.
- Detached session processes that survive daemon restart is the right pattern, but the re-registration problem must be solved for proper lifecycle management.

## Comparison

| Concern | VS Code Tunnel | Happy | Suggested direction for Quicksave |
|---------|----------------|-------|-----------------------------------|
| Singleton | Lock file + IPC socket | Lock file + state file + localhost control server | Lock file + local IPC socket or pipe |
| Default startup | Manual command unless installed as service | On-demand auto-start | On-demand auto-start first |
| OS auto-start | First-class `service install` | Present but not primary path | Add later, after daemon API stabilizes |
| Primary connection ownership | One tunnel host per daemon | One daemon control plane, plus per-session sync links | One signaling connection owned by daemon |
| AI session model | Not applicable | Supervisor + detached worker/session runtime | Supervisor + worker model for Claude if session scope becomes long-lived |
| Multi-turn | Not applicable | Local: re-spawn loop; Remote: `PushableAsyncIterable` over single `query()` | Per-turn new CLI process (documented approach) |
| Session ID discovery | Not applicable | SessionStart hook → local HTTP server → forwarder POST | Not needed if SDK `query()` returns session ID directly |
| Cancellation | Not applicable | AbortController + SIGTERM (local); AbortController (remote) | AbortController + process kill for CLI backend |
| Permission model | Not applicable | `--permission-prompt-tool stdio` control_request/response JSON | Bypass permissions (trusted daemon) or replicate stdio protocol |
| SDK usage | Not applicable | Custom `query()`/`Query` class wrapping CLI subprocess (not official SDK) | Official `@anthropic-ai/claude-agent-sdk` |
| Daemon update | Not applicable | Kill old daemon, start new; sessions survive (detached) but lose tracking | TBD — session re-registration on daemon restart |

## Notes for Quicksave

- The strongest reusable pattern from VS Code Tunnel is singleton enforcement.
- The strongest reusable pattern from Happy is daemon-supervised session lifecycle.
- Quicksave does not need to copy either project literally.
- The likely hybrid is:
  - VS Code-style lock + local IPC for the machine daemon
  - Happy-style session supervisor if Claude work becomes a true long-lived background concern
