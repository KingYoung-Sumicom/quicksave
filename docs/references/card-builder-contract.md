# Card Builder Contract

> Source verified against the working tree at HEAD on `main` (CLI-deps:
> `@openai/codex-sdk@0.125.0`, `claude` CLI consumed via stdio stream-json
> protocol). All file:line citations point at the unmodified files in
> `apps/agent/src/ai/`, `packages/shared/src/`, etc.

## 1. Purpose

The **card builder** is the agent-side adapter that turns a coding-agent
provider's per-turn event stream into a flat, ordered, monotone sequence of
**Cards** consumed by the PWA chat UI. It owns three responsibilities:

1. **Aggregation** of streaming text deltas, partial tool calls, and tool
   results into stable card objects keyed by a synthetic `CardId`.
2. **Pairing** of provider-side ids (`tool_use_id`, `agentId`,
   `requestId`) to the cards they refer to so later updates land on the
   right object.
3. **Persistence + history bridging** — for "memory-mode" providers
   (Codex) it persists finalized turns to disk so they survive reconnect;
   for "claude-jsonl" mode it reconciles in-memory streaming cards against
   the CLI's authoritative `.jsonl` history file.

The card stream — the ordered series of `CardEvent`s emitted to the bus
topic `/sessions/:sessionId/cards` — is the **provider-agnostic interface
the PWA rendering code is written against**. The migration from
`@openai/codex-sdk` (Thread API) to `codex app-server` (JSON-RPC v2)
**must not change the shape, ordering, or invariants of the card stream**.
This document pins that contract.

---

## 2. File map

| File | One-liner | Exports / key symbols |
|------|-----------|-----------------------|
| `packages/shared/src/cards.ts` | Wire types: `Card`, `CardEvent`, `CardStreamEnd`, `CardHistoryResponse`, `SessionCardsUpdate`, `PendingInputAttachment`. The whole agent↔PWA card protocol surface. | `CardId`, `Card` union, `CardEvent` union, `CardStreamEnd`, `CardHistoryResponse`, `SessionCardsUpdate`, `PendingInputAttachment`, `PendingInputWithContext` |
| `packages/shared/src/types.ts` | Re-exports above; defines `AgentId` and other shared types. | `AgentId`, etc. |
| `apps/agent/src/ai/cardBuilder.ts` | The card builder itself. `StreamCardBuilder` is the per-session accumulator; `buildCardsFromHistory` reconstructs a `Card[]` from Claude CLI's session JSONL; `loadPersistedCards` reads memory-mode persistence. | `StreamCardBuilder` (class), `buildCardsFromHistory()`, `loadPersistedCards()` |
| `apps/agent/src/ai/provider.ts` | Provider interface boundary. Defines `ProviderCallbacks` (the only legal channel a provider may use to feed the card builder) and `CodingAgentProvider`. | `CodingAgentProvider`, `ProviderSession`, `ProviderCallbacks`, `StartSessionOpts`, `ResumeSessionOpts`, `PermissionLevel`, `ProviderHistoryMode` |
| `apps/agent/src/ai/codexSdkProvider.ts` | Current Codex provider — adapts `@openai/codex-sdk` `ThreadEvent`s into card-builder calls via `consumeCodexStream()`. **The file the migration replaces.** | `CodexSdkProvider`, `consumeCodexStream` (`@internal`, exported for tests) |
| `apps/agent/src/ai/claudeCliProvider.ts` | Claude provider — parses the CLI's stream-json line protocol and drives the same card builder. | `ClaudeCliProvider`, `buildClaudeCliArgs`, `getClaudeBin` |
| `apps/agent/src/ai/sessionManager.ts` | Owns the per-session `StreamCardBuilder`, wires `ProviderCallbacks` (`makeCallbacks`), persists `card-event` and `card-stream-end` to the bus, drives permission flow that emits `toolCallFromPermission` / `clearPendingInput` / `setToolAnswers`. | `SessionManager`, `makeCallbacks`, `getCards` |
| `apps/agent/src/storage/eventStore.ts` | Append-only SQLite log of `prompt_sent` / `turn_ended` / `permission_*` events. Codex-only `cumulativeInputTokens` is round-tripped through `LastTurnInfo` so cold-resume can seed the running cumulative-usage snapshot. | `EventStore`, `LastTurnInfo`, `getEventStore()` |
| `apps/agent/src/service/run.ts` | Daemon glue. Subscribes to `card-event`/`card-stream-end` from the SessionManager and republishes onto the message bus topic `/sessions/:sessionId/cards`. Records `turn_ended` events. | `claudeService.on('card-event', …)` lines 270–280; `card-stream-end` handler 276–357 |
| `apps/agent/src/ai/cardBuilder.test.ts` | Unit tests for `StreamCardBuilder`, `loadPersistedCards`, `buildCardsFromHistory`. | (tests) |
| `apps/agent/src/ai/cardBuilder.edge.test.ts` | Adversarial edge cases — rapid streaming, ID uniqueness, permission lifecycle, persistence corner cases. | (tests) |
| `apps/agent/src/ai/codexSdkProvider.test.ts` | Pins the `consumeCodexStream` event-to-card mapping. **The primary regression net for the migration.** | (tests) |
| `apps/agent/src/ai/edgeCases.test.ts` | `StreamCardBuilder.scheduleDeferredClear` polling/cancel state machine. | (tests) |
| `apps/agent/src/ai/sessionManager.test.ts` | End-to-end: callbacks → emit → persistence. | (tests) |

---

## 3. Card type catalog

All defined in `packages/shared/src/cards.ts`. Every variant extends
`CardBase`:

```ts
// cards.ts:34–39
export interface CardBase {
  id: CardId;                                // "${sessionId}:${seq}" or "${sessionId}:h:${seq}" for history
  timestamp: number;                         // Date.now() at emission
  pendingInput?: PendingInputAttachment;     // permission/question prompt (agent-attached overlay)
}
```

Variants:

| Type | Definition (cards.ts) | Semantics |
|------|----------------------|-----------|
| `user` | 43–46 | A user prompt. `text: string`. |
| `assistant_text` | 48–53 | Streaming or finalized assistant prose. `text` accumulates via `append_text` events; `streaming?: boolean` flips false on finalize. |
| `thinking` | 55–58 | Reasoning trace. Plain `text`. Codex reasoning summary AND raw reasoning AND Claude `thinking` blocks all funnel here. |
| `tool_call` | 60–73 | A tool invocation. Carries `toolName`, `toolInput`, `toolUseId`, optional `result: ToolCallResult`, optional `answers: Record<string,string>` (AskUserQuestion only). `pendingInput` carries a permission/question UI prompt while pending. |
| `subagent` | 81–92 | A child Agent invocation (Claude only today). `description`, `agentId`, `toolUseId`, `status: 'running' \| 'completed' \| 'failed' \| 'stopped'`, `summary?`, `toolUseCount`, `lastToolName?`. |
| `system` | 96–100 | Banners. `text` + `subtype: 'compacted' \| 'cost' \| 'error' \| 'info' \| 'warning'`. Used for compaction notices, errors, "User interrupted", unknown-block fallbacks. |

`ToolCallResult` shape (cards.ts:75–79):
```ts
{ content: string; isError: boolean; truncated: boolean }
```

The `Card` discriminated union is the closed set; nothing else may be
emitted. (cards.ts:102–108)

### CardEvent (the wire payload)

```ts
// cards.ts:110–152
type CardEvent =
  | { type: 'add';         sessionId; card: Card; afterCardId?: CardId }
  | { type: 'update';      sessionId; cardId; patch: Record<string, unknown> }
  | { type: 'append_text'; sessionId; cardId; text: string }
  | { type: 'remove';      sessionId; cardId };
```

**Wire convention** (cards.ts:128–134, cardBuilder.ts:386–393): in an
`update.patch`, a `null` value means "delete this key". `JSON.stringify`
drops `undefined`, so `null` is the only sentinel that survives the bus
hop. Receivers must `delete` null-valued keys after merging.

### CardStreamEnd

```ts
// cards.ts:190–212
{
  sessionId; success;
  error?; interrupted?;
  totalCostUsd?;
  tokenUsage?: {
    input; output;
    cacheCreation?; cacheRead?;            // Claude only
    cumulativeInput?; cumulativeOutput?;   // Codex only — thread-cumulative
    cumulativeCachedInput?;                // Codex only
  };
}
```

`SessionCardsUpdate` (cards.ts:184–186) is the bus-topic envelope:
either `{ kind: 'card', event: CardEvent }` or
`{ kind: 'stream-end', result: CardStreamEnd }`.

---

## 4. Provider event inputs

The card builder is fed exclusively through `StreamCardBuilder`'s public
methods (cardBuilder.ts:412–608). Both providers convert their respective
event streams into these calls.

### 4.1. `StreamCardBuilder` public mutating API

Listed in source order; each returns a `CardEvent` (or `null`) which the
provider must forward to `callbacks.emitCardEvent()`.

| Method | Signature | Card effect | Notes |
|--------|-----------|-------------|-------|
| `userMessage(text)` | cardBuilder.ts:412 | Adds a `user` card. Resets `currentTextCardId`. | The Claude provider calls this on `--replay-user-messages` echo too, but does NOT emit it (cliProvider.ts:481–484). |
| `thinkingBlock(text)` | 418 | Adds a `thinking` card. | Each call is a fresh card; thinking does NOT stream-coalesce the way text does. |
| `assistantText(text)` | 428 | First call adds an `assistant_text` card with `streaming: true`. Subsequent calls return `append_text` events on the same card. | Coalesce continues until any non-text mutation resets `currentTextCardId`. |
| `finalizeAssistantText()` | 439 | `update { streaming: false }` on current text card; null otherwise. | Idempotent on null path: returns `null` after first call. |
| `toolUse(name, input, id)` | 451 | `add` of a `tool_call`; OR `update { toolInput }` if the toolUseId already had a card from `toolCallFromPermission`. | Same call is used for "create card" and "patch input" — keyed on `toolUseIdToCardId`. |
| `toolCallFromPermission(name, input, id, pending, ephemeral?)` | 474 | `add` (with `pendingInput`) OR `update { pendingInput }` if `toolUse` already created the card. `ephemeral` marks for removal on resolve. | Driven by SessionManager (handlePermissionRequest), not the provider stream. |
| `toolResult(id, content, isError)` | 543 | `update { result }`; null if no matching `tool_call`. Truncates content > 500 chars and sets `truncated: true`. |
| `setToolAnswers(id, answers)` | 556 | `update { answers }` on `tool_call`. | Used only for AskUserQuestion. |
| `attachPendingToSubagent(agentId, pending)` | 503 | `update { pendingInput }` on the `subagent` card. |
| `clearPendingInput(requestId)` | 510 | `update { pendingInput: null }`, OR `remove` if ephemeral; null if no match. |
| `subagentStart(desc, agentId, toolUseId?)` | 562 | Adds a `subagent` card; positions `afterCardId = toolUseId's card`. |
| `subagentProgress(agentId, toolUseId?, count?, lastTool?)` | 579 | `update { toolUseCount, lastToolName }`. |
| `subagentEnd(agentId, toolUseId?, status, summary?)` | 589 | `update { status, summary }`. |
| `systemMessage(text, subtype?)` | 601 | Adds a `system` card. |
| `errorMessage(text)` | 606 | `systemMessage('Error: ' + text, 'error')`. |

Lifecycle methods (no card effect, but mutate state used by the above):

| Method | Effect |
|--------|--------|
| `updateSessionId(sid)` (236) | Rewrites the sessionId baked into freshly-minted CardIds and event envelopes. Called when Codex `thread.started` arrives mid-flight. |
| `startNewTurn()` (241) | Resets `currentTextCardId`. Cards persist across turns. |
| `clearCards()` (247) | Wipes Map + all id→cardId tables + currentTextCardId. |
| `persistCards()` (260) | Memory-mode only. Strips `pendingInput`, sets `streaming: false` on `assistant_text`, appends to `~/.quicksave/state/card-history/${sessionId}.json`. |
| `snapshotCutoff()` (292) | Claude-jsonl mode only. Records JSONL byte size; `getCards()` history reads stop here. |
| `scheduleDeferredClear(opts)` (318) | Polls JSONL size for stability, then atomically `clearCards()` + advance cutoff. Token-cancellable. Runs after Claude `result`. |
| `cancelDeferredClear()` (360) | Invalidates pending clear (hot resume hook). |

### 4.2. Codex SDK → cardBuilder mapping (current `consumeCodexStream`)

The Codex SDK delivers `ThreadEvent`s. Type union from
`@openai/codex-sdk@0.125.0/dist/index.d.ts:164`:

```
ThreadEvent =
  | ThreadStartedEvent | TurnStartedEvent | TurnCompletedEvent | TurnFailedEvent
  | ItemStartedEvent  | ItemUpdatedEvent  | ItemCompletedEvent
  | ThreadErrorEvent
```

| SDK event | Field(s) read | cardBuilder call(s) | Site |
|-----------|---------------|---------------------|------|
| `thread.started` | `event.thread_id` | `cb.updateSessionId(thread_id)`; resolves `onThreadStarted` | codexSdkProvider.ts:247–250 |
| `turn.started` | — | (no-op; we infer per-item) | 252–253 |
| `turn.completed` | `event.usage.{input_tokens, output_tokens, cached_input_tokens}` | `flushText()`, `cb.finalizeAssistantText()`, then `emitStreamEnd({success: true, tokenUsage})`. Computes per-turn deltas from `prevCumulative` and surfaces raw cumulative. | 255–285 |
| `turn.failed` | `event.error.message` | `flushText`, `finalizeAssistantText`, `emitStreamEnd({success: false, error})` | 287–298 |
| `error` (top-level `ThreadErrorEvent`) | `event.message` | `cb.systemMessage(message, 'error')` | 313–315 |
| `item.started` (`AgentMessageItem`) | `item.id`, `item.text` | `bufferText(takeAssistantDelta(item))` (150 ms debounce → `cb.assistantText`) | 365–369; helper 137 |
| `item.started` (`ReasoningItem`) | `item.id`, `item.text` | `cb.thinkingBlock(takeReasoningDelta(item))` | 360–364 |
| `item.started` (`CommandExecutionItem`) | `item.command`, `item.id` | `flushText()`, `cb.toolUse('Bash', { command }, item.id)` | 370–372 |
| `item.started` (`FileChangeItem`) | `item.changes[]`, `item.status` | `flushText()`, then per-file `cb.toolUse('Write'\|'Edit', { file_path }, cardId)` (cardId = `id` if 1 change, `id#i` otherwise). NO result emitted at started. | 374–377; helper 110 |
| `item.started` (`McpToolCallItem`) | `item.server`, `item.tool`, `item.arguments`, `item.id` | `flushText`, `cb.toolUse('${server}:${tool}', arguments, id)` | 379–386 |
| `item.started` (`WebSearchItem`) | `item.query`, `item.id` | `flushText`, `cb.toolUse('WebSearch', { query }, id)` | 387–390 |
| `item.started` (`TodoListItem`) | `item.items[]`, `item.id` | `flushText`, `cb.toolUse('TodoWrite', { todos: normalize(items) }, id)`. `normalizeTodoItems` maps SDK `{text, completed}` → Claude shape `{content, status}`. | 391–394; helper 95 |
| `item.started` (`ErrorItem`) | `item.id`, `item.message` | `emitErrorItemOnce` → `cb.systemMessage(message, 'error')` (deduped by `item.id` across started/updated/completed) | 395–398; helper 164 |
| `item.updated` (`AgentMessageItem`) | cumulative `text` | `bufferText(takeAssistantDelta(...))` | 408–412 |
| `item.updated` (`CommandExecutionItem`) | `item.aggregated_output`, `item.status` | `cb.toolResult(id, aggregated_output, status==='failed')`. Note: this fires on **interim** updates too — the result card is overwritten each tick. | 414–417 |
| `item.updated` (`ReasoningItem`) | cumulative text | `cb.thinkingBlock(delta)` (only if `delta.trim()`) | 419–422 |
| `item.updated` (`TodoListItem`) | `item.items` | `cb.toolUse('TodoWrite', { todos }, id)` — patch-or-create | 423–430 |
| `item.updated` (`ErrorItem`) | `item.message` | `emitErrorItemOnce` | 432–434 |
| `item.updated` (`WebSearchItem`) | `item.query` | re-`cb.toolUse('WebSearch', { query }, id)` (patches input). Defends against the SDK shipping started with empty query. | 435–441 |
| `item.completed` (`AgentMessageItem`) | final `text` | `flushText`, `cb.assistantText(deltaIfAny)`, `cb.finalizeAssistantText()`. Defensive: surfaces text that came only via completed. | 454–464 |
| `item.completed` (`CommandExecutionItem`) | `command`, `aggregated_output`, `exit_code`, `status` | `cb.toolUse('Bash', …)` if not yet created, then `cb.toolResult(id, output + '\n[exit code: N]', status==='failed')` | 465–474 |
| `item.completed` (`FileChangeItem`) | `changes`, `status` | `emitFileChangeCards(…, emitResult: true)` — per-file Edit/Write add (if missing) + result `${kind}: ${path}` | 476–482 |
| `item.completed` (`McpToolCallItem`) | `server`, `tool`, `arguments`, `result`, `error`, `status` | `cb.toolUse(…)` if missing; `cb.toolResult(id, resultText, failed)` where `resultText = error.message` OR concatenated text blocks OR `JSON.stringify(structured_content)` fallback | 483–507 |
| `item.completed` (`WebSearchItem`) | `query` | `cb.toolUse('WebSearch', …)` if missing; `cb.toolResult(id, 'Search: ' + query, false)` | 508–515 |
| `item.completed` (`ReasoningItem`) | final `text` | `cb.thinkingBlock(deltaIfAny)` (defensive) | 516–520 |
| `item.completed` (`TodoListItem`) | `items` | `cb.toolUse('TodoWrite', …)` (patch-or-create); `cb.toolResult(id, 'N/M completed', false)` | 522–530 |
| `item.completed` (`ErrorItem`) | `message` | `emitErrorItemOnce` | 531–533 |

Boundary calls outside the per-event switch:

- **Turn lifecycle wrapping** (CodexSdkSession.runTurn, codexSdkProvider.ts:594–637 and runFirstTurn 702–768):
  - `cb.startNewTurn()` + `cb.userMessage(prompt)` are called *before* `runStreamed`.
  - On abort: `cb.systemMessage('User interrupted')` + `emitStreamEnd({interrupted: true})`.
  - On other thrown errors: `emitStreamEnd({success: false, error})`.
  - `finally`: `await cb.persistCards()` + `cb.clearCards()`.
- **Defensive fallback** (codexSdkProvider.ts:323–332): if the SDK loop ends without `turn.completed` or `turn.failed`, `flushText`, `finalizeAssistantText`, and emit a synthetic `success: true` stream-end.

### 4.3. Claude CLI → cardBuilder mapping

For symmetry / migration parity. Driven by `claudeCliProvider.ts` parsing
the CLI's `--output-format stream-json` lines.

| CLI stream message | Field(s) | cardBuilder call(s) | Site |
|--------------------|----------|---------------------|------|
| `system { subtype: 'init' }` | `session_id`, `model` | (consumed at spawn time, not via cb); `callbacks.onModelDetected(model)` | claudeCliProvider.ts:407–415 |
| `system { subtype: 'task_started', description, task_id, tool_use_id }` | description, ids | `flushText`, `cb.subagentStart(description, task_id, tool_use_id)` | 619–620 |
| `system { subtype: 'task_progress', task_id, tool_use_id, usage.tool_uses, last_tool_name }` | counts | `cb.subagentProgress(...)` | 621–623 |
| `system { subtype: 'task_notification', task_id, tool_use_id, status, summary }` | terminal status | `cb.subagentEnd(...)` | 624–626 |
| `stream_event { event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }` | text | `bufferText(text)` (150 ms debounce → `cb.assistantText`) | 632–640 |
| `assistant.message.content[] { type: 'thinking', thinking }` | thinking text | `cb.thinkingBlock(thinking)` (skipped if empty) | 651–655 |
| `assistant…content[] { type: 'redacted_thinking' }` | — | `cb.thinkingBlock('[Redacted thinking]')` | 656 |
| `assistant…content[] { type: 'text', text }` | text | `cb.finalizeAssistantText()` if streaming was active; ELSE `cb.assistantText(text)`. Avoids double-content on stream-event delta + finalize race. | 658–667 |
| `assistant…content[] { type: 'tool_use', name, input, id }` | `name`, `input`, `id` | `callbacks.onToolUse?.()`; if name !== 'Agent' → `cb.toolUse(name, input, id)`. Agent tool_use is suppressed because the subagent system messages drive the SubagentCard. | 668–672 |
| `assistant…content[] { type: 'server_tool_use' \| 'mcp_tool_use' }` | `name`, `input`, `id` | `cb.toolUse(name ?? type, input, id ?? '')` | 673–676 |
| `assistant…content[] { unknown type }` | preview | `cb.systemMessage('[type] preview', 'info')` | 677–681 |
| `user.message.content` (string) | content | `flushText`, `cb.userMessage(content)` | 692–695 |
| `user…content[] { type: 'text', text }` | text | `flushText`, `cb.userMessage(text)` | 698–701 |
| `user…content[] { type: 'tool_result', tool_use_id, content, is_error }` | extracted text | `cb.toolResult(tool_use_id, text, !!is_error)` | 702–706 |
| `user…content[] { type: '*_tool_result' }` (web_search/web_fetch/mcp/code_execution/tool_search) | content text | `cb.toolResult(parentId, text, !!is_error)` | 707–717 |
| `user…content[] { unknown type }` | preview | `cb.systemMessage('[type] preview', 'info')` | 718–724 |
| `result { subtype, terminal_reason, total_cost_usd, usage, errors, session_id }` | terminal reason, tokens, cost | `flushText`, optional `cb.systemMessage('User interrupted')` if `terminal_reason ∈ {aborted_tools, aborted_streaming}`, `cb.finalizeAssistantText()`, `emitStreamEnd({success, error, interrupted, totalCostUsd, tokenUsage:{input, output, cacheCreation, cacheRead}})`. Then `cb.scheduleDeferredClear()`. | 730–776 |
| permission `control_request` | tool_name, input, tool_use_id | (NOT a direct cb call — flows through `callbacks.handlePermissionRequest` → SessionManager → `cb.toolCallFromPermission`) | 587–590, sessionManager.ts:1041–1055 |

---

## 5. Builder state machine

Per-session `StreamCardBuilder` instance is owned by SessionManager (one
per active session, stored in `ManagedSession.cardBuilder`,
sessionManager.ts:134, 369, 522).

### 5.1. Held state (cardBuilder.ts:210–229)

```
sessionId      string            // stamped on every emitted CardId / event
cwd            string            // for resolving Claude .jsonl path
seq            number            // monotonic, never reset across turns or clearCards
cards          Map<CardId, Card> // insertion-ordered live snapshot
toolUseIdToCardId Map<string, CardId>
agentIdToCardId   Map<string, CardId>
ephemeralCards    Set<CardId>    // ToolCallCards created from canUseTool, removed on resolve
currentTextCardId CardId | null  // assistant_text being appended to; reset by ANY non-text mutation
_jsonlCutoff   number | null     // claude-only: history reads stop here
_pendingClearToken Symbol | null // scheduleDeferredClear cancellation token
```

### 5.2. Per-turn lifecycle

For both providers, a turn proceeds:

1. **Start.** Provider calls `cb.startNewTurn()` then
   `cb.userMessage(prompt)`. Carry-over cards from prior turns remain;
   `currentTextCardId` is reset (cardBuilder.ts:241–244).
2. **Stream.** Provider feeds events through the public mutators §4.1.
   `currentTextCardId` is set by the first `assistantText` and reset by
   any of: `userMessage`, `thinkingBlock`, `toolUse`/`toolCallFromPermission`,
   `subagentStart`, `finalizeAssistantText`. (The reset enforces "tool
   calls split a streaming text run into separate cards".)
3. **End.** Provider calls `cb.finalizeAssistantText()` (no-op if no
   active text card) and emits `CardStreamEnd` via
   `callbacks.emitStreamEnd`. SessionManager flips
   `ManagedSession.streaming = false` (sessionManager.ts:954–958).
4. **Persist + clear.**
   - Memory mode (Codex): `await cb.persistCards()` then `cb.clearCards()`
     synchronously in `runTurn`'s `finally`
     (codexSdkProvider.ts:633–637, runFirstTurn 757–760).
   - Claude-jsonl mode: `void cb.scheduleDeferredClear()`
     (claudeCliProvider.ts:773). Polls JSONL file size, waits for
     stability (default 300 ms stable, 3 s max), then clears + advances
     cutoff. Cancelled by the next hot resume.

### 5.3. Finalization rule

There is **no single sentinel "card is done"** event for non-text cards.
Cards are mutated in place via `update` events (e.g. tool result fills
`tool_call.result`). The only explicit finalization is the
`assistant_text.streaming: false` patch emitted by
`finalizeAssistantText()`. After `CardStreamEnd`, no further
`CardEvent`s arrive for that turn (enforced by SessionManager flipping
streaming = false).

### 5.4. Tool-call ↔ tool-result correlation

Single source of truth: the **provider-side `toolUseId`** passed into
`cb.toolUse(name, input, toolUseId)`. The internal map
`toolUseIdToCardId` (cardBuilder.ts:217) keys all later updates
(`toolResult`, `setToolAnswers`, `clearPendingInput` for permission cases,
`hasToolCard`).

For Codex this id is `ThreadItem.id` from the SDK
(codexSdkProvider.ts:372, 376, 382, 389, 393, 415, etc.). For
file_change with N>1 entries, the provider derives child IDs as
`${item.id}#${i}` (codexSdkProvider.ts:121).

For Claude this id is `block.id` from the assistant message's `tool_use`
block (claudeCliProvider.ts:671) and the `tool_use_id` field of the
matching `tool_result` user-side block (704).

### 5.5. Subagent correlation

`agentIdToCardId` (cardBuilder.ts:219) is keyed on the SDK's `task_id`
(Claude). Lookups also fall back to `toolUseId` so callers don't need to
know which key they have (cardBuilder.ts:580–581, 595–596). **Codex has
no analogue today** — `subagentStart`/`Progress`/`End` are unused on the
Codex path.

### 5.6. CardId format

`${sessionId}:${seq}` for streaming (cardBuilder.ts:373).
`${sessionId}:h:${seq}` for history-derived cards
(cardBuilder.ts:749). The seq counter is monotonic per
`StreamCardBuilder` instance; never reset by `clearCards` or
`startNewTurn` (verified by `cardBuilder.edge.test.ts:863`).

---

## 6. Invariants

| # | Invariant | Why it matters | Where enforced |
|---|-----------|----------------|----------------|
| **I1** | **CardEvent ordering matches provider event arrival.** A consumer that applies events in order produces the same `Card[]` snapshot. | The PWA never re-sorts. A reordered append-then-add produces a missing card. | Single-threaded `for-await` loop in `consumeCodexStream` (codexSdkProvider.ts:243); single-threaded readline pump in `consumeStream` (claudeCliProvider.ts:539–541). No queue between cb call and `emitCardEvent`. |
| **I2** | **`assistant_text` deltas only ever append.** They never replace prior text, and never produce two `add` events for the same logical message run. | The PWA renders `text` cumulatively; a replace would visibly flicker. | `currentTextCardId` accumulator + `appendTextEvent` mutating in place (cardBuilder.ts:397–403). Codex `takeAssistantDelta` (137) computes the new-text delta against the per-item baseline. |
| **I3** | **A second assistant_message in the same turn does NOT slice off characters belonging to the new item.** | Regression risk — a previous bug chopped leading characters. | `tracker.lastAssistantItemId` reset when the SDK item id changes (codexSdkProvider.ts:140–146). Pinned by `codexSdkProvider.test.ts:166–199` and `:201–228`. |
| **I4** | **Tool calls and tool results are paired by provider toolUseId.** | If pairing breaks, results show up as orphan cards (or not at all — `toolResult` returns null on miss). | `toolUseIdToCardId` (cardBuilder.ts:217). `toolResult` returns null when the id is unknown (544–545). Pinned by `cardBuilder.test.ts:181–188, 219–222`. |
| **I5** | **Tool results are truncated at 500 chars; the truncation flag is wire-visible.** | The PWA needs to know to offer "show more" without re-fetching. | `TOOL_RESULT_TRUNCATE_LENGTH = 500` (cardBuilder.ts:21). `toolResult` 543–553. Pinned by `cardBuilder.test.ts:243–262`. |
| **I6** | **`update.patch` with `null` value clears the key, not sets it to null.** | `JSON.stringify(undefined)` drops the key on the bus, so the agent uses `null` as the wire sentinel. The receiver must `delete` after merging. | cardBuilder.ts:386–393. Pinned by `cardBuilder.edge.test.ts:387–416`. |
| **I7** | **Permission cards survive a tool_use that fires before canUseTool, and vice versa.** Whichever arrives first creates the card; the second patches it. | Without this, the card-builder duplicates a single tool invocation on the wire. | `toolCallFromPermission` patches when `toolUseIdToCardId.has(id)` (cardBuilder.ts:486–490). Mirror in `toolUse` (455–459). |
| **I8** | **Ephemeral permission cards are removed by `clearPendingInput`; non-ephemeral cards keep their tool_call card with `pendingInput: null`.** | Subagent permission UIs are throwaway; tool permissions persist as audit. | cardBuilder.ts:510–523. |
| **I9** | **A turn that aborts emits `interrupted: true` AND prepends a `system: 'User interrupted'` card.** | The PWA distinguishes user cancel from agent error. | Codex: codexSdkProvider.ts:619–623. Claude: claudeCliProvider.ts:741–743. Pinned by sessionManager tests. |
| **I10** | **Codex `tokenUsage` is reported as a per-turn delta, with the raw thread-cumulative attached on three extra fields.** | Codex's SDK reports cumulative; the PWA's per-turn cost UI assumes deltas. The cumulative is round-tripped through eventStore so a daemon restart can re-seed. | codexSdkProvider.ts:259–283; `loadCumulativeSeed` 778–786; `LastTurnInfo` eventStore.ts:44–61; recorded by `service/run.ts:303–340`. Pinned by `codexSdkProvider.test.ts:705–733`. |
| **I11** | **`CardStreamEnd` fires exactly once per turn.** | Bus subscribers use it as the per-turn boundary marker. | `turnEndEmitted` flag in `consumeCodexStream` (codexSdkProvider.ts:220, 236–240) and `cliSession.resultEmitted` in Claude path (515, 547, 561). |
| **I12** | **For memory-mode (Codex), `persistCards()` strips `pendingInput` and forces `streaming: false` on `assistant_text` before writing.** | A reload-time `streaming: true` would leave the UI showing a typing indicator forever. A persisted `pendingInput` would point at a long-stale requestId. | cardBuilder.ts:264–272. Pinned by `cardBuilder.edge.test.ts:418–470`. |
| **I13** | **Stream end without `turn.completed`/`turn.failed` still emits a synthetic success stream-end.** | Otherwise the PWA waits forever; "session finished" never fires. | codexSdkProvider.ts:323–332 and Claude `if (!cliSession.resultEmitted)` 560–562. |
| **I14** | **The card-builder never emits a `Card` whose `type` is not in the closed `Card` union.** Unknown provider blocks fall back to `system { subtype: 'info' }` with a `[type]` prefix. | Forward-compat: a future SDK shipping a new block type doesn't crash the PWA. | claudeCliProvider.ts:677–681, 718–724; cardBuilder.ts:944–952 (history path). |
| **I15** | **The `error` (top-level Codex `ThreadErrorEvent`) becomes a system error card; the turn is still expected to complete via `turn.failed` or `turn.completed`.** | An `error` event is non-terminal in the SDK; it's a mid-turn warning. | codexSdkProvider.ts:313–315. The synthetic stream-end at 323 also handles the case where `error` was the last event seen. |
| **I16** | **`ErrorItem` is emitted exactly once even if it shows up across started/updated/completed.** | The SDK doesn't pin which lifecycle event surfaces error items; we listen on all three and dedupe by `item.id`. | `emitErrorItemOnce` codexSdkProvider.ts:164–173. Pinned by `codexSdkProvider.test.ts:634–670`. |

---

## 7. Tests pinning the contract

### 7.1. `apps/agent/src/ai/cardBuilder.test.ts`

Builder unit tests. Asserts:

- `userMessage`/`assistantText`/`finalizeAssistantText` event types and
  card shapes (62–145).
- `assistantText` append behavior and card-mutation in place (95–110).
- `thinkingBlock` resets currentTextCardId (158–164).
- `toolUse` + `toolResult` pairing via `toolUseId` (181–188).
- `toolUse` patches the card when `toolCallFromPermission` pre-created it
  (190–205).
- `toolResult` returns null on unknown id (219–221), truncates >500 chars
  (243–251), exact 500 chars passes through (254–262).
- `toolCallFromPermission` race direction (266–312); ephemeral removal
  (295–303).
- `clearPendingInput` clears via `null` patch sentinel (323–331);
  ephemeral removal (333–345); returns null on no match (318–321).
- `subagentStart`/`Progress`/`End` event shapes including `afterCardId`
  positioning (376–449).
- `attachPendingToSubagent` (454–467).
- `clearCards` resets all maps including breaking later `toolResult`
  (490–502).
- `startNewTurn` preserves cards (507–521).
- Card ID uniqueness across types (564–576).
- `loadPersistedCards` happy path + missing file + bad JSON (584–621).
- `persistCards` strips transient fields, appends, no-write on empty
  (628–676).
- `buildCardsFromHistory` covers: empty/missing JSONL, user/assistant
  text, thinking, redacted_thinking, tool_use+tool_result pairing,
  compact_boundary → compacted card, init/status filtering, sidechain
  filtering, pagination, subagent reconstruction (683–910).

### 7.2. `apps/agent/src/ai/cardBuilder.edge.test.ts`

Adversarial. Asserts:

- 200 rapid `assistantText` calls accumulate consistently with one
  card-id (79–123).
- Interleaved tool/text patterns split into separate text cards (125–190).
- `toolResult` for unknown / empty / huge ids does not crash (192–223).
- Double/triple `finalizeAssistantText` returns null on subsequent calls
  (225–275).
- Subagent without parent tool_call returns undefined `afterCardId`
  (277–307).
- Permission card lifecycle full coverage including
  `clearPendingInput` patch surviving JSON round-trip (309–416).
- `persistCards` strip-transient-fields contracts (418–497).
- `buildCardsFromHistory` against malformed JSON / empty / non-array
  content / unknown blocks / null inputs (499–727).
- Pagination edge cases (729–822).
- Card-id uniqueness across turns and after `clearCards` (824–897).
- `subagentProgress`/`End` agentId/toolUseId fallback (899–1000).

### 7.3. `apps/agent/src/ai/codexSdkProvider.test.ts`

**The migration's primary regression net.** Asserts the
SDK→cardBuilder mapping. Key suites:

- `thread.started` resolves `onThreadStarted` (87–104).
- `agent_message`: started emits text (110–130); updated emits delta
  (132–164); finalize on completed (230–252).
- **Multi-message in one turn (regression)**: msg-2 leading characters
  are not sliced (166–199); msg-2 via completed-only (201–228).
- `reasoning`: started emits thinking (258–273); updated emits delta
  (276–293).
- `command_execution`: started → Bash tool_call (299–322); completed →
  result with exit code (324–356); failed → isError (359–390).
- `file_change`: Edit/Write per-file (396–452); per-file mixed-kind
  (489–521); result on completed (454–487).
- `mcp_tool_call`: server:tool naming (527–552); structured_content
  fallback (554–581).
- `web_search` → WebSearch (587–607).
- `error item`: emitted once across started/updated/completed (634–670);
  via completed-only (654–670).
- `turn.completed` → success stream-end with token usage delta (676–703);
  cumulative shared across turns (705–733).
- `turn.failed` → error stream-end (738–753).
- top-level `error` event → system error card (758–775).
- Synthetic success stream-end on empty stream (780–793).
- Full-turn integration with reasoning + text + tool (798–855).
- All the "started missing, only completed" paths for agent_message,
  file_change, command_execution, web_search, todo_list (894–1048).

### 7.4. `apps/agent/src/ai/edgeCases.test.ts`

`scheduleDeferredClear` polling state machine — stabilization detection,
cancellation token reuse, time-bound bailout, getCards consistency
during the defer window (500–613). Plus several SessionManager
`getCards` cutoff cases (276–356).

### 7.5. `apps/agent/src/ai/sessionManager.test.ts`

End-to-end through callbacks:

- `card-event` re-emission (808–818).
- `card-stream-end` re-emission + streaming=false flip (820–842).
- Pending-permission card-event with answers patch (956–1019).
- Cleared-pending card-event routes to originating session id, not the
  response's sessionId (1152–1253).
- `getCards` history reads stop at `jsonlCutoff` and append in-memory
  cards only on offset=0 (1453–1856).

### 7.6. `apps/agent/src/ai/sessionManager.edge.test.ts`

Hot resume / session transitions / event ordering. Specifically pins
that `card-stream-end` fires before `session-updated` (452–474), and
that `getCards` for a closed session falls through to JSONL-only mode
(347–385).

### 7.7. `apps/agent/src/connection/e2e.*.test.ts`

Connection-level: relay → bus → /sessions/:id/cards round-trip. Less
about the card builder itself, more about not dropping `card-event`s on
reconnect.

---

## 8. v2 protocol mapping draft

Uses notation from
`docs/references/codex-app-server/event-catalog.md`. Anything marked **N/A
today** would be a NEW capability if we picked it up.

| Current SDK input (codexSdkProvider.ts) | → cardBuilder | v2 notification(s) supplying equivalent |
|-----------------------------------------|---------------|------------------------------------------|
| `thread.started { thread_id }` | `cb.updateSessionId(thread_id)`, resolves `onThreadStarted` | `thread/started` (catalog §Thread lifecycle); also fired on resume — payload includes `thread.status` |
| `turn.started` | (no-op) | `turn/started` |
| `turn.completed { usage }` | `flushText` + `finalizeAssistantText` + `emitStreamEnd(success: true, tokenUsage)` | `turn/completed` (`turn.status: 'completed'`) — but **per-turn `usage` may not be in this payload anymore**; v2 ships token usage via `thread/tokenUsage/updated` (catalog notes it replaces SDK's per-turn callback at *thread* granularity, not per-turn). **See risk R1.** |
| `turn.failed { error.message }` | `emitStreamEnd(success: false, error)` | `turn/completed` with `status: 'failed'` carrying `error.codexErrorInfo` |
| top-level `error { message }` (mid-turn) | `cb.systemMessage(message, 'error')` | `error` notification; or `warning`; or `configWarning` depending on severity. v2 splits the SDK's single bucket |
| `item.started` (`agent_message`) | `bufferText(delta)` | `item/started` (item.type=`agentMessage`) PLUS streaming `item/agentMessage/delta` notifications |
| `item.updated` (`agent_message`) | `bufferText(delta)` | `item/agentMessage/delta` (cumulative? delta? — see catalog §Streaming deltas; concatenate by `itemId`) |
| `item.completed` (`agent_message`) | `assistantText(deltaIfAny)` + `finalizeAssistantText` | `item/completed` |
| `item.started/updated` (`reasoning`) | `cb.thinkingBlock(delta)` | `item/started` + `item/reasoning/summaryTextDelta` and/or `item/reasoning/textDelta` (with `summaryIndex`/`contentIndex` ordering keys) AND `item/reasoning/summaryPartAdded` boundary marks |
| `item.started` (`command_execution`) | `cb.toolUse('Bash', { command }, id)` | `item/started` (item.type=`commandExecution`) |
| `item.updated` (`command_execution`) — refreshes aggregated_output on each tick | `cb.toolResult(id, aggregated_output, status==='failed')` | `item/commandExecution/outputDelta` (chunks!) — **delta**, not cumulative |
| `item.completed` (`command_execution`) | tool_use if missing + `cb.toolResult(id, output + exit, failed)` | `item/completed` |
| `item.started/completed` (`file_change`) | per-file Write/Edit cards + result | `item/started` (item.type=`fileChange`) + `item/fileChange/patchUpdated` + `item/fileChange/outputDelta` + `item/completed`. ALSO `turn/diff/updated` provides aggregated unified diff across all fileChange items in the turn — possible richer surface |
| `item.started` (`mcp_tool_call`) | `cb.toolUse('${server}:${tool}', args, id)` | `item/started` (item.type=`mcpToolCall`) + `item/mcpToolCall/progress` |
| `item.completed` (`mcp_tool_call`) | tool_use if missing + result (with structured_content fallback) | `item/completed` |
| `item.started/updated/completed` (`web_search`) | `cb.toolUse('WebSearch', {query}, id)` + result `'Search: ${query}'` | `item/started`, `item/completed` (item.type=`webSearch`) — no deltas in the v2 catalog |
| `item.started/completed` (`todo_list`) | `cb.toolUse('TodoWrite', {todos}, id)` + completed N/M result | catalog uses `plan` item with `item/plan/delta` (experimental) — **the SDK's `todo_list` and v2's `plan` may NOT be 1:1**. **Risk R2.** |
| `error` item (`ErrorItem`, dedup by id) | `emitErrorItemOnce` → systemMessage | The catalog documents `ErrorItem` is no longer a thread item type in the v2 union — instead use the top-level `error` notification with `codexErrorInfo` and the `item/completed.status='failed'` for items that fail. **Risk R3.** |
| (none) | (n/a) | `serverRequest/resolved` — replaces the SDK's implicit "approval done, redraw card" by giving us an explicit dismiss event. Matches our `clearPendingInput` flow. |
| (none) | (n/a) | `turn/diff/updated` — could replace ad-hoc per-file file_change rendering with a single rendered diff card. |
| (none) | (n/a) | `turn/plan/updated` — pretty close to TodoListItem, but pushed at the turn level rather than as an item. |
| (none) | (n/a) | `model/rerouted`, `model/verification` — would surface as system banners. No current consumer. |
| (none) | (n/a) | `account/*` notifications — auth/UX banners. Not card events. |
| (none) | (n/a) | `thread/compacted` and the `contextCompaction` item lifecycle — would be a system `compacted` card; today we synthesize one from Claude `compact_boundary`. |
| (none) | (n/a) | `item/autoApprovalReview/*` (UNSTABLE) — would feed our auto-review preset's UI; today this preset just sets a config flag without per-item events. |

### v2 events that have NO current consumer (potential value-adds)

- `serverRequest/resolved` (cleaner dismissal of permission UIs).
- `turn/diff/updated` (single coherent diff card per turn).
- `turn/plan/updated` (richer-than-todo plan UI).
- `thread/tokenUsage/updated` (per-thread, fires on resume; could replace the cumulative-seed dance entirely).
- `thread/status/changed`, `thread/closed` (sidebar live state — currently inferred).
- `model/rerouted`, `model/verification`, `account/rateLimits/updated`, `guardianWarning` (banners).
- `item/reasoning/summaryPartAdded` (currently we collapse; could split into multiple thinking cards).

### Current SDK inputs WITHOUT clean v2 counterpart

- **Per-turn `usage` on `turn.completed`.** v2 splits this into per-thread `thread/tokenUsage/updated`. We currently compute deltas from a thread-cumulative the SDK gave us; v2 gives us thread-cumulative directly but at thread granularity, possibly without a per-turn boundary marker. **R1 below.**
- **`AgentMessageItem.text` cumulative-on-each-update semantics.** v2 may deliver true deltas via `item/agentMessage/delta` — a different shape from "every event carries the full string so far". The current `takeAssistantDelta` slice math is built for cumulative; if v2 ships deltas, we either pass them through or simulate cumulative locally to keep the same code path. **R4.**
- **`CommandExecutionItem.aggregated_output` updated cumulatively on `item.updated`.** v2 ships chunks via `item/commandExecution/outputDelta`. Today we *overwrite* the result every tick; tomorrow we'd append. The two strategies disagree on what `result.content` looks like mid-turn. **R5.**
- **`TodoListItem`.** No 1:1 in v2 — closest is the experimental `plan` item with `item/plan/delta`. **R2.**
- **`ErrorItem` as a thread item.** No longer present in v2's typed union. **R3.**

---

## 9. Migration risk register

Sorted by severity. Each entry: **what could break / how it manifests / mitigation**.

### R1 — Per-turn token usage attribution silently regresses to thread-cumulative ★ HIGH

**What could break.** Today `turn.completed.usage` is the per-turn (well, cumulative-converted-to-delta) source of truth, emitted **synchronously with the turn boundary**. In v2, token usage is delivered via `thread/tokenUsage/updated`, which the catalog explicitly notes is at *thread* granularity and "also fires immediately after `thread/resume` if persisted usage was restored". There is no guarantee it fires once-per-turn.

**Manifests.** Silently. The PWA's per-turn cost badge (`SessionStatusBar.tsx`) keeps rendering, but every turn shows the cumulative thread cost instead of the delta — which the user reads as "every prompt cost $5". The cumulative-seed dance in `loadCumulativeSeed` (codexSdkProvider.ts:778) starts double-counting.

**Mitigation.** The migration must:
1. Subscribe to `thread/tokenUsage/updated` and compute the per-turn delta against the previously-observed cumulative on every turn boundary (`turn/completed`).
2. Decide a deterministic ordering: read the most-recent `thread/tokenUsage/updated` at `turn/completed` time, OR queue them and consume only the one whose timestamp brackets the turn.
3. Pin with a regression test mirroring `codexSdkProvider.test.ts:705–733` — two turns, mixed tokenUsage notifications, deltas correct, cumulative pinned.
4. Also handle the resume-time re-fire from `thread/tokenUsage/updated` — must NOT count it as a new turn.

### R2 — `todo_list` ↔ `plan` mismatch could drop the TodoWrite card type ★ HIGH

**What could break.** Today Codex emits `TodoListItem` and the cardBuilder reuses Claude's `TodoWrite` tool name (`normalizeTodoItems` at codexSdkProvider.ts:95 maps `{text, completed}` → `{content, status}`). In v2 the catalog does not list `todoList` — the closest is the experimental `plan` item (with `item/plan/delta`). The `plan` payload shape is unknown to me from the code alone.

**Manifests.** Loud-but-degraded: tests fail; missing `TodoWrite` cards in the UI for users who relied on them. Or silent-and-bad if v2 ships a generic `plan` that the fallback unknown-block renderer downgrades to a `system info` card.

**Mitigation.**
1. Read `docs/references/codex-app-server/event-catalog.md` notes on `plan` and `item/plan/delta`. If they are the new path, adapt `normalizeTodoItems` to the `plan` shape.
2. Otherwise, treat the absence of TodoListItem as "Codex no longer emits TodoWrite" and remove the SDK→TodoWrite path. Confirm with the human.
3. Pin with a regression test.

### R3 — `ErrorItem` deduping will be needed against a different surface ★ MEDIUM-HIGH

**What could break.** `emitErrorItemOnce` (codexSdkProvider.ts:164) was added because the SDK fires the same `ErrorItem` across started/updated/completed. v2 has no `ErrorItem` in the item union. Errors are reported via the top-level `error` notification (with `codexErrorInfo`) and via `item/completed` with `status: 'failed'` for the item that failed.

**Manifests.** Silently. Today's tests pinning "emits the error only once" (codexSdkProvider.test.ts:634–670) become tautologies because the input shape they test no longer exists. The v2 paths could plausibly fire `error` notification AND then `turn/completed { status: 'failed' }` — without a fresh dedupe strategy, we double-emit "Connection lost" + the `turn.failed` error.

**Mitigation.**
1. Build a new "did we already emit this errorMessage in this turn?" key that is robust to the v2 set: `error.message` + `codexErrorInfo` + turn id.
2. Decide: do we want errors as system cards AND a failed stream-end, or only one of those? Today we always stream-end; mid-turn `error` events become extra system cards. Preserve that behavior unless the human says otherwise.
3. Pin: simulate `error` followed by `turn/completed { status: 'failed' }` and assert exactly one system card + one stream-end.

### R4 — agentMessage delta shape change could either truncate or duplicate text ★ MEDIUM

**What could break.** Today `takeAssistantDelta` (codexSdkProvider.ts:137) treats `item.text` as cumulative-per-item — `delta = item.text.slice(knownLength)`. If v2's `item/agentMessage/delta` ships *chunks* instead, the slice math truncates legitimate text (because `knownLength` overshoots a delta), or we double-emit (because we treat the chunk as cumulative and re-slice).

**Manifests.** Loud — text is wrong on screen. Existing regression test (codexSdkProvider.test.ts:166–199) catches the truncation case.

**Mitigation.**
1. Inspect the v2 catalog payload for `item/agentMessage/delta`. If it carries true deltas, stop using `takeAssistantDelta` and just `bufferText(notification.delta)`.
2. Pin: chunked deltas of `'A'`, `'B'`, `'C'` produce `'ABC'`; followed by an `item/completed` with the full text, no double-emission.
3. Mirror the same audit for `item/reasoning/summaryTextDelta` / `textDelta` / `summaryPartAdded` boundaries (`takeReasoningDelta` codexSdkProvider.ts:149 has the same pattern).

### R5 — `command_execution` output is delta-vs-cumulative on the wire ★ MEDIUM

**What could break.** Today `routeItemUpdated` for `command_execution` overwrites the result card every tick using `item.aggregated_output` (codexSdkProvider.ts:414–417). v2 ships `item/commandExecution/outputDelta` — chunks. If we keep the "overwrite" handler, only the last chunk shows. If we switch to "append", we have to migrate the result accumulator (today `toolResult` is overwrite-only; cardBuilder.ts:543 sets `result.content` without merge).

**Manifests.** Silently (the user sees only the tail of long output) until the user runs a command with multi-screen output and notices the truncated head.

**Mitigation.**
1. Buffer chunks per `itemId` in the provider. Emit `cb.toolResult(id, accumulatedSoFar, isError)` after each chunk, OR add a `cb.toolResultAppend(id, chunk)` method to keep the buffer in the cardBuilder. The former is simpler and preserves the contract.
2. Pin: 3 outputDelta chunks → final `result.content` is their concatenation; truncation flag flips at 500 chars total.
3. Decide whether mid-stream we honor the 500-char truncation immediately or wait for `item/completed`. Today we truncate on every overwrite, which behaves well; the new path should match.

### R6 — Item ID scheme could change between SDK and v2, breaking tool-call → tool-result pairing ★ MEDIUM

**What could break.** `toolUseIdToCardId` is keyed on `ThreadItem.id` today. If v2 uses a different namespacing (e.g. `item.id` is unique only within a turn, not within a thread; or if it's shaped `{turnId}/{itemId}` while we used to get `{itemId}` alone), then:
- a second turn's item id collides with the first turn's,
- our `toolResult` lookup misses,
- the file_change derived child id `${item.id}#${i}` collides differently.

**Manifests.** Silently after a turn boundary — the second turn's tool results don't pair, showing as missing results in the UI.

**Mitigation.**
1. After `turn/completed` we already `clearCards()` (Codex memory mode), which resets `toolUseIdToCardId`. **This already mitigates R6 for Codex**, but only if `clearCards()` actually runs — i.e., the migration must keep calling `cb.persistCards()` + `cb.clearCards()` in `runTurn`'s `finally`.
2. Audit any tests that rely on toolUseIds living across turn boundaries. There are none today (per cardBuilder.edge.test.ts:863+).
3. If v2 namespaces ids per-turn anyway, dropping the prefix is fine — but record this in the migration commit.

### R7 — `turn/completed` may not be the only signal that the turn is done ★ MEDIUM

**What could break.** Today the SDK guarantees exactly one terminal `turn.completed` OR `turn.failed` per turn. The catalog suggests v2 packs both into `turn/completed { status: 'completed' | 'interrupted' | 'failed' }`. That's fine. But the catalog ALSO mentions `serverRequest/resolved` fires on turn start/complete/interrupt to clear pending requests — if we're not careful we'll treat these dismissal events as turn-end signals.

**Manifests.** Loud — `emitStreamEnd` fires twice; UI flips streaming state spuriously.

**Mitigation.**
1. Keep the `turnEndEmitted` guard (codexSdkProvider.ts:236–240). The migration's switch should fire only on `turn/completed`.
2. `serverRequest/resolved` should drive `cb.clearPendingInput(requestId)` ONLY — not stream-end.
3. Pin with a regression test: `serverRequest/resolved` arrives between `turn/started` and `turn/completed`; only one stream-end is emitted at `turn/completed`.

### R8 — File-change unified-diff feature could replace our per-file Write/Edit cards ★ LOW (but architectural)

**What could break.** v2 offers `turn/diff/updated` with the aggregated unified diff across every file_change in the turn. If the team adopts this for richer rendering, the current per-file Write/Edit card stream needs to go away — or live alongside, but then the same edit shows up twice (once as a per-file tool_call, once inside the aggregated diff).

**Manifests.** Loud-but-cosmetic — the user sees double-rendered edits.

**Mitigation.** Migration tracks the existing contract first; consider `turn/diff/updated` adoption as a follow-up. If we adopt it, plumb a new `Card` variant rather than retroactively redefine `tool_call`.

### R9 — `webSearch` "Search: ${query}" placeholder result is fake ★ LOW

**What could break.** Today Codex emits `web_search` items with no result — only a query. We synthesize `cb.toolResult(id, 'Search: ${query}', false)` (codexSdkProvider.ts:512–514) so the card visually completes. v2 may eventually add real web-search results. If we keep emitting the placeholder, real results would either replace it (if `toolResult` overwrites) or coexist.

**Manifests.** Silently (cosmetic — the user sees "Search: …" instead of actual results).

**Mitigation.** Watch v2 catalog for a real result payload; remove the synthetic when one exists.

### R10 — `thread.started` arrives twice (start + resume re-fire) ★ LOW

**What could break.** v2's `thread/started` "[carries] the current `thread.status`" and may fire on resume too. Today our `onThreadStarted` resolves a Promise once; calling it twice is a noop in `runFirstTurn` because of the `resolved` flag (codexSdkProvider.ts:734–738). `cb.updateSessionId(thread_id)` is idempotent for the same id but would mis-rebrand cards if the id is different.

**Manifests.** Silently if same id; loudly (cards get rebranded mid-stream) if v2 changes the thread_id semantics.

**Mitigation.** Keep `updateSessionId` guarded by an "only on first observation per session" check, or assert thread_id stability.

### R11 — `persistCards()` payload shape divergence between Codex versions ★ LOW

**What could break.** `loadPersistedCards` returns the raw on-disk JSON as `Card[]` without re-validation (cardBuilder.ts:33–43). If the migration changes anything about what `persistCards()` writes (e.g. new fields, dropped fields), an upgraded daemon reading a downgraded session's history will see stale shapes. Today `Card` is a discriminated union with optional fields, so additions are safe, but removals are not.

**Manifests.** Silently — old persisted tool_call cards lacking a new field render with that field missing.

**Mitigation.** The migration should not change `Card` shape. If it must, ensure additions only; never remove or rename existing fields without a versioned reader.

### R12 — `item.updated` (`reasoning`) skips empty deltas ★ LOW

**What could break.** `routeItemUpdated`'s reasoning branch only emits when `delta.trim()` is non-empty (codexSdkProvider.ts:421). v2 may push whitespace-only updates as legitimate intermediate frames. The cosmetic impact is none, but a test that expected each `item.updated` to produce an event would fail.

**Manifests.** Silently — no card changes; the test scaffold catches it on assertion shapes.

**Mitigation.** Decide explicitly whether to keep the `.trim()` filter; either way is defensible.

---

## 10. Open questions

1. **Does v2's `turn/completed` carry per-turn token usage at all, or only `thread/tokenUsage/updated`?** The catalog one-liner doesn't show the payload schema. Inspect `TurnCompletedNotification`'s generated TS file to confirm. Without per-turn usage on the turn boundary, R1's mitigation forces a join across two notifications.

2. **Does v2 expose a 1:1 replacement for `TodoListItem`?** The catalog's `plan` item with `item/plan/delta` is marked experimental; is it stable enough? If not, do we drop TodoWrite cards entirely from the Codex path? (Claude path is unaffected.)

3. **For `item/agentMessage/delta`, are deltas chunked or cumulative?** Catalog says "Concatenate by `itemId`", which strongly implies chunked-and-append. Confirm against the generated `AgentMessageDeltaNotification` payload before writing the consumer.

4. **`item/commandExecution/outputDelta` payload fields.** Need to know the exact field name (`delta`? `output`? `chunk`?) and whether stdout/stderr arrive on separate notifications or interleaved.

5. **What replaces `ErrorItem`?** The catalog shows `error`, `warning`, `configWarning`, and `item/completed.status='failed'` — but we have a single `cb.systemMessage(... , 'error')` rendering today. Which v2 surfaces should land as system cards vs which should be silently logged?

6. **Should the migration adopt `turn/diff/updated` as a richer FileChange card, or preserve per-file Write/Edit cards?** This is a product decision, not a contract one — but flag for the human.

7. **Is `serverRequest/resolved` strictly a UI-dismissal signal, or does it carry the resolution outcome?** Today our cards transition pendingInput → null after the user responds via the bus, not via a provider event. If `serverRequest/resolved` arrives reliably, we may simplify the SessionManager flow (sessionManager.ts:1041–1081) to drive `clearPendingInput` from the provider instead of from the resolved-input handler.

8. **What's the Codex `item/started` ↔ `item/completed` ordering guarantee for `file_change`?** The catalog says `fileChange` items are typically emitted at completion; today's tests confirm `started` can also fire. Confirm against v2 — if `started` is gone, the per-file deduping by `cb.hasToolCard` (codexSdkProvider.ts:467, 484, 509) is still correct, but the tests pinned at codexSdkProvider.test.ts:396–452 may need updating.

9. **Are there any `/sessions/:id/cards` consumers OTHER than the PWA chat view?** If yes (e.g. analytics, automated testing), the migration's contract has more downstream readers. Quick grep didn't find any in the agent or PWA repos, but worth confirming.

10. **Token usage dedup strategy on resume.** Today `loadCumulativeSeed` (codexSdkProvider.ts:778) reads the last `turn_ended` event from `eventStore` and seeds the running cumulative. With v2 firing `thread/tokenUsage/updated` on resume, do we still need the seed (the notification supplies the cumulative directly), or do we keep the seed as belt-and-braces?

---
