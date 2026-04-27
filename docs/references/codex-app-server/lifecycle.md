# Codex `app-server` — connection & thread lifecycle

> **Source(s):** https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (§ Lifecycle Overview, § Initialization, § API Overview, § Example: Start or resume a thread, § Example: List threads, § Example: Track thread status changes, § Example: Unsubscribe from a loaded thread, § Example: Read a thread, § Example: Archive a thread, § Example: Trigger thread compaction, § Example: Inject raw history items); locally-generated `v2/InitializeParams.ts`, `v2/InitializeResponse.ts`, `v2/InitializeCapabilities.ts`, `v2/ClientInfo.ts`, `v2/ThreadStartParams.ts`, `v2/ThreadResumeParams.ts`, `v2/ThreadStartSource.ts` (CLI 0.125.0).
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

This doc covers everything between "open the transport" and "send the first turn." For per-turn semantics see [`turns.md`](./turns.md). For approval round-trips see [`approvals.md`](./approvals.md).

## Connection lifecycle (high level)

From the README:

> - **Initialize once per connection**: Immediately after opening a transport connection, send an `initialize` request with your client metadata, then emit an `initialized` notification. Any other request on that connection before this handshake gets rejected.
> - **Start (or resume) a thread**: Call `thread/start` to open a fresh conversation. The response returns the thread object and you'll also get a `thread/started` notification. If you're continuing an existing conversation, call `thread/resume` with its ID instead. If you want to branch from an existing conversation, call `thread/fork` to create a new thread id with copied history.
> - **Begin a turn**: To send user input, call `turn/start` with the target `threadId` and the user's input. … This immediately returns the new turn object. The app-server emits `turn/started` when that turn actually begins running.
> - **Stream events**: After `turn/start`, keep reading JSON-RPC notifications on stdout. You'll see `item/started`, `item/completed`, deltas like `item/agentMessage/delta`, tool progress, etc.
> - **Finish the turn**: When the model is done (or the turn is interrupted via making the `turn/interrupt` call), the server sends `turn/completed` with the final turn state and token usage.
>
> — `codex-rs/app-server/README.md` § Lifecycle Overview

Concretely:

```
┌──────────────────┐       ┌────────────────────┐
│ open stdio pipe  │──────▶│ initialize request │ (id=0, must be first)
└──────────────────┘       └────────────────────┘
                                     │
                                     ▼
                           ┌────────────────────┐
                           │ initialized notif. │ (no id, ack)
                           └────────────────────┘
                                     │
                                     ▼
                           thread/start  │ thread/resume  │ thread/fork
                                     │
                                     ▼
                           turn/start ─▶ stream item/* notifications
                                     ▼
                           turn/completed
```

## `initialize` — handshake

### Request

```json
{
  "method": "initialize",
  "id": 0,
  "params": {
    "clientInfo": {
      "name": "codex_vscode",
      "title": "Codex VS Code Extension",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": false,
      "optOutNotificationMethods": ["item/agentMessage/delta"]
    }
  }
}
```

### `InitializeParams` (verbatim from `v2/InitializeParams.ts`)

```ts
export type InitializeParams = {
  clientInfo: ClientInfo,
  capabilities: InitializeCapabilities | null,
};
```

### `ClientInfo` (verbatim from `v2/ClientInfo.ts`)

```ts
export type ClientInfo = {
  name: string,
  title: string | null,
  version: string,
};
```

> **Important**: `clientInfo.name` is used to identify the client for the OpenAI Compliance Logs Platform. If you are developing a new Codex integration that is intended for enterprise use, please contact us to get it added to a known clients list. For more context: https://chatgpt.com/admin/api-reference#tag/Logs:-Codex
>
> — `codex-rs/app-server/README.md` § Initialization

For Quicksave we should pick a stable, descriptive `name` (e.g. `quicksave`) and bump `version` per release.

### `InitializeCapabilities` (verbatim from `v2/InitializeCapabilities.ts`)

```ts
/** Client-declared capabilities negotiated during initialize. */
export type InitializeCapabilities = {
  /** Opt into receiving experimental API methods and fields. */
  experimentalApi: boolean,
  /**
   * Exact notification method names that should be suppressed for this
   * connection (for example `thread/started`).
   */
  optOutNotificationMethods?: Array<string> | null,
};
```

`optOutNotificationMethods` is **exact-match** — `thread/*` does not work as a glob. Unknown method names are silently accepted. This is per-connection only.

### `InitializeResponse` (verbatim from `v2/InitializeResponse.ts`)

```ts
export type InitializeResponse = {
  userAgent: string,
  /** Absolute path to the server's $CODEX_HOME directory. */
  codexHome: AbsolutePathBuf,
  /** Platform family for the running app-server target, for example
   *  `"unix"` or `"windows"`. */
  platformFamily: string,
  /** Operating system for the running app-server target, for example
   *  `"macos"`, `"linux"`, or `"windows"`. */
  platformOs: string,
};
```

After receiving the response, the client **must** also send the `initialized` notification:

```json
{ "method": "initialized", "params": {} }
```

The README warns:

> Subsequent requests issued before initialization receive a `"Not initialized"` error, and repeated `initialize` calls on the same connection receive an `"Already initialized"` error.

## `thread/start`

### Wire example (verbatim from § Example: Start or resume a thread)

```json
{ "method": "thread/start", "id": 10, "params": {
    "model": "gpt-5.1-codex",
    "cwd": "/Users/me/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite",
    "personality": "friendly",
    "serviceName": "my_app_server_client",
    "sessionStartSource": "startup"
} }
{ "id": 10, "result": {
    "thread": {
        "id": "thr_123",
        "preview": "",
        "modelProvider": "openai",
        "createdAt": 1730910000
    }
} }
{ "method": "thread/started", "params": { "thread": { … } } }
```

### `ThreadStartParams` field reference (from `v2/ThreadStartParams.ts`)

```ts
export type ThreadStartParams = {
  model?: string | null,
  modelProvider?: string | null,
  serviceTier?: ServiceTier | null | null,           // "fast" | "flex"
  cwd?: string | null,
  approvalPolicy?: AskForApproval | null,            // see approvals.md
  /** Override where approval requests are routed for review on this thread
   *  and subsequent turns. */
  approvalsReviewer?: ApprovalsReviewer | null,      // "user" | "auto_review" | "guardian_subagent"
  sandbox?: SandboxMode | null,                      // "read-only" | "workspace-write" | "danger-full-access"
  /** Full permissions override for this thread. Cannot be combined with `sandbox`. */
  permissionProfile?: PermissionProfile | null,
  config?: { [key in string]?: JsonValue } | null,
  serviceName?: string | null,
  baseInstructions?: string | null,
  developerInstructions?: string | null,
  personality?: Personality | null,                  // "none" | "friendly" | "pragmatic"
  ephemeral?: boolean | null,
  sessionStartSource?: ThreadStartSource | null,     // "startup" | "clear"
  /** If true, opt into emitting raw Responses API items on the event stream.
   *  This is for internal use only (e.g. Codex Cloud). */
  experimentalRawEvents: boolean,
  /** If true, persist additional rollout EventMsg variants required to
   *  reconstruct a richer thread history on resume/fork/read. */
  persistExtendedHistory: boolean,
};
```

Field notes from the README:

- `cwd` + `workspace-write` (or full access) sandbox auto-marks that project as trusted in `~/.codex/config.toml`.
- `sandbox` is a "shorthand" string mode (`"read-only" | "workspace-write" | "danger-full-access"`) and **cannot be combined** with `permissionProfile`. Prefer `permissionProfile` for full control. See [`approvals.md`](./approvals.md).
- `personality` accepts `"friendly"`, `"pragmatic"`, or `"none"`. `"none"` substitutes the placeholder with an empty string.
- `serviceName` is an optional metrics tag (`service_name`).
- `sessionStartSource: "clear"` is for replacement threads after the user clears their session — `SessionStart` hooks then receive `source: "clear"` instead of the default `"startup"`.
- `ephemeral: true` keeps the thread in memory only; `thread.path` will be `null`.
- The README also documents a turn-scoped `dynamicTools` array on `thread/start`, but this requires `experimentalApi`.
- `experimentalRawEvents` is for internal Codex Cloud use; do not toggle.
- `persistExtendedHistory` is experimental — required for non-lossy `thread/read` / `thread/resume` / `thread/fork` history but does not backfill events that were not persisted at start time.
- An experimental `environments` array is also accepted on `thread/start` (sticky for the thread); omit to use server default, pass `[]` to disable, pass explicit env ids with per-environment `cwd`. Field-level experimental gate.

## `thread/resume`

Three modes — by id, by history, by path — with this precedence (from `v2/ThreadResumeParams.ts` doc-comment):

> There are three ways to resume a thread:
>
> 1. By thread_id: load the thread from disk by thread_id and resume it.
> 2. By history: instantiate the thread from memory and resume it.
> 3. By path: load the thread from disk by path and resume it.
>
> **The precedence is: history > path > thread_id.** If using history or path, the thread_id param will be ignored.
>
> **Prefer using thread_id whenever possible.**

### `ThreadResumeParams` field reference

```ts
export type ThreadResumeParams = {
  threadId: string,
  /** [UNSTABLE] FOR CODEX CLOUD - DO NOT USE.
   *  If specified, the thread will be resumed with the provided history
   *  instead of loaded from disk. */
  history?: Array<ResponseItem> | null,
  /** [UNSTABLE] Specify the rollout path to resume from.
   *  If specified, the thread_id param will be ignored. */
  path?: string | null,
  /** Configuration overrides for the resumed thread, if any. */
  model?: string | null,
  modelProvider?: string | null,
  serviceTier?: ServiceTier | null | null,
  cwd?: string | null,
  approvalPolicy?: AskForApproval | null,
  /** Override where approval requests are routed for review on this thread
   *  and subsequent turns. */
  approvalsReviewer?: ApprovalsReviewer | null,
  sandbox?: SandboxMode | null,
  /** Full permissions override for the resumed thread. Cannot be combined
   *  with `sandbox`. */
  permissionProfile?: PermissionProfile | null,
  config?: { [key in string]?: JsonValue } | null,
  baseInstructions?: string | null,
  developerInstructions?: string | null,
  personality?: Personality | null,
  /** When true, return only thread metadata and live-resume state without
   *  populating `thread.turns`. This is useful when the client plans to call
   *  `thread/turns/list` immediately after resuming. */
  excludeTurns?: boolean,
  /** If true, persist additional rollout EventMsg variants required to
   *  reconstruct a richer thread history on subsequent resume/fork/read. */
  persistExtendedHistory: boolean,
};
```

Behavior notes from the README:

- By default the response inflates `thread.turns` from the rollout. Pass `excludeTurns: true` if you'll page history via `thread/turns/list`. In that mode the server also skips replaying restored `thread/tokenUsage/updated`.
- When the stored session has persisted token usage, the server emits `thread/tokenUsage/updated` immediately after the response so clients can render restored usage before the next turn starts.
- By default, resume uses the latest persisted `model` and `reasoningEffort` for the thread. **Supplying any of `model`, `modelProvider`, `config.model`, or `config.model_reasoning_effort` disables that persisted fallback** — explicit overrides plus normal config resolution take over.
- Both `history` and `path` are flagged `[UNSTABLE]`. Stick to `threadId` resumption.

For Quicksave's "I want to keep going on yesterday's conversation" use case, the right call is:

```json
{ "method": "thread/resume", "id": 11, "params": {
    "threadId": "thr_123",
    "personality": "friendly"
} }
```

## `thread/fork`

Branch from an existing thread into a new id by copying stored history. Differences from resume:

- Returns a new `thread.id`; `thread.forkedFromId` points at the source.
- If the source thread is mid-turn, the fork records the same interruption marker as `turn/interrupt` rather than inheriting an unmarked partial-turn suffix.
- Supports `ephemeral: true` for an in-memory temporary fork.
- Supports `excludeTurns: true` (same semantics as `thread/resume`).
- Accepts the same permission override rules as `thread/start`.

```json
{ "method": "thread/fork", "id": 12, "params": { "threadId": "thr_123", "ephemeral": true } }
{ "id": 12, "result": { "thread": { "id": "thr_456", … } } }
{ "method": "thread/started", "params": { "thread": { … } } }
```

## `thread/list`

Page stored rollouts. Default sort is `created_at` desc.

```json
{ "method": "thread/list", "id": 20, "params": {
    "cursor": null,
    "limit": 25,
    "cwd": ["/Users/me/project", "/Users/me/project-worktree"],
    "sortKey": "created_at"
} }
{ "id": 20, "result": {
    "data": [
      { "id": "thr_a", "preview": "Create a TUI", "modelProvider": "openai",
        "createdAt": 1730831111, "updatedAt": 1730831111,
        "status": { "type": "notLoaded" }, … },
      { "id": "thr_b", "preview": "Fix tests", … }
    ],
    "nextCursor": "opaque-token-or-null",
    "backwardsCursor": "opaque-token-or-null"
} }
```

Filters (all optional):

- `cursor` — opaque token from a prior response; omit on first page.
- `limit` — server defaults to a reasonable page size.
- `sortKey` — `created_at` (default) or `updated_at`.
- `sortDirection` — `desc` (default) or `asc`.
- `modelProviders` — restrict to specific providers.
- `sourceKinds` — restrict to specific sources; omit or `[]` for interactive sessions only (`cli`, `vscode`).
- `archived` — `true` to list archived only; `false`/`null` for non-archived (default).
- `cwd` — string or array, exact-match. Relative paths resolve against the app-server cwd.
- `useStateDbOnly` — skip JSONL rollout scan that would otherwise repair metadata.
- `searchTerm` — case-sensitive substring filter on extracted titles.

`nextCursor: null` means you're on the last page. Pass `backwardsCursor` as `cursor` with the opposite `sortDirection` to go the other way.

## `thread/read`

Read a stored thread without resuming. Optionally inflate `thread.turns`:

```json
{ "method": "thread/read", "id": 22, "params": { "threadId": "thr_123" } }
{ "id": 22, "result": {
    "thread": { "id": "thr_123", "status": { "type": "notLoaded" }, "turns": [] }
} }

{ "method": "thread/read", "id": 23, "params": { "threadId": "thr_123", "includeTurns": true } }
```

## `thread/archive` / `thread/unarchive`

Move a rollout file between the active and archived sessions directories. Archive also attempts to move spawned descendant rollouts.

```json
{ "method": "thread/archive", "id": 21, "params": { "threadId": "thr_b" } }
{ "id": 21, "result": {} }
{ "method": "thread/archived", "params": { "threadId": "thr_b" } }
```

```json
{ "method": "thread/unarchive", "id": 24, "params": { "threadId": "thr_b" } }
{ "id": 24, "result": { "thread": { "id": "thr_b" } } }
{ "method": "thread/unarchived", "params": { "threadId": "thr_b" } }
```

Archived threads are excluded from `thread/list` unless `archived: true` is passed.

## `thread/name/set`

Set or update a thread's user-facing name (loaded thread or persisted rollout). Names are not unique — name lookups resolve to the most recently updated thread.

```json
{ "method": "thread/name/set", "id": 30, "params": {
    "threadId": "thr_123",
    "name": "Fix the auth bug"
} }
{ "id": 30, "result": {} }
{ "method": "thread/name/updated", "params": { "threadId": "thr_123", "name": "Fix the auth bug" } }
```

The notification only goes to initialized, opted-in clients.

## `thread/rollback`

Drop the last N turns from the agent's in-memory context **and** persist a rollback marker in the rollout so future resumes see the pruned history.

> Returns the updated `thread` (with `turns` populated) on success.
>
> — `codex-rs/app-server/README.md` § API Overview

This is the right tool when the user wants to "go back" to before a problematic turn, not `thread/fork`.

## `thread/turns/list`

Page a stored thread's turn history without resuming it. Default sort is descending so clients can start at the present and walk back with `nextCursor`. Pass `backwardsCursor` as `cursor` with `sortDirection: "asc"` to fetch turns newer than the first item from the earlier page.

```json
{ "method": "thread/turns/list", "id": 24, "params": {
    "threadId": "thr_123",
    "limit": 50,
    "sortDirection": "desc"
} }
```

## `thread/loaded/list`

Returns thread ids currently loaded in memory. Useful to check which sessions are active without scanning rollouts on disk.

```json
{ "method": "thread/loaded/list", "id": 21 }
{ "id": 21, "result": { "data": ["thr_123", "thr_456"] } }
```

## `thread/unsubscribe`

Removes the current connection's subscription to a thread. If this was the last subscriber, the server **does not unload the thread immediately**:

> It unloads the thread after the thread has had no subscribers and no thread activity for 30 minutes, then emits `thread/closed` and a `thread/status/changed` transition to `notLoaded`.
>
> — `codex-rs/app-server/README.md` § Example: Unsubscribe from a loaded thread

Response status is one of `unsubscribed`, `notSubscribed`, or `notLoaded`.

## `thread/compact/start`

Trigger manual history compaction. Returns `{}` immediately; progress streams as standard `turn/*` and `item/*` notifications on the same `threadId` (specifically a single `contextCompaction` item: `item/started` → `item/completed`). While compaction runs, the thread is effectively in a turn — surface a progress UI.

## `thread/inject_items`

Append prebuilt Responses-API items to a loaded thread's prompt history without starting a user turn. Items are persisted to the rollout and included in subsequent model requests. (Experimental field-level: `injectItems` is annotated experimental in the protocol.)

```json
{ "method": "thread/inject_items", "id": 36, "params": {
    "threadId": "thr_123",
    "items": [
        { "type": "message", "role": "assistant",
          "content": [{ "type": "output_text", "text": "Previously computed context." }] }
    ]
} }
{ "id": 36, "result": {} }
```

## Thread-lifecycle notifications

The full notification union is in [`event-catalog.md`](./event-catalog.md). The thread-scoped ones:

| Method | Payload | Emitted when |
|--------|---------|--------------|
| `thread/started` | `{ thread }` | After `thread/start` / `thread/resume` / `thread/fork`; also for detached review threads. Carries the current `thread.status`. |
| `thread/closed` | `{ threadId }` | After idle-unload (30 min with no subscribers and no activity), or by an explicit unload path. |
| `thread/archived` | `{ threadId }` | After `thread/archive` succeeds (one notification per archived thread, including descendants). |
| `thread/unarchived` | `{ threadId }` | After `thread/unarchive` succeeds. |
| `thread/status/changed` | `{ threadId, status }` | When a loaded thread's status changes after it has already been introduced to the client. `status` is `notLoaded`, `idle`, `systemError`, or `active` (with `activeFlags`). `thread/start`/`thread/fork`/detached-review do **not** emit a separate initial `thread/status/changed` — their `thread/started` already carries the current status. |
| `thread/name/updated` | `{ threadId, name }` | After `thread/name/set` (initialized, opted-in clients only). |
| `thread/tokenUsage/updated` | `{ threadId, … }` | When token usage rolls forward — including immediately after `thread/resume` if persisted usage exists. |

Status object example:

```json
{ "method": "thread/status/changed", "params": {
    "threadId": "thr_123",
    "status": { "type": "active", "activeFlags": [] }
} }
```

## What we'll need from this surface for Quicksave migration

(Pointers, not commitments — discuss with the migration plan.)

- **Stable handshake**: `initialize` + `initialized`. We pick a `clientInfo.name` (e.g. `quicksave`).
- **Thread management**: `thread/start` (new conversation), `thread/resume` by `threadId` (continue), `thread/list` (sidebar), `thread/archive` / `thread/unarchive`, `thread/name/set`, `thread/rollback` (truncate), `thread/unsubscribe` (release server-side state). All stable.
- **History pagination**: `thread/turns/list` for incremental sidebar/loading.
- **Compaction**: `thread/compact/start` if/when we want to trigger it explicitly; otherwise let auto-compaction run.
- **Pull-only**: `thread/read` for fetching a thread without resuming (preview / hover state).

For per-turn behavior continue in [`turns.md`](./turns.md).
