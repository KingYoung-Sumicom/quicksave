# Codex `app-server` — exhaustive notification catalog

> **Source(s):** locally-generated `ServerNotification.ts` union (CLI 0.125.0 — authoritative wire-method catalog); locally-generated `v2/*Notification.ts` payloads; https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (§ Events, § Turn events → § Items, § Errors, § Approvals, § Auth endpoints).
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

This is the lookup table to use when wiring app-server events into Quicksave's card builder. Every method in this table appears on the wire; anything that *isn't* in this table won't be emitted.

The authoritative source is the union in `ServerNotification.ts` (which we regenerate from the CLI). Read this file when you need to decide *"is this event a card-builder input or do we ignore it for now?"* — it's grouped to make that triage fast.

## How to read this

- **Method**: the JSON-RPC `method` field as it appears on stdout.
- **Payload**: the `params` shape (link to the generated TS file).
- **One-liner**: what fires it and what to do with it.
- **Notes**: stability flags, opt-out hints, gotchas.

Notifications are **server → client only** and have no `id`. To suppress one for a connection, send its exact method name in `initialize.params.capabilities.optOutNotificationMethods`. Exact-match only — no globs.

The README puts it concisely:

> Event notifications are the server-initiated event stream for thread lifecycles, turn lifecycles, and the items within them. After you start or resume a thread, keep reading stdout for `thread/started`, `thread/archived`, `thread/unarchived`, `thread/closed`, `turn/*`, and `item/*` notifications.
>
> — `codex-rs/app-server/README.md` § Events

## Thread lifecycle

| Method | Payload | One-liner |
|--------|---------|-----------|
| `thread/started` | `ThreadStartedNotification` | New thread became active (after `thread/start` / `thread/resume` / `thread/fork`, or detached review). Carries the current `thread.status`. |
| `thread/closed` | `ThreadClosedNotification` | Thread unloaded (idle for 30 min after last subscriber and last activity). |
| `thread/status/changed` | `ThreadStatusChangedNotification` | Loaded thread's status changed (`notLoaded` / `idle` / `systemError` / `active`). Not emitted for the initial transition into `active` — `thread/started` already carries that. |
| `thread/archived` | `ThreadArchivedNotification` | After `thread/archive` succeeds. One per archived thread (parent + descendants). |
| `thread/unarchived` | `ThreadUnarchivedNotification` | After `thread/unarchive` succeeds. |
| `thread/name/updated` | `ThreadNameUpdatedNotification` | After `thread/name/set`. Initialized, opted-in clients only. |
| `thread/tokenUsage/updated` | `ThreadTokenUsageUpdatedNotification` | Token usage changed. Also fires immediately after `thread/resume` if persisted usage was restored. |
| `thread/compacted` | `ContextCompactedNotification` | Auto-compaction completed (legacy event for the auto path). New code should rely on the `contextCompaction` item lifecycle inside a turn. |

> **Migration mapping**: `thread/started` and `thread/status/changed` drive sidebar live state. `thread/tokenUsage/updated` replaces our SDK-side per-turn `usage` callback at thread granularity. `thread/closed` tells us when to release any local thread-state caches.

## Turn lifecycle

| Method | Payload | One-liner |
|--------|---------|-----------|
| `turn/started` | `TurnStartedNotification` | Server has begun working on the turn. `turn.items` is empty here — rely on `item/*`. |
| `turn/completed` | `TurnCompletedNotification` | Turn finished. `turn.status` ∈ `completed \| interrupted \| failed`. Failures carry `error.codexErrorInfo`. |
| `turn/diff/updated` | `TurnDiffUpdatedNotification` | Aggregated unified diff across every `fileChange` item so far in the turn. Emitted after every `fileChange` item. Render this directly. |
| `turn/plan/updated` | `TurnPlanUpdatedNotification` | Agent plan changed. Each entry `{ step, status }` with `status` ∈ `pending \| inProgress \| completed`. |
| `model/rerouted` | `ModelReroutedNotification` | Backend rerouted the request to a different model (e.g. high-risk cyber-safety policy). |
| `model/verification` | `ModelVerificationNotification` | Backend flags additional account verification (e.g. `trustedAccessForCyber`). |

> **Migration mapping**: `turn/started` / `turn/completed` are the new per-turn boundary markers (currently we infer this from SDK `started`/`completed` events). `turn/diff/updated` replaces ad-hoc diff stitching in `StreamCardBuilder`.

## Item lifecycle (every item type)

These three methods fire for every item, regardless of type. `item.id` matches the `itemId` on subsequent type-specific deltas.

| Method | Payload | One-liner |
|--------|---------|-----------|
| `item/started` | `ItemStartedNotification` | New unit of work began. Render the item immediately. |
| `item/completed` | `ItemCompletedNotification` | Authoritative final item state. Treat as canonical for status / exit code / result. |
| `rawResponseItem/completed` | `RawResponseItemCompletedNotification` | Internal — emitted when `experimentalRawEvents: true` was set on `thread/start`. **Not for normal clients.** |

The item `type` discriminator (from the README § Items) determines which deltas you'll also see:

- `userMessage` (no deltas)
- `agentMessage` → `item/agentMessage/delta`
- `plan` → `item/plan/delta` (experimental)
- `reasoning` → `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`
- `commandExecution` → `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`
- `fileChange` → `item/fileChange/patchUpdated`, `item/fileChange/outputDelta`
- `mcpToolCall` → `item/mcpToolCall/progress`
- `dynamicToolCall` → paired with the `item/tool/call` server→client request
- `webSearch`, `imageView`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction` (no deltas)
- `compacted` — **deprecated**, use `contextCompaction`.

## Streaming deltas

| Method | Payload | One-liner |
|--------|---------|-----------|
| `item/agentMessage/delta` | `AgentMessageDeltaNotification` | Token chunks of the agent's reply. Concatenate by `itemId`. |
| `item/plan/delta` | `PlanDeltaNotification` | Plan-mode streaming text (experimental). |
| `item/reasoning/summaryTextDelta` | `ReasoningSummaryTextDeltaNotification` | Streamed reasoning summary. `summaryIndex` increments when a new summary section opens. |
| `item/reasoning/summaryPartAdded` | `ReasoningSummaryPartAddedNotification` | Marks the boundary between reasoning-summary sections. |
| `item/reasoning/textDelta` | `ReasoningTextDeltaNotification` | Raw reasoning text (open-source models only). Group by `contentIndex`. |
| `item/commandExecution/outputDelta` | `CommandExecutionOutputDeltaNotification` | Stdout/stderr chunks for an in-progress command item. |
| `item/commandExecution/terminalInteraction` | `TerminalInteractionNotification` | Terminal-interaction signals (resize, etc.) for command items. |
| `command/exec/outputDelta` | `CommandExecOutputDeltaNotification` | Stdout/stderr chunks for a **standalone** `command/exec` request (no thread/turn). Different surface from `item/commandExecution/outputDelta`. |
| `item/fileChange/patchUpdated` | `FileChangePatchUpdatedNotification` | Structured snapshot of a parsed apply-patch before execution. Only when `features.apply_patch_streaming_events` is enabled. |
| `item/fileChange/outputDelta` | `FileChangeOutputDeltaNotification` | Tool-call response of the underlying `apply_patch` call. |
| `item/mcpToolCall/progress` | `McpToolCallProgressNotification` | MCP tool-call progress events. |

> **Migration mapping**: `item/agentMessage/delta` drives our streaming bubble. `item/commandExecution/outputDelta` and `item/fileChange/patchUpdated` drive the live tool-card content.

## Approvals & server-request resolution

These are *notifications* that fire alongside the server→client approval **requests** documented in [`approvals.md`](./approvals.md).

| Method | Payload | One-liner |
|--------|---------|-----------|
| `serverRequest/resolved` | `ServerRequestResolvedNotification` | A pending server→client request (any of the approval requests, MCP elicitations, dynamic tool calls, request-user-input) has been resolved or cleared. **Always** fires after the client responds, **and also fires** when a turn start/complete/interrupt clears the pending request. Use this to dismiss approval UI cleanly. |
| `item/autoApprovalReview/started` | `ItemGuardianApprovalReviewStartedNotification` | **[UNSTABLE]** Auto-review subagent began evaluating an action (only when `approvalsReviewer: "auto_review"`). |
| `item/autoApprovalReview/completed` | `ItemGuardianApprovalReviewCompletedNotification` | **[UNSTABLE]** Auto-review subagent decided. Carries `decisionSource`. |
| `guardianWarning` | `GuardianWarningNotification` | Guardian system flagged a non-blocking concern. |

The actual approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, etc.) are **JSON-RPC requests, not notifications** — they live in `ServerRequest.ts`, not here. See [`approvals.md`](./approvals.md).

## Account / auth

| Method | Payload | One-liner |
|--------|---------|-----------|
| `account/updated` | `AccountUpdatedNotification` | Auth mode changed (`apikey` / `chatgpt` / `null` after logout). Includes current `planType` when available. |
| `account/login/completed` | `AccountLoginCompletedNotification` | A login flow finished (success or error). Payload includes `loginId`, `success`, `error`. |
| `account/rateLimits/updated` | `AccountRateLimitsUpdatedNotification` | ChatGPT rate-limit window state changed. |

## MCP / plugins / apps

| Method | Payload | One-liner |
|--------|---------|-----------|
| `mcpServer/oauthLogin/completed` | `McpServerOauthLoginCompletedNotification` | OAuth flow for a configured MCP server finished. `{ name, success, error? }`. |
| `mcpServer/startupStatus/updated` | `McpServerStatusUpdatedNotification` | A configured MCP server's startup status changed (`starting \| ready \| failed \| cancelled`). |
| `app/list/updated` | `AppListUpdatedNotification` | The merged app (connector) list changed — emitted after each source (accessible apps / directory apps) finishes loading. |
| `skills/changed` | `SkillsChangedNotification` | Watched local skill files changed. Treat as cache-invalidation; re-run `skills/list` if needed. |
| `externalAgentConfig/import/completed` | `ExternalAgentConfigImportCompletedNotification` | After `externalAgentConfig/import` finishes (immediately if synchronous, later if background remote imports were queued). |

## Filesystem & shell utilities

| Method | Payload | One-liner |
|--------|---------|-----------|
| `fs/changed` | `FsChangedNotification` | A `fs/watch`'d path changed. Carries `watchId` + `changedPaths`. |
| `command/exec/outputDelta` | `CommandExecOutputDeltaNotification` | Standalone `command/exec` (no thread/turn) stdout/stderr chunk. (Note: same name as `item/commandExecution/outputDelta`'s sibling, but different scope.) |

## Thread realtime (experimental)

The thread-realtime API is a separate ephemeral surface — these are **not** `ThreadItem`s and won't reappear via `thread/read` / `thread/resume` / `thread/fork`. From the README § Events:

> Thread realtime uses a separate thread-scoped notification surface. `thread/realtime/*` notifications are ephemeral transport events, not `ThreadItem`s, and are not returned by `thread/read`, `thread/resume`, or `thread/fork`.

| Method | Payload | One-liner |
|--------|---------|-----------|
| `thread/realtime/started` | `ThreadRealtimeStartedNotification` | Realtime session started for a thread. `{ threadId, sessionId }`. |
| `thread/realtime/closed` | `ThreadRealtimeClosedNotification` | Realtime session closed. `{ threadId, reason }`. |
| `thread/realtime/error` | `ThreadRealtimeErrorNotification` | Realtime transport/backend error. `{ threadId, message }`. |
| `thread/realtime/itemAdded` | `ThreadRealtimeItemAddedNotification` | Raw non-audio realtime item without a typed app-server notification (e.g. `handoff_request`). `item` is forwarded as raw JSON until upstream stabilizes. |
| `thread/realtime/transcript/delta` | `ThreadRealtimeTranscriptDeltaNotification` | Live transcript delta. `{ threadId, role, delta }`. |
| `thread/realtime/transcript/done` | `ThreadRealtimeTranscriptDoneNotification` | Final full text for a transcript part. `{ threadId, role, text }`. |
| `thread/realtime/outputAudio/delta` | `ThreadRealtimeOutputAudioDeltaNotification` | Streamed output audio chunk. `audio` uses camelCase: `data`, `sampleRate`, `numChannels`, `samplesPerChannel`. Independently opt-out-able. |
| `thread/realtime/sdp` | `ThreadRealtimeSdpNotification` | Remote answer SDP for a WebRTC realtime start. `{ threadId, sdp }`. Pass to `setRemoteDescription`. |

## Hooks (experimental)

| Method | Payload | One-liner |
|--------|---------|-----------|
| `hook/started` | `HookStartedNotification` | A configured Codex lifecycle hook (e.g. `SessionStart`, `PreToolUse`) began executing. |
| `hook/completed` | `HookCompletedNotification` | A configured hook finished. |

## Fuzzy file search (experimental)

| Method | Payload | One-liner |
|--------|---------|-----------|
| `fuzzyFileSearch/sessionUpdated` | `FuzzyFileSearchSessionUpdatedNotification` | Current matching files for the active query. `{ sessionId, query, files }`. |
| `fuzzyFileSearch/sessionCompleted` | `FuzzyFileSearchSessionCompletedNotification` | Indexing/matching for that query has completed. `{ sessionId, query }`. |

## Windows sandbox

| Method | Payload | One-liner |
|--------|---------|-----------|
| `windowsSandbox/setupCompleted` | `WindowsSandboxSetupCompletedNotification` | Result of a `windowsSandbox/setupStart` request. `{ mode, success, error }`. |
| `windows/worldWritableWarning` | `WindowsWorldWritableWarningNotification` | Warning surfaced when a Windows path is unexpectedly world-writable. |

## Errors and warnings

| Method | Payload | One-liner |
|--------|---------|-----------|
| `error` | `ErrorNotification` | Mid-turn error. Carries `{ error: { message, codexErrorInfo?, additionalDetails? } }`. May precede a `turn/completed` with `status: "failed"`. |
| `warning` | `WarningNotification` | Generic non-fatal runtime warning. `{ threadId?, message }`. |
| `configWarning` | `ConfigWarningNotification` | Recoverable config / initialization warning. `{ summary, details?, path?, range? }`. May fire during `initialize`. |
| `deprecationNotice` | `DeprecationNoticeNotification` | Server is using a deprecated method/field; payload describes the replacement. |
| `guardianWarning` | `GuardianWarningNotification` | Guardian system flagged a non-blocking concern. |

`error.codexErrorInfo` enum values (from README § Errors):

`ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed`, `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected`, `ResponseTooManyFailedAttempts`, `ActiveTurnNotSteerable { turnKind }`, `BadRequest`, `Unauthorized`, `SandboxError`, `InternalServerError`, `Other`. When an upstream HTTP status is available it's forwarded in `httpStatusCode` on the relevant variant.

## Migration triage table

This is the meta-table — for each event class, what's the obvious mapping into Quicksave's existing card model? (Not commitments; first-pass guesses for the migration plan.)

| Event class | Card-builder input? | Notes |
|-------------|---------------------|-------|
| `thread/started`, `thread/status/changed`, `thread/closed`, `thread/name/updated`, `thread/archived`, `thread/unarchived` | **Yes** — drive sidebar / metadata UI. | Not session-scoped events; route to the session-list store, not the card builder. |
| `thread/tokenUsage/updated` | **Yes** — replaces SDK `usage` callback. | Per-thread, not per-turn. |
| `turn/started`, `turn/completed` | **Yes** — turn boundaries. | `turn.items` is unreliable; use the `item/*` stream instead. |
| `turn/diff/updated`, `turn/plan/updated` | **Yes** — already have analogues. | `turn/diff/updated` simplifies the diff card. |
| `item/started`, `item/completed` | **Yes — primary input.** | One-to-one with cards in our model. |
| `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress` | **Yes** — streaming card content. | Existing builder already handles incremental text/diff updates. |
| `item/reasoning/*` | **Yes (optional)** — reasoning UI. | We can opt-out via `optOutNotificationMethods` for users who don't want to see reasoning. |
| `item/plan/delta` | **Yes (experimental)** — plan card streaming. | Gate behind `experimentalApi`. |
| `serverRequest/resolved` | **Yes** — to dismiss approval dialogs. | Fires for **all** server-initiated requests, not just approvals. |
| `item/autoApprovalReview/*`, `guardianWarning` | **Maybe** — gated UX. | UNSTABLE; only render if user opted into auto-review. |
| `account/updated`, `account/login/completed`, `account/rateLimits/updated` | **Yes** — auth/UX banners. | Not card events. |
| `mcpServer/*`, `app/list/updated`, `skills/changed`, `externalAgentConfig/import/completed` | **Probably ignore** initially. | Wire up when we expose those features. |
| `fs/changed` | **Probably ignore.** | Only emitted if we explicitly call `fs/watch`. |
| `thread/realtime/*` | **Ignore** — experimental, not in scope. |
| `hook/started`, `hook/completed` | **Ignore** initially. | Hooks system; consider for later. |
| `fuzzyFileSearch/*`, `windowsSandbox/*`, `windows/worldWritableWarning` | **Ignore.** | Out of our use case. |
| `error`, `warning`, `configWarning`, `deprecationNotice` | **Yes** — surface to user / log. | `configWarning` may fire during `initialize`. |
| `command/exec/outputDelta` | **No** unless we use standalone `command/exec`. | Different surface from item-scoped `commandExecution`. |
| `rawResponseItem/completed` | **Ignore.** | Internal; only when `experimentalRawEvents: true`. |
| `model/rerouted`, `model/verification` | **Yes (banner)** — surface to user. | Edge cases that change the user's expectation of what's running. |

> When a new method appears in a future CLI version that's not here, regenerate the TS bindings (`codex app-server generate-ts --out DIR`) and check `DIR/ServerNotification.ts` — that union is the source of truth, and this table is downstream.
