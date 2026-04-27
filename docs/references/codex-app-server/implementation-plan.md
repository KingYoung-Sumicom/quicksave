# Codex `app-server` migration — implementation plan

> **Status:** Phases 1-5 complete (2026-04-26). The codex `app-server`
> path is the default and only Codex backend. `CodexSdkProvider` and
> the `@openai/codex-sdk` dependency have been removed. This document
> is preserved as a record of the decisions; non-historical readers
> should look at `docs/references/quicksave-architecture.md` §二 for
> current structure.
>
> **Premise:** the user can't change Codex `model` / `effort` /
> `permissionMode` mid-session because `@openai/codex-sdk@0.125.0` treats
> `ThreadOptions` as immutable. Codex `app-server` (JSON-RPC v2) supports
> sticky per-turn overrides on `turn/start` (`model`, `effort`,
> `approvalPolicy`, `sandboxPolicy`, `permissionProfile`, `personality`,
> …). OpenAI explicitly recommends `app-server` for "full-fidelity
> integrations". This plan migrates Quicksave's Codex backend from the
> embedded SDK to a homegrown app-server client **without changing the
> card-builder contract**.

---

## 0. Red lines

These do **not** change in this migration. Any patch that changes them is
out of scope and must be a separate, justified follow-up.

| Surface | File(s) | Why preserved |
|---|---|---|
| `Card` discriminated union | `packages/shared/src/cards.ts:43-108` | PWA renders against this. Adding fields is OK; renaming/removing is not. |
| `CardEvent` wire shape (`add` / `update` / `append_text` / `remove`) | `packages/shared/src/cards.ts:110-152` | Bus subscribers across PWA/relay decode this exactly. |
| `CardStreamEnd` shape including `tokenUsage.{cumulativeInput,cumulativeOutput,cumulativeCachedInput}` | `packages/shared/src/cards.ts:190-212` | The Codex per-turn delta UX depends on these being present and accurate. |
| `StreamCardBuilder` public mutator API | `apps/agent/src/ai/cardBuilder.ts:412-608` | All providers drive it. New provider must call the same methods with the same semantics. |
| `eventStore` `LastTurnInfo.cumulativeInputTokens` round-trip | `apps/agent/src/storage/eventStore.ts:44-61`; recorded at `apps/agent/src/service/run.ts:303-340`; consumed at `apps/agent/src/ai/codexSdkProvider.ts:778-786` | Cold-resume token accounting depends on it. The new provider must keep emitting and seeding from this. |
| Bus topic `/sessions/:sessionId/cards` | `apps/agent/src/service/run.ts:270-357` | PWA subscribes. Don't move it. |

> **All migration logic lives upstream of `StreamCardBuilder`.** The new
> provider translates v2 notifications → existing builder method calls.
> The builder itself is untouched unless we identify a specific need
> (see §6 R5 — `toolResult` may need an additive `append` mode).

---

## 1. Goals / non-goals

**Goals**

- G1. New `CodexAppServerProvider` co-existing with `CodexSdkProvider`
  behind a config flag. Both can be exercised in tests.
- G2. Per-turn `setSessionConfig` for `model`, `reasoningEffort`,
  `permissionMode` (→ `approvalPolicy`/`sandboxPolicy`/`permissionProfile`)
  applies to the **next** `turn/start` without restarting the thread.
- G3. Existing `codexSdkProvider.test.ts` regression net mirrored
  against the new provider — same card output for equivalent v2
  scenarios.
- G4. Default rollout: feature-flag opt-in, then flip default after a
  release of dogfooding, then remove `CodexSdkProvider` in a later
  release.
- G5. No regressions in the card-builder contract surfaced by §6 risks.

**Non-goals**

- N1. Adopting **new** v2 capabilities that have no current consumer
  (`turn/diff/updated` aggregated diff card, `turn/plan/updated` plan
  card variant, `item/autoApprovalReview/*`, `guardianWarning`,
  `model/rerouted` banner). These are post-migration follow-ups.
- N2. Replacing the `Card` union or adding new variants.
- N3. WebSocket transport. We use `stdio://` only — `ws://` is
  documented "experimental and unsupported for production"
  (`docs/references/codex-app-server/protocol-overview.md`).
- N4. Replacing the Claude provider. This is Codex-only.

---

## 2. Architecture

### 2.1 Component layout

```
apps/agent/src/ai/
├─ provider.ts                       (unchanged interface)
├─ cardBuilder.ts                    (RED LINE — unchanged)
├─ codexSdkProvider.ts               (kept during migration; removed in cleanup)
├─ codexSdkProvider.test.ts          (kept; regression net)
└─ codexAppServer/                   ← NEW
   ├─ index.ts                       (exports CodexAppServerProvider)
   ├─ provider.ts                    (CodexAppServerProvider, CodexAppServerSession — implements ProviderSession)
   ├─ rpcClient.ts                   (JSON-RPC 2.0 over stdio JSONL: request/response/notification dispatch, backpressure)
   ├─ processManager.ts              (spawn `codex app-server`, lifecycle, stderr piping)
   ├─ schema/                        (TS types ported from `codex app-server generate-ts`)
   │  ├─ index.ts                    (re-exports the subset we use)
   │  └─ generated/                  (regenerated artifacts; gitignored or vendored — decision in §3.2)
   ├─ cardAdapter.ts                 (v2 notification → StreamCardBuilder calls — the heart of the migration)
   ├─ overrideStore.ts               (resolves SessionConfig → next-turn TurnStartParams overrides)
   ├─ tokenAccounting.ts             (turn-boundary delta computation against thread-cumulative)
   └─ provider.test.ts, cardAdapter.test.ts, …
```

### 2.2 Session config flag

A single new field on the per-session config drives backend selection.
Existing `setSessionConfig(key, value)` paths in
`apps/agent/src/ai/sessionManager.ts:288-330` and
`apps/agent/src/handlers/messageHandler.ts` are extended.

```ts
// packages/shared/src/types.ts (additions, NOT renames)
export type CodexBackend = 'sdk' | 'app-server';

// New SessionConfig key 'codexBackend' resolves at session-start
// from session prefs → user prefs → defaults('sdk').
```

The provider factory that today branches on `provider === 'codex'` to
construct `CodexSdkProvider` adds a sub-branch on `codexBackend`. Both
providers implement `CodingAgentProvider` (`apps/agent/src/ai/provider.ts:8-16`)
and `ProviderSession`. SessionManager doesn't care which is which.

### 2.3 Transport

- **Default:** spawn `codex app-server` with stdio (default `--listen
  stdio://`).
- **Lifecycle:** one app-server child process per active session is the
  simplest mental model and matches today's per-session SDK Thread
  ownership. This avoids cross-session state entanglement and matches
  the existing `ManagedSession` / `cardBuilder` lifetime.
- **Future option:** one app-server child process per daemon with
  multiple threads multiplexed. Out of scope here; revisit when we have
  app-server in production.
- **Restart on stderr-detected fatal:** ProcessManager owns crash
  recovery. SessionManager treats a crashed app-server like the SDK
  treats a thrown error today — emit `interrupted: true` stream-end and
  surface a system error card.

### 2.4 Initialize handshake

Per `docs/references/codex-app-server/lifecycle.md`, every session
performs an `initialize` request before any thread method. The provider
caches `InitializeResponse.capabilities` to know which optional
notifications the server supports for this codex version.

We send `optOutNotificationMethods` for events we ignore initially
(realtime, fuzzy file search, windows sandbox, raw response item) so we
don't pay the JSON-decode cost. See
`docs/references/codex-app-server/event-catalog.md` triage table.

### 2.5 Thread / turn lifecycle mapping

| Today (SDK) | Tomorrow (app-server) |
|---|---|
| `codex.startThread(opts)` | `thread/start` request with `ThreadStartParams` |
| `codex.resumeThread(id, opts)` | `thread/resume` request with `ThreadResumeParams` |
| `thread.runStreamed(prompt, {signal})` | `turn/start` request with `TurnStartParams.input = [{type:'text', text}]` (plus per-turn overrides — §4) |
| Abort signal | `turn/interrupt` request |
| `thread.id` | `ThreadStartedNotification.thread.id` (await once on session start) |

The `runTurn` outer wrapper (`apps/agent/src/ai/codexSdkProvider.ts:594-637`)
keeps the same shape. The provider:

1. `cb.startNewTurn(streamId)` + `cb.userMessage(prompt)` (unchanged).
2. Build `TurnStartParams` from cached overrides + this turn's pending
   overrides (§4).
3. Send `turn/start`. Receive immediate response (the new `Turn`
   skeleton). Stash `turn.id` for steer/interrupt correlation.
4. Block on the notification stream until `turn/completed` arrives.
   Each `item/*` notification feeds `cardAdapter`.
5. On abort: send `turn/interrupt` (with the `turn.id`), wait for
   `turn/completed { status: 'interrupted' }`, then `cb.systemMessage('User
   interrupted')` + `emitStreamEnd({interrupted: true})`.
6. `finally`: `await cb.persistCards()` + `cb.clearCards()` — UNCHANGED.

---

## 3. Schema strategy

### 3.1 Source of truth

The local `codex` CLI's `app-server generate-ts --out DIR` is the
authoritative TS schema for the codex version we're paired with. We do
**not** trust the upstream README to be in sync.

### 3.2 Vendoring decision

Vendor the **subset we actually consume** under
`apps/agent/src/ai/codexAppServer/schema/generated/` and check it in.
Two reasons:

1. Reproducible builds. CI doesn't have to install codex.
2. We can review schema diffs in PRs when bumping the codex pin.

A regenerate script lives at
`apps/agent/scripts/regen-codex-schema.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
codex app-server generate-ts --out /tmp/codex-schema.$$
# Copy only the subset we use (whitelist below) into apps/agent/src/ai/codexAppServer/schema/generated/
# Print a diff summary for review.
```

The whitelist is maintained in the script. Anything outside the
whitelist gets dropped — keeps the noise floor down.

This script is referenced from `apps/agent/package.json` as
`pnpm regen-codex-schema` and from `apps/agent/README.md`.

### 3.3 Pinning to a codex CLI version

`apps/agent/src/ai/codexAppServer/processManager.ts` checks the codex
version at process startup (`codex --version`) and warns / refuses if
it disagrees with the schema we vendored. The pin lives in a constant.
Mismatch is a config-warning, not a fatal — users may run a slightly
newer codex.

---

## 4. Per-turn override pipeline (the user's actual ask)

This is the headline feature. Today `setSessionConfig('model', 'gpt-5.4')`
on a running Codex session writes the pref but doesn't touch the
running Thread. With app-server we attach the override to the next
`turn/start`.

### 4.1 Storage

`apps/agent/src/ai/codexAppServer/overrideStore.ts`:

```ts
type StickyOverrides = {
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: AskForApproval;
  sandboxPolicy?: SandboxPolicy;
  permissionProfile?: PermissionProfile;
  // …other sticky-able fields if/when we expose them
};

class OverrideStore {
  private serverEffective: StickyOverrides = {};
  private pendingForNextTurn: StickyOverrides = {};

  // Called by SessionManager when setSessionConfig fires while session is busy or idle.
  // Always queues on `pendingForNextTurn`.
  enqueue(patch: Partial<StickyOverrides>): void;

  // Called by provider just before sending turn/start.
  // Returns the values to attach (only those that DIFFER from server-effective).
  // Records that those values will become the new server-effective once the
  // turn/start is acknowledged.
  drain(): StickyOverrides;

  // Called when turn/start succeeds (Turn object returned).
  // Promotes pending → effective.
  commit(applied: StickyOverrides): void;

  // Called on cold resume (thread/resume). Re-seeds effective from session prefs
  // so we know what NOT to send next turn (the resume already restored them).
  reseedFromResume(initial: StickyOverrides): void;
}
```

Why "only fields that differ": app-server's sticky semantics mean
omitting a field keeps the previous value. We never want to send a
field unnecessarily — keeps wire diffs reviewable.

### 4.2 SessionManager wiring

`apps/agent/src/ai/sessionManager.ts:288-330` `setSessionConfig`:

```ts
case 'model':
case 'reasoningEffort': {
  const session = this.sessions.get(sessionId);
  if (session?.provider.kind === 'codex-app-server') {
    session.provider.enqueueOverride({ [key]: normalize(key, value) });
  }
  await this.setPreferences({ ...current, [key]: value });
  break;
}
```

For `permissionMode` the existing `setPermissionLevel` path
(`sessionManager.ts:659-702`) gains a Codex-app-server branch:

```ts
if (session.provider.kind === 'codex-app-server') {
  // Translate the abstract PermissionLevel into the concrete v2 fields.
  session.provider.enqueueOverride({
    approvalPolicy: mapPermissionLevelToAppServer(level).approvalPolicy,
    permissionProfile: mapPermissionLevelToAppServer(level).permissionProfile,
  });
  // No control_request needed — app-server does this via turn/start.
} else if (session.provider.kind === 'claude-cli') {
  // Existing path: sendControlRequest('set_permission_mode', { mode })
}
```

The `mapPermissionLevelToAppServer` helper lives in
`codexAppServer/permissionMapping.ts`. It encapsulates the matrix
between Quicksave's existing 8 permission presets
(`sessionManager.ts:346-356`) and the v2 fields. This isolates the
codex-specific semantics to one file — a future Quicksave preset gets
mapped here, not scattered.

### 4.3 What if a turn is in flight?

User changes `model` mid-turn:

1. `enqueueOverride({ model })` succeeds immediately.
2. The current turn keeps running on the old model — there is no v2
   API to swap models mid-turn.
3. Next `turn/start` picks up the override.
4. PWA UI shows a "pending" state on the model selector until the next
   turn starts. (UI work tracked separately in
   `apps/pwa/src/components/AgentSettingsDrawer.tsx`.)

For users who want it applied **right now**: they can additionally
`turn/interrupt`, which forces the in-flight turn to terminate; the
next turn picks up the override. Don't make this implicit — surface it
as a "Apply now (interrupt current turn)" affordance in the UI.

### 4.4 Tests

`overrideStore.test.ts`:

- enqueue then drain returns the patch.
- enqueue same value as effective → drain returns empty.
- commit promotes pending; second drain returns empty.
- enqueue while previous pending unprocessed → merge (last write wins).

`provider.test.ts` (integration):

- enqueue model='X', send turn/start → mock RPC sees `params.model = 'X'`.
- second turn without enqueue → mock RPC's `turn/start` does NOT carry
  `model` (sticky behavior trusted, see catalog).
- `permissionMode` change → mock RPC sees correct `approvalPolicy` /
  `permissionProfile`.

---

## 5. Card adapter (v2 → StreamCardBuilder)

`cardAdapter.ts` is where the contract is preserved or broken. Its
signature mirrors `consumeCodexStream` from
`apps/agent/src/ai/codexSdkProvider.ts:243`:

```ts
async function consumeAppServerNotifications(
  rpc: RpcClient,
  cb: StreamCardBuilder,
  ctx: { threadId: string; turnId: string; streamId: string; cumulativeSeed: TokenSeed; … },
  callbacks: ProviderCallbacks,
): Promise<{ stopped: boolean }>;
```

### 5.1 Notification → builder method dispatch table

Source of truth for this table is
`docs/references/card-builder-contract.md` §8. Re-derived here for the
adapter file's dispatch switch (each row also gets a unit test in
`cardAdapter.test.ts`):

| v2 notification | Builder call |
|---|---|
| `thread/started` | `cb.updateSessionId(thread.id)`; resolve `onThreadStarted` once (R10 mitigation: ignore subsequent fires for same id) |
| `turn/started` | no-op |
| `turn/completed { status:'completed' }` | `flushText`; `cb.finalizeAssistantText`; emit success stream-end (token usage from `tokenAccounting`, see §5.2) |
| `turn/completed { status:'failed', error }` | as above with `success:false, error: error.codexErrorInfo + ': ' + error.message` |
| `turn/completed { status:'interrupted' }` | flush + finalize + `emitStreamEnd({interrupted:true})` (no extra system message — provider's interrupt path emits it) |
| `error` | `cb.systemMessage(error.message, 'error')`. Dedup keyed on `(threadId, turnId, codexErrorInfo, message)` for R3. |
| `warning` / `configWarning` / `deprecationNotice` | `cb.systemMessage(text, 'warning')` |
| `item/started { type:'agentMessage' }` | start text-buffering for `item.id` |
| `item/agentMessage/delta { itemId, delta }` | `bufferText(delta)` (150 ms debounce → `cb.assistantText`). **Deltas are append-only** (R4) — confirmed by event-catalog §Streaming deltas "Concatenate by `itemId`". No more cumulative slice math. |
| `item/completed { type:'agentMessage', text? }` | `flushText`; if final-text-not-yet-seen and `item.text` exists, emit residual delta; `cb.finalizeAssistantText` |
| `item/started { type:'reasoning' }` | start reasoning-buffering for `item.id` |
| `item/reasoning/summaryTextDelta { itemId, summaryIndex, delta }` | `cb.thinkingBlock(delta)` if non-empty |
| `item/reasoning/summaryPartAdded { itemId, summaryIndex }` | flush current reasoning buffer (boundary marker) |
| `item/reasoning/textDelta { itemId, contentIndex, delta }` | `cb.thinkingBlock(delta)` |
| `item/started { type:'commandExecution', command }` | `flushText`; `cb.toolUse('Bash', { command }, item.id)` |
| `item/commandExecution/outputDelta { itemId, stream, chunk }` | append chunk to per-item buffer; emit `cb.toolResult(itemId, accumulated, false)` (R5 — buffer-then-overwrite preserves cardBuilder API) |
| `item/completed { type:'commandExecution', exit_code, status, aggregated_output? }` | `cb.toolUse(...)` if missing; `cb.toolResult(id, accumulated + '\n[exit code: N]', status==='failed')` |
| `item/started { type:'fileChange', changes }` | `flushText`; for each change, `cb.toolUse('Edit'\|'Write', { file_path }, derivedId)` (preserve `${id}#${i}` scheme — R6) |
| `item/fileChange/patchUpdated` | (optional) update tool-call input with parsed patch — initially **drop** to keep parity with SDK. |
| `item/fileChange/outputDelta` | append to per-item result buffer |
| `item/completed { type:'fileChange', changes, status }` | `emitFileChangeCards(..., emitResult: true)` (preserve `codexSdkProvider.ts:108` semantics) |
| `item/started/completed { type:'mcpToolCall' }` | `cb.toolUse('${server}:${tool}', args, id)`; on completed `cb.toolResult(id, resultText, failed)` |
| `item/mcpToolCall/progress` | (optional) update tool-call input — initially **drop** to keep parity |
| `item/started/completed { type:'webSearch', query }` | `cb.toolUse('WebSearch', { query }, id)` + result `'Search: ${query}'` (preserve R9 placeholder until v2 ships real results) |
| `item/started/completed { type:'plan' }` and `item/plan/delta` | **defer** — see R2. Initial migration: render `plan` items as `cb.toolUse('TodoWrite', { todos }, id)` if and only if the payload is shape-compatible; otherwise fall through to the unknown-block path (`cb.systemMessage('[plan] preview', 'info')`). Decide concretely once `plan` payload schema is read. |
| `item/started/completed { type:'contextCompaction' }` | `cb.systemMessage('Context compacted', 'compacted')` |
| `serverRequest/resolved { requestId }` | `cb.clearPendingInput(requestId)` (R7 — does NOT trigger stream-end) |
| `thread/tokenUsage/updated` | feed `tokenAccounting.observeCumulative(usage)` — does not emit a card directly (R1) |
| `thread/closed`, `thread/status/changed`, `thread/name/updated`, etc. | route to session-list store, NOT the card builder |
| Approval requests (server→client *requests*, not notifications) | bridge to `callbacks.handlePermissionRequest` — see §5.3 |

Anything not in this table goes to a `defaultHandler` which logs at
debug level and is otherwise a no-op. The handler bumps a per-session
counter so we can audit "unknown notification" rates in dogfooding.

### 5.2 Token accounting (R1)

`tokenAccounting.ts` owns the per-turn delta computation that
`codexSdkProvider.ts:259-283` does today inline.

```ts
class TokenAccounting {
  private cumulative = { input: 0, output: 0, cachedInput: 0 };

  // From eventStore on cold resume.
  seedFromLastTurn(seed: TokenSeed): void;

  // Fired by thread/tokenUsage/updated.
  observeCumulative(usage: ThreadTokenUsage): void;

  // Fired at turn/completed. Computes delta = current - cumulative_at_turn_start,
  // updates cumulative_at_turn_start to current, returns the per-turn delta
  // PLUS the cumulative for CardStreamEnd.tokenUsage.
  closeTurn(): { delta: PerTurnUsage; cumulative: CumulativeUsage };
}
```

Behavior:

- Resume case: `thread/tokenUsage/updated` fires after `thread/resume`
  with the persisted cumulative. We seed `cumulative` from
  `LastTurnInfo.cumulativeInputTokens` (existing code) and ignore the
  re-fire (its value should match — assert with a warning if not).
- Mid-turn `thread/tokenUsage/updated` may fire too. Update the running
  cumulative; the delta is computed against the start-of-turn snapshot
  taken at `turn/started` time.
- Pin with regression test mirroring
  `codexSdkProvider.test.ts:705-733`.

### 5.3 Approval bridge (R3 + R7)

The two surfaces that today merge into "permission request" split:

- **Server-initiated requests** (live in `ServerRequest.ts`, NOT the
  notification catalog): `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  MCP elicitation, dynamic tool-call request. These are JSON-RPC
  *requests* — server expects a response. The provider routes them
  into `callbacks.handlePermissionRequest` (existing path) and the
  response goes back as a JSON-RPC response.
- **Resolution notifications:** `serverRequest/resolved` fires after
  the client responds **and** when the turn ends and clears pending
  approvals. Drives `cb.clearPendingInput`.

The error dedup strategy for R3:

```ts
const seenErrors = new Set<string>();
function emitErrorOnce(notification: ErrorNotification, ctx: TurnCtx) {
  const key = `${ctx.threadId}|${ctx.turnId}|${notification.error.codexErrorInfo ?? 'na'}|${notification.error.message}`;
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  cb.systemMessage(notification.error.message, 'error');
}
// seenErrors is reset at startNewTurn.
```

Same pattern as `emitErrorItemOnce` (`codexSdkProvider.ts:164-173`)
but keyed on the v2 surface. Pin with the exact regression test from
the contract doc R3 mitigation.

### 5.4 Out-of-order tolerance

The SDK delivered events through an async iterator in arrival order.
JSON-RPC notifications interleave on stdout the same way. We DO NOT
introduce a queue/buffer that could reorder events — preserves I1.

The one exception: `item/agentMessage/delta` for `itemId` X may
arrive before `item/started` for X if the server batches. The adapter
must tolerate this — start a fresh buffer on first reference,
reconcile when `item/started` arrives. Add a regression test.

---

## 6. Risk-by-risk mitigation tracking

These map 1:1 to `docs/references/card-builder-contract.md` §9. Each
risk gets a tracked test in the new test suite.

| Risk | Mitigation owner | Test file |
|---|---|---|
| R1 — Per-turn token usage regression | `tokenAccounting.ts` + cold-resume reseed | `tokenAccounting.test.ts` |
| R2 — `plan` vs `todo_list` mismatch | `cardAdapter.ts` plan handler — start with fall-through; iterate after dogfood | `cardAdapter.todoList.test.ts` |
| R3 — `ErrorItem` deduping on v2 surfaces | `cardAdapter.ts` `emitErrorOnce` keyed on v2 fields | `cardAdapter.errors.test.ts` |
| R4 — agentMessage delta shape | `cardAdapter.ts` — `bufferText(notification.delta)` directly, no slice math | `cardAdapter.agentMessage.test.ts` |
| R5 — command output cumulative→chunks | per-item accumulator buffer in `cardAdapter.ts` (NOT in cardBuilder) | `cardAdapter.commandExec.test.ts` |
| R6 — Item id namespacing | preserved via existing `cb.persistCards()` + `cb.clearCards()` in `runTurn`'s `finally` | covered by integration tests |
| R7 — Multiple "turn done" signals | only `turn/completed` calls `emitStreamEnd`; `serverRequest/resolved` calls `clearPendingInput` only | `cardAdapter.serverRequestResolved.test.ts` |
| R8 — Aggregated diff vs per-file (architectural) | not adopted in this migration (N1) | n/a |
| R9 — webSearch placeholder | preserved synthetic result | covered by parity test |
| R10 — `thread/started` re-fire | guard `onThreadStarted` resolved-flag exists; assert id stability | `provider.threadLifecycle.test.ts` |
| R11 — persistCards shape divergence | no shape changes; covered by red lines | covered by `cardBuilder.test.ts` (unchanged) |
| R12 — empty-delta filter on reasoning | preserved via the `delta.trim()` filter in adapter | covered by parity test |

---

## 7. Phase plan

Five gated phases. Each has explicit exit criteria. Don't move on until
the previous phase's criteria are satisfied.

### Phase 1 — Skeleton + RPC client (1-2 days)

Deliver: a JSON-RPC client that can spawn `codex app-server`, send
`initialize` + `thread/start`, receive `thread/started`, gracefully
shut down. No card builder integration yet.

- `processManager.ts`, `rpcClient.ts`, `schema/generated/` (whitelist
  subset), `regen-codex-schema.sh`.
- Unit tests with a fake child process (Node `child_process` mocked
  via `unstub`).
- `provider.ts` skeleton implementing `CodingAgentProvider` but
  throwing on `startSession` (placeholder).

**Exit criteria**

- E1.1. `pnpm regen-codex-schema && pnpm test` green (codex CLI
  required for regen).
- E1.2. Manual smoke: `npx tsx scripts/smoke-app-server.ts` starts a
  real `codex app-server`, runs `initialize`, exits cleanly.
- E1.3. `tsc --noEmit` green for `apps/agent`.

### Phase 2 — Read-only adapter (3-5 days)

Deliver: a working `CodexAppServerProvider` whose `startSession` /
`runTurn` produce **identical card output** to `CodexSdkProvider` for
every scenario in `codexSdkProvider.test.ts`.

- `cardAdapter.ts`, `tokenAccounting.ts`, `provider.ts` `runTurn`
  implementation.
- New test file `cardAdapter.test.ts` with one `describe` block per
  v2 notification type, mirroring the structure of
  `codexSdkProvider.test.ts`.
- Integration test `provider.parity.test.ts` that constructs a
  scripted notification stream covering every scenario in
  `codexSdkProvider.test.ts` and asserts identical `CardEvent[]`
  output to a sibling instance of `CodexSdkProvider` running on a
  scripted SDK stream.

**Exit criteria**

- E2.1. `provider.parity.test.ts` passes for every scenario.
- E2.2. Token accounting tests pin both fresh-session and
  cold-resume paths.
- E2.3. `cb.persistCards()` writes payload identical to the
  SDK-provider path (byte-for-byte assert via fixtures).
- E2.4. Manual smoke against a real codex: send a "Run tests"
  prompt and a "Read this file" prompt, eyeball cards in dev PWA.

### Phase 3 — Per-turn override pipeline (1-2 days)

Deliver: `setSessionConfig('model'|'reasoningEffort'|'permissionMode')`
applies to the next turn/start without restarting the thread.

- `overrideStore.ts`, `permissionMapping.ts`, sessionManager wiring.
- Update `apps/pwa/src/components/AgentSettingsDrawer.tsx` to
  surface the "applies on next turn" hint when changing while
  streaming. **UI work strictly limited** to copy + a small "pending"
  badge — no structural changes to the drawer.

**Exit criteria**

- E3.1. Override store tests in §4.4 pass.
- E3.2. End-to-end test: start a session, send a turn, mid-stream
  call `setSessionConfig`, send another turn, RPC mock confirms
  `turn/start` carries the overrides on turn 2 and not on turn 3
  (sticky).
- E3.3. Manual smoke: change model in PWA, observe next turn uses
  it.

### Phase 4 — Feature-flag rollout (1 day, then dogfood)

Deliver: `codexBackend: 'app-server'` opt-in via session config or
user pref. Default remains `'sdk'`. Both providers exercised in CI.

- `defaults.ts` adds `codexBackend: 'sdk'` default.
- `messageHandler.ts` `setSessionConfig` accepts the new key.
- PWA settings UI exposes a toggle (developer-mode / hidden from
  general users until Phase 5).
- CI matrix runs `provider.parity.test.ts` against both backends.

**Exit criteria**

- E4.1. Existing `codexSdkProvider.test.ts` still green.
- E4.2. Dogfood for at least 1 release cycle by team — log "unknown
  notification" counts; investigate any non-zero.
- E4.3. No card-builder regressions reported.

### Phase 5 — Default flip + cleanup (1 release after Phase 4)

- Flip `defaults.ts` default to `'app-server'`.
- One release later: delete `CodexSdkProvider`, `codexSdkProvider.ts`,
  `codexSdkProvider.test.ts`, drop `@openai/codex-sdk` from
  `apps/agent/package.json`.
- Update `docs/references/quicksave-architecture.md` §二 (Codex
  provider section).

**Exit criteria**

- E5.1. No fallback to SDK provider in code paths.
- E5.2. Architecture doc reflects new structure.
- E5.3. Dependency removed from lockfile.

---

## 8. Test strategy

### 8.1 Regression net (the safety harness)

The single most important rule: **`codexSdkProvider.test.ts` stays
green throughout Phases 1-4.** It pins the SDK provider's contract;
since that contract IS the card-builder contract for Codex, it's the
oracle for the new provider too.

Mirror it as `provider.parity.test.ts` — same scenario list, same
assertions on `CardEvent[]`, but the input is a scripted v2
notification stream instead of a scripted SDK event stream. Use
fixtures shared between both files via a small `fixtures/codex-scenarios.ts`
that defines the SCENARIO list once and lets each test produce its own
input.

### 8.2 Card-builder tests are off-limits for modification

`apps/agent/src/ai/cardBuilder.test.ts` and
`cardBuilder.edge.test.ts` capture the contract that must NOT change.
If a test in there fails during the migration, the migration is wrong
— do NOT change the test.

### 8.3 New test files

| File | Purpose |
|---|---|
| `codexAppServer/rpcClient.test.ts` | request/response correlation, notification dispatch, backpressure (`-32001`), graceful shutdown |
| `codexAppServer/processManager.test.ts` | spawn/kill, stderr piping, version mismatch warning, crash → restart |
| `codexAppServer/cardAdapter.test.ts` | per-notification → builder-call mappings (one describe per v2 method) |
| `codexAppServer/cardAdapter.errors.test.ts` | R3 dedup |
| `codexAppServer/cardAdapter.agentMessage.test.ts` | R4 — chunked deltas |
| `codexAppServer/cardAdapter.commandExec.test.ts` | R5 — output buffering |
| `codexAppServer/cardAdapter.serverRequestResolved.test.ts` | R7 — pending dismissal |
| `codexAppServer/tokenAccounting.test.ts` | R1 — fresh, mid-turn, resume |
| `codexAppServer/overrideStore.test.ts` | §4.4 |
| `codexAppServer/provider.threadLifecycle.test.ts` | R10, thread/started, thread/closed |
| `codexAppServer/provider.parity.test.ts` | full scenario parity vs SDK provider |
| `codexAppServer/provider.permissionMapping.test.ts` | mapping matrix from `PermissionLevel` to v2 fields |

### 8.4 Card-builder change rule

If any phase concludes the cardBuilder API needs a new method (the
likely candidate is `toolResultAppend(id, chunk)` for R5 — though §5.1
keeps a buffer in the adapter and avoids it), the rule is:

1. Add the method **additively**, never modify existing methods.
2. Add new tests in `cardBuilder.test.ts` covering the new method.
3. Existing tests must still pass with zero diff.
4. Update `docs/references/card-builder-contract.md` §4.1 in the same
   commit.

---

## 9. Rollback plan

- Phase 1-3: disable by reverting the PR. No production risk; flag
  defaults to `'sdk'` until Phase 5.
- Phase 4 (after default flip): rollback path is to flip
  `defaults.ts` back to `'sdk'`. SDK provider still in tree until
  Phase 5.
- Phase 5: SDK provider removed. Rollback requires re-adding the
  dependency and the file. Don't ship Phase 5 until at least one full
  release of Phase 4 default has shipped without regressions.

---

## 10. Files touched (summary)

### Added

```
apps/agent/scripts/regen-codex-schema.sh
apps/agent/src/ai/codexAppServer/index.ts
apps/agent/src/ai/codexAppServer/provider.ts
apps/agent/src/ai/codexAppServer/processManager.ts
apps/agent/src/ai/codexAppServer/rpcClient.ts
apps/agent/src/ai/codexAppServer/cardAdapter.ts
apps/agent/src/ai/codexAppServer/tokenAccounting.ts
apps/agent/src/ai/codexAppServer/overrideStore.ts
apps/agent/src/ai/codexAppServer/permissionMapping.ts
apps/agent/src/ai/codexAppServer/schema/index.ts
apps/agent/src/ai/codexAppServer/schema/generated/*.ts  (vendored subset)
apps/agent/src/ai/codexAppServer/*.test.ts              (per §8.3)
apps/agent/src/ai/codexAppServer/fixtures/codex-scenarios.ts
```

### Modified (additive only — no removals before Phase 5)

```
apps/agent/package.json                    # regen-codex-schema script
apps/agent/src/ai/sessionManager.ts        # codex-app-server branch in setSessionConfig + setPermissionLevel
apps/agent/src/handlers/messageHandler.ts  # setSessionConfig accepts codexBackend key
apps/agent/src/service/run.ts              # provider factory branches on codexBackend
apps/pwa/src/components/AgentSettingsDrawer.tsx  # "pending" badge + copy when changing mid-stream (Phase 3)
apps/pwa/src/components/settings/ClaudeSettingsSection.tsx  # if a Codex backend toggle lands here
packages/shared/src/types.ts               # CodexBackend type, SessionConfig key
packages/shared/src/defaults.ts            # codexBackend default
docs/references/quicksave-architecture.md  # §二 Codex provider description (Phase 5)
apps/agent/README.md                       # regen-codex-schema doc
```

### Deleted (only in Phase 5)

```
apps/agent/src/ai/codexSdkProvider.ts
apps/agent/src/ai/codexSdkProvider.test.ts
@openai/codex-sdk dependency
```

---

## 11. Open questions — resolved 2026-04-26

Re-derived from a fresh `codex app-server generate-ts --out` against
CLI 0.125.0. Authoritative file paths are
`v2/<TypeName>.ts` from the generated bundle. All four Phase-2
blockers are now answered.

### Q1. Per-turn token usage on `turn/completed`?

**No.** `v2/TurnCompletedNotification = { threadId, turn: Turn }`. The
nested `Turn` does NOT carry usage — its fields are `id`, `items`,
`status: TurnStatus`, `error`, `startedAt`, `completedAt`, `durationMs`.

**But:** `v2/ThreadTokenUsageUpdatedNotification = { threadId, turnId,
tokenUsage: ThreadTokenUsage }` carries `turnId` AND
`tokenUsage = { total: TokenUsageBreakdown, last: TokenUsageBreakdown,
modelContextWindow: number | null }`.

**This is BETTER than the SDK path.** `last` is the per-turn delta
the server already computed. We don't subtract anything ourselves.
- `CardStreamEnd.tokenUsage.{input, output}` ← `last.input_tokens` /
  `last.output_tokens` (read `TokenUsageBreakdown.ts` for exact field
  names — likely camelCase per ts-rs convention).
- `CardStreamEnd.tokenUsage.{cumulativeInput, cumulativeOutput,
  cumulativeCachedInput}` ← `total.*`.
- The eventStore `LastTurnInfo.cumulativeInputTokens` round-trip is
  still needed because `total` reflects the running cumulative which
  must persist across daemon restarts.

**Mitigation impact for R1:** the §5.1 entry stays "feed
`tokenAccounting.observeCumulative(usage)`", but the implementation
becomes a thin shim: cache the latest `tokenUsage` keyed by `turnId`,
emit it at `turn/completed` time without delta math.

**Ordering concern:** if `thread/tokenUsage/updated` arrives AFTER
`turn/completed` for the same turn, we must wait. The adapter must
not finalize the stream-end until both fire (or a short timeout
elapses; default to emitting with whatever we have). Pin in
`tokenAccounting.test.ts` with both interleavings.

### Q2. `item/agentMessage/delta` shape — cumulative or chunked?

**Chunked.** `v2/AgentMessageDeltaNotification = { threadId, turnId,
itemId, delta: string }`. `delta` is the chunk; concatenate by
`itemId`. R4 mitigation is: drop `takeAssistantDelta` slice math
entirely; just call `bufferText(notification.delta)`.

Same shape applies to:
- `v2/CommandExecutionOutputDeltaNotification = { threadId, turnId,
  itemId, delta: string }` (R5).
- `v2/PlanDeltaNotification = { threadId, turnId, itemId, delta }`
  (experimental — comment explicitly warns "Clients should not assume
  concatenated deltas match the completed plan item content"; we
  IGNORE this and rely on `item/completed`'s final text).
- Reasoning deltas are slightly richer (have `summaryIndex` /
  `contentIndex`); see `ReasoningSummaryTextDeltaNotification.ts` and
  `ReasoningTextDeltaNotification.ts` if needed.

### Q3. Plan item — replacement for `TodoListItem`?

**Two surfaces, neither is a 1:1 replacement, but turn-level wins.**

- `ThreadItem` has `{ "type": "plan", id, text }` — **plain text only,
  no structured array**. The accompanying `PlanDeltaNotification`
  ships raw text deltas marked experimental.
- `TurnPlanUpdatedNotification = { threadId, turnId, explanation,
  plan: TurnPlanStep[] }` where `TurnPlanStep = { step: string, status:
  'pending' | 'inProgress' | 'completed' }`. **This is the structured
  to-do.**

**Decision:** map `turn/plan/updated` → a synthetic `TodoWrite`
`tool_call` card. Synthesize a stable toolUseId from
`(threadId, turnId)` (e.g. `plan:${turnId}`) so subsequent updates
patch the same card. The `explanation` field becomes a `system info`
banner if non-null. Drop the `plan` ThreadItem to the unknown-block
fallback (`cb.systemMessage('[plan] preview', 'info')`) initially —
revisit if users surface complaints.

**Status mapping:** TurnPlanStepStatus → ClaudeTodoStatus =
{`pending` → `pending`, `inProgress` → `in_progress`, `completed` →
`completed`}.

**Mitigation impact for R2:** §5.1 dispatch table is updated below.

### Q4. `commandExecution/outputDelta` chunk field?

**`delta: string`.** No stdout/stderr distinction at the v2 layer —
both interleave as `delta`. Buffer per `itemId`, emit
`cb.toolResult(itemId, accumulated, false)` after each chunk. Final
`item/completed` for `commandExecution` carries `aggregatedOutput`,
`exitCode`, `status` — emit one final `cb.toolResult(id, accumulated +
'\n[exit code: N]', status==='failed')`.

### Bonus findings (not in original Q list)

- **`UserInput.text` requires `text_elements: Array<TextElement>`.**
  Empty array is fine (`[]`). The provider sends `{ type: 'text', text,
  text_elements: [] }` for plain prompts.
- **`TurnInterruptParams = { threadId, turnId }`** and
  `TurnInterruptResponse = Record<string, never>` — empty ack.
- **`ServerRequestResolvedNotification = { threadId, requestId }`** —
  `requestId` is the ID of the original server→client request, drives
  `cb.clearPendingInput(requestId.toString())`.
- **`ErrorNotification = { error: TurnError, willRetry, threadId,
  turnId }`** — has `willRetry` hint we can use to suppress duplicate
  cards if the server is going to retry transparently.
- **`TurnError = { message, codexErrorInfo, additionalDetails }`** —
  use all three when surfacing error messages.
- **`ThreadStartResponse`** returns the resolved view (model,
  reasoningEffort, sandbox, permissionProfile, approvalPolicy,
  approvalsReviewer) — seed `OverrideStore.serverEffective` from this
  after `thread/start` and `thread/resume`.
- **`InitializeResponse`** carries only environment metadata
  (userAgent, codexHome, platformFamily, platformOs) — NOT server
  capabilities. Capability negotiation flows up: client declares
  `experimentalApi` and `optOutNotificationMethods` in
  `InitializeParams.capabilities`.
- **`ClientNotification = { method: 'initialized' }`** — MCP-style
  ready handshake. Send after `initialize` request resolves, before
  any other request.
- **`RequestId = string | number`** — top-level type; we use
  monotonically-increasing numbers.
- **`AgentMessageItem`** has `phase: MessagePhase | null` and
  `memoryCitation: MemoryCitation | null` extra fields — we ignore
  both initially.
- **`ThreadItem` does NOT include `errorItem`.** Errors arrive only
  via the `error` ServerNotification or `turn/completed { status:
  'failed' }`. R3 mitigation is now grounded.
- **`ThreadItem` does NOT include `webSearch` results** — only
  `query` + optional `action: WebSearchAction | null`. Synthetic
  placeholder result (R9) preserved.

### Updated §5.1 dispatch-table corrections

| v2 notification | Builder call (corrected) |
|---|---|
| `turn/completed` | flush + finalize + emit stream-end with `tokenUsage` from cached `ThreadTokenUsageUpdatedNotification` for this `turnId`. If not yet received, wait up to ~250 ms. |
| `thread/tokenUsage/updated` | cache by `turnId`; if `turnId === currentTurnId` and we're already in the post-`turn/completed` wait, immediately resume stream-end emission. |
| `item/agentMessage/delta` | `bufferText(notification.delta)` — no slice math. |
| `item/commandExecution/outputDelta` | `commandOutputBuffers.append(itemId, delta)`; emit `cb.toolResult(itemId, accumulated, false)`. |
| `turn/plan/updated` | `cb.toolUse('TodoWrite', { todos: plan.map(stepToTodo) }, 'plan:${turnId}')`. If `explanation` non-null, prepend a `cb.systemMessage(explanation, 'info')` (deduped against the previous turn's explanation by content). |
| `item/started/completed` `{ type: 'plan' }` | `cb.systemMessage('[plan] preview', 'info')` fallback (initial). |
| `item/plan/delta` | ignore (per upstream warning). |
| `serverRequest/resolved` | `cb.clearPendingInput(requestId.toString())` ONLY. Never emits stream-end (R7). |
| `error` | `cb.systemMessage(error.message, 'error')`. Dedup keyed on `(threadId, turnId, error.codexErrorInfo, error.message)`. If `willRetry === true`, suppress (server is retrying transparently — only surface if retry exhausts). |

**Phase 2 unblocked.** Other risks (R6, R8-R12) unchanged — see §6.

---

## 12. Approval

Migration is gated by:

- This plan reviewed.
- Phase 1 PR merged (cheap; pure additive infrastructure).
- Phase 2 starts only after the four open questions in §11 are
  resolved on paper.

Card-builder contract preservation is non-negotiable. If any phase
threatens a red line in §0, stop and renegotiate the plan rather than
the contract.
