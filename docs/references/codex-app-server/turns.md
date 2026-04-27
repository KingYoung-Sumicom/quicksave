# Codex `app-server` — turns: `turn/start`, `turn/steer`, `turn/interrupt`, and the in-flight notification stream

> **Source(s):** https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (§ Lifecycle Overview, § Example: Start a turn (send user input), § Example: Interrupt an active turn, § Example: Steer an active turn, § Events → § Turn events → § Items, § Errors); locally-generated `v2/TurnStartParams.ts`, `v2/UserInput.ts`, `v2/AskForApproval.ts`, `v2/SandboxPolicy.ts`, `v2/PermissionProfile.ts`, `v2/ApprovalsReviewer.ts`, `v2/Personality.ts`, `v2/ReasoningEffort.ts`, `v2/ServiceTier.ts`, `v2/CollaborationMode.ts`, `v2/NonSteerableTurnKind.ts` (CLI 0.125.0).
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

This is the file the migration hinges on. The Thread API (SDK) collapses everything between "send a message" and "got a response" into a single callback stream. App-server gives us a real protocol with explicit per-turn override semantics, mid-turn steering, and a typed event catalog.

For approval round-trips that happen *during* a turn see [`approvals.md`](./approvals.md). For the union of every notification ever emitted see [`event-catalog.md`](./event-catalog.md).

## `turn/start`

Adds user input to a thread and triggers Codex generation. Responds with the new `turn` object **immediately**; the actual model work is signalled later by the `turn/started` notification.

> `turn/start` — add user input to a thread and begin Codex generation; responds with the initial `turn` object and streams `turn/started`, `item/*`, and `turn/completed` notifications. Prefer `permissionProfile` for permission overrides; the legacy `sandboxPolicy` field is still accepted but cannot be combined with `permissionProfile`. For `collaborationMode`, `settings.developer_instructions: null` means "use built-in instructions for the selected mode".
>
> — `codex-rs/app-server/README.md` § API Overview

### Wire example (verbatim from the README)

```json
{ "method": "turn/start", "id": 30, "params": {
    "threadId": "thr_123",
    "input": [ { "type": "text", "text": "Run tests" } ],
    "cwd": "/Users/me/project",
    "approvalPolicy": "unlessTrusted",
    "sandboxPolicy": {
        "type": "workspaceWrite",
        "writableRoots": ["/Users/me/project"],
        "networkAccess": true
    },
    "model": "gpt-5.1-codex",
    "effort": "medium",
    "summary": "concise",
    "personality": "friendly",
    "outputSchema": {
        "type": "object",
        "properties": { "answer": { "type": "string" } },
        "required": ["answer"],
        "additionalProperties": false
    }
} }
{ "id": 30, "result": { "turn": {
    "id": "turn_456",
    "status": "inProgress",
    "items": [],
    "error": null
} } }
```

## The sticky-override rule

This is the headline difference from the SDK Thread API. **Verbatim from `codex-rs/app-server/README.md` § Example: Start a turn (send user input):**

> You can optionally specify config overrides on the new turn. **If specified, these settings become the default for subsequent turns on the same thread.** `outputSchema` applies only to the current turn. Experimental `environments` is turn-scoped: omit it to inherit the thread's sticky environments, pass `[]` to run the turn with no environments, or pass explicit environment ids to override the sticky selection for this turn only.

The same rule is encoded in every override field on the generated `TurnStartParams`. From `v2/TurnStartParams.ts`:

```ts
/** Override the working directory for this turn and subsequent turns. */
cwd?: string | null,
/** Override the approval policy for this turn and subsequent turns. */
approvalPolicy?: AskForApproval | null,
/** Override where approval requests are routed for review on this turn and
 *  subsequent turns. */
approvalsReviewer?: ApprovalsReviewer | null,
/** Override the sandbox policy for this turn and subsequent turns. */
sandboxPolicy?: SandboxPolicy | null,
/** Override the full permissions profile for this turn and subsequent
 *  turns. Cannot be combined with `sandboxPolicy`. */
permissionProfile?: PermissionProfile | null,
/** Override the model for this turn and subsequent turns. */
model?: string | null,
/** Override the service tier for this turn and subsequent turns. */
serviceTier?: ServiceTier | null | null,
/** Override the reasoning effort for this turn and subsequent turns. */
effort?: ReasoningEffort | null,
/** Override the reasoning summary for this turn and subsequent turns. */
summary?: ReasoningSummary | null,
/** Override the personality for this turn and subsequent turns. */
personality?: Personality | null,
/** Optional JSON Schema used to constrain the final assistant message for
 *  this turn. */
outputSchema?: JsonValue | null,
/** EXPERIMENTAL - Set a pre-set collaboration mode.
 *  Takes precedence over model, reasoning_effort, and developer instructions if set.
 *
 *  For `collaboration_mode.settings.developer_instructions`, `null` means
 *  "use the built-in instructions for the selected mode". */
collaborationMode?: CollaborationMode | null
```

So:

- **Sticky** (sets thread default for subsequent turns, until overridden again): `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `permissionProfile`, `model`, `serviceTier`, `effort`, `summary`, `personality`, `collaborationMode`.
- **One-shot** (this turn only): `outputSchema`, and the experimental `environments` array.

This means: if you call `turn/start` with `effort: "high"` once, every later `turn/start` on the same thread that omits `effort` keeps `"high"`. To revert you must explicitly pass a different value. The same is true for `model`, `approvalPolicy`, etc. The `@openai/codex-sdk` `runStreamed({ model: ... })` per-call config has *exactly* the same sticky semantic — but with app-server it's documented and inspectable.

`outputSchema` is the special case: it applies only to the current turn. This is the field you'd use for "give me one structured JSON answer" without rewriting the whole thread's persona.

## `TurnStartParams` — full field reference

```ts
export type TurnStartParams = {
  threadId: string,
  input: Array<UserInput>,

  // ── Sticky overrides (this turn AND subsequent turns) ────────────────
  cwd?: string | null,
  approvalPolicy?: AskForApproval | null,             // see approvals.md
  approvalsReviewer?: ApprovalsReviewer | null,       // "user" | "auto_review" | "guardian_subagent"
  sandboxPolicy?: SandboxPolicy | null,               // see approvals.md
  permissionProfile?: PermissionProfile | null,       // mutually exclusive with sandboxPolicy
  model?: string | null,
  serviceTier?: ServiceTier | null | null,            // "fast" | "flex"
  effort?: ReasoningEffort | null,                    // "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  summary?: ReasoningSummary | null,
  personality?: Personality | null,                   // "none" | "friendly" | "pragmatic"
  collaborationMode?: CollaborationMode | null,       // EXPERIMENTAL

  // ── One-shot (this turn only) ────────────────────────────────────────
  outputSchema?: JsonValue | null,                    // JSON Schema for the final assistant message
  // (experimental, not in stable schema export)
  // environments?: Array<{ environmentId: string, cwd?: string }> | [];
};
```

`UserInput` (from `v2/UserInput.ts`) is a tagged union:

```ts
export type UserInput =
  | { "type": "text", text: string, text_elements: Array<TextElement> }
  | { "type": "image", url: string }
  | { "type": "localImage", path: string }
  | { "type": "skill", name: string, path: string }
  | { "type": "mention", name: string, path: string };
```

Skills (`$<skill-name>`), apps (`$<app-slug>` + `mention` with `app://<connector-id>`) and plugins (`@<name>` + `mention` with `plugin://<plugin-name>@<marketplace-name>`) all use the `UserInput` array form — see the README's "Start a turn (invoke a skill / app / plugin)" examples.

### Cross-references for override field shapes

- `AskForApproval`, `SandboxPolicy`, `PermissionProfile` → [`approvals.md`](./approvals.md). The mutually-exclusive `sandboxPolicy` / `permissionProfile` rule is enforced server-side: send both and you get a JSON-RPC error. Prefer `permissionProfile` for new code.
- `approvalsReviewer` controls whether approval prompts go to the user, an auto-review subagent, or the legacy `guardian_subagent`. See [`approvals.md`](./approvals.md) § Approval reviewers.
- `effort` and `summary` map to the OpenAI Responses-API reasoning fields — `xhigh` is real (CLI 0.125.0). `summary` is `ReasoningSummary` (typically `"auto"` / `"concise"` / `"detailed"`).
- `serviceTier` is just `"fast" | "flex"`.

## `turn/interrupt`

Cancel an in-flight turn by `(threadId, turnId)`. Async — wait for `turn/completed` with `status: "interrupted"`.

```json
{ "method": "turn/interrupt", "id": 31, "params": {
    "threadId": "thr_123",
    "turnId": "turn_456"
} }
{ "id": 31, "result": {} }
```

> The server requests cancellation of the active turn, then emits a `turn/completed` event with `status: "interrupted"`. **This does not terminate background terminals**; use `thread/backgroundTerminals/clean` when you explicitly want to stop those shells. Rely on the `turn/completed` event to know when turn interruption has finished.
>
> — `codex-rs/app-server/README.md` § Example: Interrupt an active turn

`thread/backgroundTerminals/clean` is experimental (`capabilities.experimentalApi = true` required).

## `turn/steer`

Append additional user input to the **currently active** regular turn — no new `turn/started`, no override fields, just more input piped into the same generation. The mid-turn redirection primitive that has no SDK equivalent.

```json
{ "method": "turn/steer", "id": 32, "params": {
    "threadId": "thr_123",
    "input": [ { "type": "text", "text": "Actually focus on failing tests first." } ],
    "expectedTurnId": "turn_456"
} }
{ "id": 32, "result": { "turnId": "turn_456" } }
```

`expectedTurnId` is the precondition — it is **required**. From the README:

> `expectedTurnId` is required. If there is no active turn, `expectedTurnId` does not match the active turn, or the active turn kind does not accept same-turn steering (for example review or manual compaction), the request fails with an `invalid request` error.
>
> — `codex-rs/app-server/README.md` § Example: Steer an active turn

The "non-steerable" turn kinds are exactly the ones in `v2/NonSteerableTurnKind.ts`:

```ts
export type NonSteerableTurnKind = "review" | "compact";
```

If you try to steer one of those, you get a `codexErrorInfo: ActiveTurnNotSteerable { turnKind }` error. The error catalog also flags this case for `turn/start` submitted while a non-steerable turn is active. (Source: README § Errors.)

## In-flight notification stream

Once `turn/start` returns, the server pushes JSON-RPC notifications until the matching `turn/completed`. The README's § Turn events says:

> The app-server streams JSON-RPC notifications while a turn is running. Each turn emits `turn/started` when it begins running and ends with `turn/completed` (final `turn` status). Token usage events stream separately via `thread/tokenUsage/updated`. Clients subscribe to the events they care about, rendering each item incrementally as updates arrive. **The per-item lifecycle is always: `item/started` → zero or more item-specific deltas → `item/completed`.**

### Turn-scoped notifications

| Method | Payload | When |
|--------|---------|------|
| `turn/started` | `{ turn }` (id, empty `items`, `status: "inProgress"`) | Server begins working on the turn. |
| `turn/completed` | `{ turn }` where `turn.status` ∈ `completed \| interrupted \| failed`; failures carry `{ error: { message, codexErrorInfo?, additionalDetails? } }` | Turn is finished. Always exactly one per turn. |
| `turn/diff/updated` | `{ threadId, turnId, diff }` | Emitted after every `fileChange` item. `diff` is the latest aggregated unified diff across every file change in the turn — render this directly without stitching individual `fileChange` items. |
| `turn/plan/updated` | `{ turnId, explanation?, plan }` where each entry is `{ step, status }` (status ∈ `pending \| inProgress \| completed`) | Whenever the agent shares or changes its plan. |
| `model/rerouted` | `{ threadId, turnId, fromModel, toModel, reason }` | Backend reroutes the request to a different model (e.g. high-risk cyber-safety policy). |
| `model/verification` | `{ threadId, turnId, verifications }` | Backend flags additional account verification (e.g. `trustedAccessForCyber`). |

> Today both notifications carry an empty `items` array even when item events were streamed; rely on `item/*` notifications for the canonical item list until this is fixed.
>
> — `codex-rs/app-server/README.md` § Turn events

So treat `turn/started.turn.items` and `turn/completed.turn.items` as **unreliable** — the truth is the sequence of item notifications.

### Item lifecycle (every item type)

```
item/started                      ← full item, status="inProgress"
   ├─ (item-specific delta notifications, see below)
   └─ item/completed              ← final, authoritative item
```

`item.id` in `item/started` matches the `itemId` in subsequent deltas. `item/completed` carries the authoritative final state — render execution status, exit codes, results from this notification, not the deltas.

### Per-item-type deltas

From the README § Items + § agentMessage / plan / reasoning / commandExecution / fileChange:

| Item type | Delta methods | Notes |
|-----------|---------------|-------|
| `agentMessage` | `item/agentMessage/delta` | Concatenate `delta` strings for the same `itemId` to reconstruct the full reply. |
| `plan` | `item/plan/delta` (experimental) | Concatenate. Corresponds to the `<proposed_plan>` block. |
| `reasoning` | `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta` | `summaryTextDelta` streams readable summaries; `summaryIndex` increments when a new summary section opens. `summaryPartAdded` marks the boundary between summary sections. `textDelta` streams *raw* reasoning text (open-source models only); group by `contentIndex`. |
| `commandExecution` | `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction` | `outputDelta` streams stdout/stderr. Final `commandExecution` items include parsed `commandActions`, `status`, `exitCode`, `durationMs`. |
| `fileChange` | `item/fileChange/patchUpdated` (only when `features.apply_patch_streaming_events` enabled), `item/fileChange/outputDelta` | `patchUpdated` streams structured file-change snapshots parsed from the model-generated patch *before* it executes. `outputDelta` carries the underlying `apply_patch` tool response. |
| `mcpToolCall` | `item/mcpToolCall/progress` | Streams MCP tool-call progress. |
| `webSearch` | (no deltas) | `action` mirrors the Responses API web_search action payload (`search`, `open_page`, `find_in_page`); may be omitted until completion. |
| `imageView` | (no deltas) | Image-viewer tool. |
| `dynamicToolCall` | (paired with the `item/tool/call` server→client request, see [`approvals.md`](./approvals.md)) | Experimental. |
| `enteredReviewMode` / `exitedReviewMode` | (no deltas) | Lifecycle markers for `review/start`. |
| `contextCompaction` | (no deltas) | Auto or manual compaction. |
| `compacted` | — | **Deprecated** — use `contextCompaction`. |

### Auto-approval review (UNSTABLE)

When `approvalsReviewer` is `"auto_review"` (or the legacy `"guardian_subagent"`), two extra notifications fire around an item that is being auto-reviewed:

- `item/autoApprovalReview/started` — `{ threadId, turnId, targetItemId, review, action }`
- `item/autoApprovalReview/completed` — `{ threadId, turnId, targetItemId, review, action }`

Both are flagged `[UNSTABLE]` in the README and in the generated TS bindings (`v2/ItemGuardianApprovalReviewStartedNotification.ts`, `v2/ItemGuardianApprovalReviewCompletedNotification.ts`). The `review` payload includes `status` (`inProgress \| approved \| denied \| aborted`), optional `riskLevel` (`low \| medium \| high \| critical`), `userAuthorization`, and `rationale`. See [`approvals.md`](./approvals.md) for the full action shape.

These notifications are separate from the target item's own `item/completed` lifecycle and are intentionally temporary while the auto-review app protocol is still being designed.

### Token usage

`thread/tokenUsage/updated` streams independently of turns. It also fires immediately after `thread/resume` if the stored thread had persisted token usage (so clients can render "you're at 50k / 200k tokens" before the next turn even starts).

For our migration this replaces the SDK's `usage` callback in `runStreamed` — we now own the rolling token counter at thread granularity instead of per-turn.

## Errors

`error` is emitted whenever the server hits an error mid-turn (upstream model errors, quota limits, etc.). It carries the same payload shape as `turn/completed.status: "failed"` and **may precede** that terminal notification.

Error payload shape:

```ts
{ error: { message: string, codexErrorInfo?: CodexErrorInfo, additionalDetails?: ... } }
```

`CodexErrorInfo` enum (from the README, with `httpStatusCode` forwarded when available):

- `ContextWindowExceeded`
- `UsageLimitExceeded`
- `HttpConnectionFailed { httpStatusCode? }` — upstream HTTP failures (4xx/5xx)
- `ResponseStreamConnectionFailed { httpStatusCode? }` — failure to connect to the response SSE stream
- `ResponseStreamDisconnected { httpStatusCode? }` — disconnect of the response SSE stream mid-turn
- `ResponseTooManyFailedAttempts { httpStatusCode? }`
- `ActiveTurnNotSteerable { turnKind }` — `turn/start` or `turn/steer` was submitted while the current active turn was not steerable, e.g. `/review` or manual `/compact`
- `BadRequest`
- `Unauthorized`
- `SandboxError`
- `InternalServerError`
- `Other` — all unclassified errors

## Putting the stream in order

A typical turn looks like:

```
→ turn/start  (request)
← { result: { turn: { id, status: "inProgress", items: [], error: null } } }

← turn/started               { turn }
← item/started               { item: { type: "agentMessage", … } }
← item/agentMessage/delta    { itemId, delta: "I'll start by…" }
← item/agentMessage/delta    { itemId, delta: " reading the test file." }
← item/started               { item: { type: "commandExecution", … } }
← item/commandExecution/requestApproval (server→client REQUEST) ─┐
                                                                  │  see approvals.md
→ { decision: "accept" }                                          │
← serverRequest/resolved     { threadId, requestId }              │
← item/commandExecution/outputDelta { itemId, deltaBase64, … }  ←─┘
← item/completed             { item: { type: "commandExecution", status: "completed", exitCode: 0, … } }
← item/started               { item: { type: "fileChange", … } }
← item/fileChange/patchUpdated  { itemId, … }
← turn/diff/updated          { threadId, turnId, diff }
← item/completed             { item: { type: "fileChange", status: "completed", … } }
← item/completed             { item: { type: "agentMessage", text: "All tests pass.", … } }
← turn/completed             { turn: { id, status: "completed", … } }
← thread/tokenUsage/updated  { threadId, … }
```

## What we'll rebuild for Quicksave

(Not commitments — pointers for the migration plan.)

- The `StreamCardBuilder` analogue should consume the **`item/*` notification surface** as its source of truth, not `turn.items`.
- Sticky overrides change our store API: per-call `model`/`effort` no longer passed each time; we pass them once when the user changes the dropdown, then trust the thread until they change it again. We can read the canonical state back via `thread/read` if needed.
- `turn/steer` unlocks a real "pin a follow-up" / "actually focus on X" UX without spawning a new turn.
- `turn/interrupt` is now an actual primitive instead of "kill the SDK process and reset" — much better for long-running tool turns.
- Use `outputSchema` for any "structured response" surfaces (commit summary, PR title, etc.) instead of post-hoc parsing.
- Map every notification on the wire to either a card-builder input or "ignore for now" using [`event-catalog.md`](./event-catalog.md).
