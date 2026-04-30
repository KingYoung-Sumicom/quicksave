# Card Builder Contract

> Source verified against the working tree at HEAD on `main`. Codex now
> drives the `codex app-server` JSON-RPC v2 protocol (see
> `apps/agent/src/ai/codexAppServer/`); the Claude provider continues to
> consume the `claude` CLI's stdio stream-json output. All file:line
> citations point at the files in `apps/agent/src/ai/`,
> `packages/shared/src/`, etc.

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
`@openai/codex-sdk` (Thread API) to `codex app-server` (JSON-RPC v2) is
complete; this doc pins the contract that both providers honor.

---

## 2. File map

| File | One-liner | Exports / key symbols |
|------|-----------|-----------------------|
| `packages/shared/src/cards.ts` | Wire types: `Card`, `CardEvent`, `CardStreamEnd`, `CardHistoryResponse`, `SessionCardsUpdate`, `PendingInputAttachment`. The whole agent↔PWA card protocol surface. | `CardId`, `Card` union, `CardEvent` union, `CardStreamEnd`, `CardHistoryResponse`, `SessionCardsUpdate`, `PendingInputAttachment`, `PendingInputWithContext` |
| `packages/shared/src/types.ts` | Re-exports above; defines `AgentId` and other shared types. | `AgentId`, etc. |
| `apps/agent/src/ai/cardBuilder.ts` | The card builder itself. `StreamCardBuilder` is the per-session accumulator; `buildCardsFromHistory` reconstructs a `Card[]` from Claude CLI's session JSONL; `loadPersistedCards` reads memory-mode persistence. | `StreamCardBuilder` (class), `buildCardsFromHistory()`, `loadPersistedCards()` |
| `apps/agent/src/ai/provider.ts` | Provider interface boundary. Defines `ProviderCallbacks` (the only legal channel a provider may use to feed the card builder) and `CodingAgentProvider`. | `CodingAgentProvider`, `ProviderSession`, `ProviderCallbacks`, `StartSessionOpts`, `ResumeSessionOpts`, `PermissionLevel`, `ProviderHistoryMode` |
| `apps/agent/src/ai/codexAppServer/cardAdapter.ts` | Codex v2 adapter — translates `codex app-server` JSON-RPC v2 notifications into card-builder calls via `consumeAppServerStream()`. | `consumeAppServerStream`, `CardAdapterContext` |
| `apps/agent/src/ai/codexAppServer/provider.ts` | Codex provider driving the v2 protocol. Owns `runTurn` lifecycle (`cb.startNewTurn` + `cb.userMessage` → `turn/start` → adapter → `cb.persistCards` + `cb.clearCards`). | `CodexAppServerProvider`, `CodexAppServerSession` |
| `apps/agent/src/ai/codexMcpProvider.ts` | Alternate Codex provider speaking the legacy MCP-style protocol — kept as a fallback while v2 stabilizes. Drives the same card builder. | (provider class) |
| `apps/agent/src/ai/claudeCliProvider.ts` | Claude provider — parses the CLI's stream-json line protocol and drives the same card builder. | `ClaudeCliProvider`, `buildClaudeCliArgs`, `getClaudeBin` |
| `apps/agent/src/ai/claudeSdkProvider.ts` / `claudeCodeProvider.ts` | Alternate Claude providers (SDK / Claude Code) sharing the same `ProviderCallbacks` boundary. | (provider classes) |
| `apps/agent/src/ai/sessionManager.ts` | Owns the per-session `StreamCardBuilder`, wires `ProviderCallbacks` (`makeCallbacks`), forwards `card-event` and `card-stream-end` to the bus, drives permission flow that emits `toolCallFromPermission` / `clearPendingInput` / `setToolAnswers`. | `SessionManager`, `makeCallbacks`, `getCards` |
| `apps/agent/src/storage/eventStore.ts` | Append-only SQLite log of `prompt_sent` / `turn_ended` / `permission_*` events. Codex-only `cumulativeInputTokens` is round-tripped through `LastTurnInfo` so cold-resume can seed the running cumulative-usage snapshot. | `EventStore`, `LastTurnInfo`, `getEventStore()` |
| `apps/agent/src/service/run.ts` | Daemon glue. Subscribes to `card-event`/`card-stream-end` from the SessionManager and republishes onto the message bus topic `/sessions/:sessionId/cards`. Records `turn_ended` events. | `claudeService.on('card-event', …)` line 270; `card-stream-end` handler 276–357 |
| `apps/agent/src/ai/cardBuilder.test.ts` | Unit tests for `StreamCardBuilder`, `loadPersistedCards`, `buildCardsFromHistory`. | (tests) |
| `apps/agent/src/ai/cardBuilder.edge.test.ts` | Adversarial edge cases — rapid streaming, ID uniqueness, permission lifecycle, persistence corner cases. | (tests) |
| `apps/agent/src/ai/codexAppServer/__tests__/cardAdapter.test.ts` | Pins the v2 notification → card mapping for `consumeAppServerStream`. | (tests) |
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
| `user` (`UserCard`) | 43–46 | A user prompt. `text: string`. |
| `assistant_text` (`AssistantTextCard`) | 48–53 | Streaming or finalized assistant prose. `text` accumulates via `append_text` events; `streaming?: boolean` flips false on finalize. |
| `thinking` (`ThinkingCard`) | 55–58 | Reasoning trace. Plain `text`. Codex reasoning summary AND raw reasoning AND Claude `thinking` blocks all funnel here. |
| `tool_call` (`ToolCallCard`) | 60–73 | A tool invocation. Carries `toolName`, `toolInput`, `toolUseId`, optional `result: ToolCallResult`, optional `answers: Record<string,string>` (AskUserQuestion only). `pendingInput` carries a permission/question UI prompt while pending. |
| `subagent` (`SubagentCard`) | 81–92 | A child Agent invocation (Claude only today). `description`, `agentId`, `toolUseId`, `status: 'running' \| 'completed' \| 'failed' \| 'stopped'`, `summary?`, `toolUseCount`, `lastToolName?`. |
| `system` (`SystemCard`) | 96–100 | Banners. `text` + `subtype: SystemCardSubtype` (`'compacted' \| 'cost' \| 'error' \| 'info' \| 'warning'`). Used for compaction notices, errors, "User interrupted", unknown-block fallbacks. |

`ToolCallResult` shape (cards.ts:75–79):
```ts
{ content: string; isError: boolean; truncated: boolean }
```

The `Card` discriminated union is the closed set; nothing else may be
emitted. (cards.ts:102–108)

### CardEvent (the wire payload)

```ts
// cards.ts:110–148 (CardAddEvent / CardUpdateEvent / CardAppendTextEvent / CardRemoveEvent)
type CardEvent =
  | { type: 'add';         sessionId; card: Card; afterCardId?: CardId }
  | { type: 'update';      sessionId; cardId; patch: Record<string, unknown> }
  | { type: 'append_text'; sessionId; cardId; text: string }
  | { type: 'remove';      sessionId; cardId };
```

**Wire convention** (cards.ts:124–132, cardBuilder.ts:381–390): in an
`update.patch`, a `null` value means "delete this key". `JSON.stringify`
drops `undefined`, so `null` is the only sentinel that survives the bus
hop. Receivers must `delete` null-valued keys after merging.

### CardStreamEnd

```ts
// cards.ts:186–207
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

`SessionCardsUpdate` (cards.ts:180–182) is the bus-topic envelope:
either `{ kind: 'card', event: CardEvent }` or
`{ kind: 'stream-end', result: CardStreamEnd }`.

---

## 4. Provider event inputs

The card builder is fed exclusively through `StreamCardBuilder`'s public
methods (cardBuilder.ts:409–605). Both providers convert their respective
event streams into these calls.

### 4.1. `StreamCardBuilder` public mutating API

Listed in source order; each returns a `CardEvent` (or `null`) which the
provider must forward to `callbacks.emitCardEvent()`.

| Method | Signature | Card effect | Notes |
|--------|-----------|-------------|-------|
| `userMessage(text)` | cardBuilder.ts:409 | Adds a `user` card. Resets `currentTextCardId`. | The Claude provider skips `--replay-user-messages` echoes upstream (`isReplay` guard, claudeCliProvider.ts:793). |
| `thinkingBlock(text)` | 415 | Adds a `thinking` card. | Each call is a fresh card; thinking does NOT stream-coalesce the way text does. |
| `assistantText(text)` | 425 | First call adds an `assistant_text` card with `streaming: true`. Subsequent calls return `append_text` events on the same card. | Coalesce continues until any non-text mutation resets `currentTextCardId`. |
| `finalizeAssistantText()` | 436 | `update { streaming: false }` on current text card; null otherwise. | Idempotent on null path: returns `null` after first call. |
| `toolUse(name, input, id)` | 448 | `add` of a `tool_call`; OR `update { toolInput }` if the toolUseId already had a card from `toolCallFromPermission`. | Same call is used for "create card" and "patch input" — keyed on `toolUseIdToCardId`. |
| `toolCallFromPermission(name, input, id, pending, ephemeral?)` | 471 | `add` (with `pendingInput`) OR `update { pendingInput }` if `toolUse` already created the card. `ephemeral` marks for removal on resolve. | Driven by SessionManager (handlePermissionRequest), not the provider stream. |
| `toolResult(id, content, isError)` | 540 | `update { result }`; null if no matching `tool_call`. Truncates content > 500 chars and sets `truncated: true`. |
| `setToolAnswers(id, answers)` | 553 | `update { answers }` on `tool_call`. | Used only for AskUserQuestion. |
| `attachPendingToSubagent(agentId, pending)` | 500 | `update { pendingInput }` on the `subagent` card. |
| `clearPendingInput(requestId)` | 507 | `update { pendingInput: null }`, OR `remove` if ephemeral; null if no match. |
| `subagentStart(desc, agentId, toolUseId?)` | 559 | Adds a `subagent` card; positions `afterCardId = toolUseId's card`. |
| `subagentProgress(agentId, toolUseId?, count?, lastTool?)` | 576 | `update { toolUseCount, lastToolName }`. |
| `subagentEnd(agentId, toolUseId?, status, summary?)` | 586 | `update { status, summary }`. |
| `systemMessage(text, subtype?)` | 598 | Adds a `system` card. |
| `errorMessage(text)` | 603 | `systemMessage('Error: ' + text, 'error')`. |

Read-only / introspection helpers used by providers and SessionManager:

| Method | Effect |
|--------|--------|
| `hasToolCard(toolUseId)` (cardBuilder.ts:531) | True if a tool_call has already been created for this toolUseId. Used by Codex completed handlers to guard against missing item/started. |
| `findCardByRequestId(requestId)` (523) | Locate the card carrying a given `pendingInput.requestId`. |
| `getCards()` (536) | Snapshot of all live cards in insertion order. |

Lifecycle methods (no card effect, but mutate state used by the above):

| Method | Effect |
|--------|--------|
| `updateSessionId(sid)` (cardBuilder.ts:234) | Rewrites the sessionId baked into freshly-minted CardIds and event envelopes. Called once after the Codex `thread/start` response so the temporary `'pending'` builder id is replaced with the real thread id (sessionManager.ts:505). |
| `startNewTurn()` (239) | Resets `currentTextCardId`. Cards persist across turns. |
| `clearCards()` (244) | Wipes Map + all id→cardId tables + currentTextCardId. |
| `persistCards()` (257) | Memory-mode only. Strips `pendingInput`, sets `streaming: false` on `assistant_text`, appends to `getCardHistoryDir()/${sessionId}.json`. |
| `snapshotCutoff()` (289) | Claude-jsonl mode only. Records JSONL byte size; `getCards()` history reads stop here. |
| `scheduleDeferredClear(opts)` (315) | Polls JSONL size for stability, then atomically `clearCards()` + advance cutoff. Token-cancellable. Runs after Claude `result`. |
| `cancelDeferredClear()` (357) | Invalidates pending clear (hot resume hook). |
| `jsonlCutoff` getter/setter (361/365) | Exposes the byte cutoff so SessionManager can pass it into `buildCardsFromHistory`. |

### 4.2. Codex `app-server` v2 → cardBuilder mapping (`consumeAppServerStream`)

The Codex provider drives the `codex app-server` JSON-RPC v2 protocol.
The adapter (`apps/agent/src/ai/codexAppServer/cardAdapter.ts`)
subscribes to the RPC client's notification stream and dispatches by
`notification.method`. Notifications carrying a `turnId` other than
`ctx.turnId` are ignored (mid-flight cross-turn isolation). All
references below are to `cardAdapter.ts` unless noted.

| v2 notification | Field(s) read | cardBuilder call(s) | Site |
|-----------------|---------------|---------------------|------|
| `turn/started` | — | (no-op; provider already added the user card) | 172–174 |
| `turn/completed` | `params.turn.{id, status, error}` | `finalize(status, error)` → `flushText`, `cb.finalizeAssistantText()`, await `tokens.awaitTurnUsage` (250 ms grace), then `emitStreamEnd({success: status==='completed', interrupted?, error?, tokenUsage?})` | 176–181 / 727–759 |
| `thread/tokenUsage/updated` | full payload | `tokens.observe(params)` — TokenAccounting maps thread-cumulative onto per-turn deltas + raw cumulatives surfaced via `CardStreamEnd.tokenUsage` | 183–187 |
| `item/started` (see per-item table below) | `params.{turnId, item}` | varies by `item.type` | 189–194 / 407–529 |
| `item/completed` (see per-item table below) | `params.{turnId, item}` | varies by `item.type` | 196–201 / 531–678 |
| `item/agentMessage/delta` | `params.delta` | `bufferText(delta)` (150 ms debounce → `cb.assistantText`); tracks emitted-char count per `itemId` for completed-time residual | 203–211 |
| `item/reasoning/summaryTextDelta` / `item/reasoning/textDelta` | `params.delta` | `cb.thinkingBlock(delta)` (skipped if `delta.trim()` is empty); tracks emitted-char count to suppress duplicate completed-time emit | 213–225 |
| `item/reasoning/summaryPartAdded` | — | `flushText()` (boundary marker — commits any in-flight text before the next reasoning section) | 227–232 |
| `item/commandExecution/outputDelta` | `params.delta` | Append into `commandOutputBuffers[itemId]`, then `cb.toolResult(itemId, accumulated, false)` (overwrite-style update; truncation handled by cardBuilder) | 234–244 |
| `turn/plan/updated` | `params.{turnId, plan, explanation}` | `cb.toolUse('TodoWrite', { todos }, plan:${turnId})` with `planStatusToTodoStatus` mapping; optional `cb.systemMessage(explanation, 'info')` | 246–251 / 714–725 |
| `serverRequest/resolved` | `params.requestId` | `cb.clearPendingInput(String(requestId))` | 253–258 |
| `error` | `params.{turnId?, willRetry, error}` | `emitErrorOnce` → `cb.systemMessage('Error: ' + message, 'error')`; deduped by `(codexErrorInfo, message)` so `error` followed by `turn/completed { status: 'failed' }` carrying the same message renders one card | 260–266 |
| `warning` / `configWarning` / `deprecationNotice` | `params.message` | `cb.systemMessage(text, 'warning')` | 268–275 |
| `guardianWarning` | `params.{threadId, message}` | `cb.systemMessage('Guardian: ' + message, 'warning')` (filtered to current `threadId`) | 277–284 |
| `model/rerouted` | `params.{turnId, fromModel, toModel, reason}` | `cb.systemMessage('Model rerouted: …', 'info')` | 286–305 |
| `model/verification` | `params.{turnId, verifications}` | `cb.systemMessage('Account verification: …', 'warning')` | 307–322 |
| `mcpServer/startupStatus/updated` | `params.{name, status, error}` | `cb.systemMessage('MCP server "…" failed to start…', 'error')` (only on `status === 'failed'`) | 324–342 |
| Phase-2-dropped notifications | — | Silent drop: `item/autoApprovalReview/*`, `thread/closed`, `thread/status/changed`, `thread/name/updated`, `thread/started`, `thread/archived`, `thread/unarchived`, `thread/compacted`, `item/fileChange/patchUpdated`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`, `item/plan/delta`, `turn/diff/updated`, `rawResponseItem/completed`, `item/commandExecution/terminalInteraction` | 344–368 |
| Out-of-band notifications | — | Silent drop: `account/*`, `app/list/updated`, `command/exec/outputDelta`, `externalAgentConfig/*`, `fs/changed`, `fuzzyFileSearch/*`, `hook/*`, `mcpServer/oauthLogin/completed`, `skills/changed`, `thread/realtime/*`, `windows/worldWritableWarning`, `windowsSandbox/setupCompleted` | 376–399 |

Per-`item.type` dispatch inside `item/started` / `item/completed`
(`handleItemStarted` 407, `handleItemCompleted` 531):

| `item.type` | Started | Completed |
|-------------|---------|-----------|
| `userMessage` / `hookPrompt` | (no-op; provider emitted user card) | (no-op) |
| `agentMessage` | `bufferText(item.text)` if non-empty; record emitted-char baseline | `flushText`, residual `cb.assistantText(slice)` if `item.text` exceeds emitted, then `cb.finalizeAssistantText()` |
| `reasoning` | (deltas drive emission) | If no deltas were emitted, `cb.thinkingBlock(summary)` (or `content` fallback) |
| `commandExecution` | `flushText`, `cb.toolUse('Bash', { command }, item.id)` | `cb.toolUse('Bash', …)` if `!hasToolCard`; `cb.toolResult(id, accumulated + '[exit code: N]', status==='failed')` |
| `fileChange` | `flushText`, per-change `cb.toolUse('Write'\|'Edit', …, cardId)` (cardId = `id` if 1 change, `id#i` otherwise). `parseUnifiedDiff` populates `old_string`/`new_string`. NO result. | Same toolUse re-emit (patches refreshed input/diff) + per-change `cb.toolResult(cardId, '${kind}: ${path}', failed)` |
| `mcpToolCall` | `flushText`, `cb.toolUse('${server}:${tool}', arguments, item.id)` | toolUse if missing; `cb.toolResult(id, mcpResultText(item), failed)` (text blocks OR `structuredContent` JSON OR error message fallback) |
| `webSearch` | `flushText`, `cb.toolUse('WebSearch', { query: extractWebSearchQuery(item) }, item.id)` (action fallback for empty query) | **Always** re-emit `cb.toolUse('WebSearch', …)` (patches the now-populated query), then `cb.toolResult(id, 'Search: ' + query, false)` |
| `dynamicToolCall` | `flushText`, `cb.toolUse('${namespace}:${tool}' \| tool, arguments ?? {}, id)` | toolUse if missing; `cb.toolResult(id, stringifyDynamicToolResult(item), item.success === false)` |
| `plan` | `cb.systemMessage('[plan] ' + text, 'info')` | (no-op) |
| `imageView` | `cb.systemMessage('[image: ' + path + ']', 'info')` | (no-op) |
| `imageGeneration` | `cb.systemMessage('[generating image: …]', 'info')` | `cb.systemMessage('[image generated\|generation failed: …] → savedPath', 'info'\|'error')` |
| `enteredReviewMode` / `exitedReviewMode` | `cb.systemMessage('Entered\|Exited review mode: …', 'info')` | (no-op) |
| `collabAgentToolCall` | `flushText`, `cb.toolUse('collab:' + tool, …, id)` | toolUse if missing; `cb.toolResult(id, '${tool} → ${status} (agents: N)', status==='failed')` |
| `contextCompaction` | `cb.systemMessage('Context compacted', 'compacted')` | (no-op) |

Boundary calls outside the dispatch table (`codexAppServer/provider.ts`):

- **Turn lifecycle wrapping** (`runTurnImpl`, provider.ts:251–303):
  - `cb.startNewTurn()` + `cb.userMessage(prompt)` are called *before* `turn/start`.
  - On `turn/start` request failure: synthetic `emitStreamEnd({success: false, error})` (provider.ts:286–293) — the adapter's `finalize` doesn't run.
  - On transport close before `turn/completed`: adapter's `closeFallback` emits a synthetic `interrupted` stream-end (cardAdapter.ts:766–770).
  - `finally`: `await cb.persistCards()` + `cb.clearCards()` (provider.ts:294–302).
- **Adapter exception isolation** (cardAdapter.ts:159–167): a thrown error inside `handleNotification` is caught and surfaced as a `system 'error'` card so the run loop keeps going.

### 4.3. Claude CLI → cardBuilder mapping

For symmetry / migration parity. Driven by `claudeCliProvider.ts` parsing
the CLI's `--output-format stream-json` lines.

| CLI stream message | Field(s) | cardBuilder call(s) | Site |
|--------------------|----------|---------------------|------|
| `system { subtype: 'init' }` | `session_id`, `model` | (consumed at spawn time, not via cb); `callbacks.onModelDetected(model)` | claudeCliProvider.ts (init handling) |
| `system { subtype: 'task_started', description, task_id, tool_use_id }` | description, ids | `flushText`, `cb.subagentStart(description, task_id, tool_use_id)` | 700–702 |
| `system { subtype: 'task_progress', task_id, tool_use_id, usage.tool_uses, last_tool_name }` | counts | `cb.subagentProgress(...)` | 703–705 |
| `system { subtype: 'task_notification', task_id, tool_use_id, status, summary }` | terminal status | `cb.subagentEnd(...)` | 706–708 |
| `system { subtype: 'compact_boundary' }` | `compact_metadata.{trigger, pre_tokens}` | `flushText`, `cb.systemMessage('Context compacted (…)', 'compacted')`; `callbacks.onCacheTouch?.()` | 709–722 |
| `stream_event { event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }` | text | `bufferText(text)` (150 ms debounce → `cb.assistantText`) | 727–736 |
| `assistant.message.content[] { type: 'thinking', thinking }` | thinking text | `cb.thinkingBlock(thinking)` (skipped if empty) | 755–758 |
| `assistant…content[] { type: 'redacted_thinking' }` | — | `cb.thinkingBlock('[Redacted thinking]')` | 759–760 |
| `assistant…content[] { type: 'text', text }` | text | `cb.finalizeAssistantText()` if streaming was active; ELSE `cb.assistantText(text)`. Avoids double-content on stream-event delta + finalize race. | 761–770 |
| `assistant…content[] { type: 'tool_use', name, input, id }` | `name`, `input`, `id` | `callbacks.onToolUse?.()`; if name !== 'Agent' → `cb.toolUse(name, input, id)`. Agent tool_use is suppressed because the subagent system messages drive the SubagentCard. | 771–775 |
| `assistant…content[] { type: 'server_tool_use' \| 'mcp_tool_use' }` | `name`, `input`, `id` | `cb.toolUse(name ?? type, input, id ?? '')` | 776–779 |
| `assistant…content[] { unknown type }` | preview | `cb.systemMessage('[type] preview', 'info')` | 780–785 |
| `user.message.content` (string) | content | `flushText`, `cb.userMessage(content)` | 794–798 |
| `user…content[] { type: 'text', text }` | text | `flushText`, `cb.userMessage(text)` | 800–804 |
| `user…content[] { type: 'tool_result', tool_use_id, content, is_error }` | extracted text | `cb.toolResult(tool_use_id, text, !!is_error)` | 805–809 |
| `user…content[] { type: '*_tool_result' }` (web_search/web_fetch/mcp/code_execution/tool_search) | content text | `cb.toolResult(parentId, text, !!is_error)` | 810–820 |
| `user…content[] { unknown type }` | preview | `cb.systemMessage('[type] preview', 'info')` | 821–826 |
| `result { subtype, terminal_reason, total_cost_usd, usage, errors, session_id }` | terminal reason, tokens, cost | `flushText`, optional `cb.systemMessage('User interrupted')` if `terminal_reason ∈ {aborted_tools, aborted_streaming}`, `cb.finalizeAssistantText()`, `emitStreamEnd({success, error, interrupted, totalCostUsd, tokenUsage:{input, output, cacheCreation, cacheRead}})`. Then `cb.scheduleDeferredClear()`. | 833–884 |
| permission `control_request` | tool_name, input, tool_use_id | (NOT a direct cb call — flows through `callbacks.handlePermissionRequest` → SessionManager → `cb.toolCallFromPermission`) | 669–672, sessionManager.ts:1224–1280 |

---

## 5. Builder state machine

Per-session `StreamCardBuilder` instance is owned by SessionManager (one
per active session, stored in `ManagedSession.cardBuilder`,
sessionManager.ts:154, 484, 639).

### 5.1. Held state (cardBuilder.ts:210–227)

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
   `currentTextCardId` is reset (cardBuilder.ts:239–241).
2. **Stream.** Provider feeds events through the public mutators §4.1.
   `currentTextCardId` is set by the first `assistantText` and reset by
   any of: `userMessage`, `thinkingBlock`, `toolUse`/`toolCallFromPermission`,
   `subagentStart`, `finalizeAssistantText`. (The reset enforces "tool
   calls split a streaming text run into separate cards".)
3. **End.** Provider calls `cb.finalizeAssistantText()` (no-op if no
   active text card) and emits `CardStreamEnd` via
   `callbacks.emitStreamEnd`. SessionManager flips
   `ManagedSession.streaming = false` (sessionManager.ts:1164–1167).
4. **Persist + clear.**
   - Memory mode (Codex): `await cb.persistCards()` then `cb.clearCards()`
     synchronously in `runTurnImpl`'s `finally`
     (codexAppServer/provider.ts:294–302).
   - Claude-jsonl mode: `void cb.scheduleDeferredClear()`
     (claudeCliProvider.ts:881). Polls JSONL file size, waits for
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
`toolUseIdToCardId` (cardBuilder.ts:216) keys all later updates
(`toolResult`, `setToolAnswers`, `clearPendingInput` for permission cases,
`hasToolCard`).

For Codex this id is `ThreadItem.id` from the v2 schema
(codexAppServer/cardAdapter.ts:433, 447, 460, 469, 567, 605, …). For
file_change with N>1 entries, the adapter derives child IDs as
`${item.id}#${i}` (cardAdapter.ts:687). The plan card uses the synthetic
id `plan:${turnId}` (cardAdapter.ts:719).

For Claude this id is `block.id` from the assistant message's `tool_use`
block (claudeCliProvider.ts:774) and the `tool_use_id` field of the
matching `tool_result` user-side block (807).

### 5.5. Subagent correlation

`agentIdToCardId` (cardBuilder.ts:218) is keyed on the SDK's `task_id`
(Claude). Lookups also fall back to `toolUseId` so callers don't need to
know which key they have (cardBuilder.ts:577–578, 592–593). **Codex has
no analogue today** — `subagentStart`/`Progress`/`End` are unused on the
Codex path.

### 5.6. CardId format

`${sessionId}:${seq}` for streaming (cardBuilder.ts:370).
`${sessionId}:h:${seq}` for history-derived cards
(cardBuilder.ts:746). The seq counter is monotonic per
`StreamCardBuilder` instance; never reset by `clearCards` or
`startNewTurn`.

---

## 6. Invariants

| # | Invariant | Why it matters | Where enforced |
|---|-----------|----------------|----------------|
| **I1** | **CardEvent ordering matches provider event arrival.** A consumer that applies events in order produces the same `Card[]` snapshot. | The PWA never re-sorts. A reordered append-then-add produces a missing card. | Single-threaded notification dispatch in `consumeAppServerStream` (codexAppServer/cardAdapter.ts:155–168); single-threaded readline pump in Claude `consumeStream` (claudeCliProvider.ts:622–624). No queue between cb call and `emitCardEvent`. |
| **I2** | **`assistant_text` deltas only ever append.** They never replace prior text, and never produce two `add` events for the same logical message run. | The PWA renders `text` cumulatively; a replace would visibly flicker. | `currentTextCardId` accumulator + `appendTextEvent` mutating in place (cardBuilder.ts:394–400). The Codex adapter feeds true per-chunk deltas from `item/agentMessage/delta`; the Claude provider feeds `text_delta` deltas. |
| **I3** | **A second assistant_message in the same turn does NOT double-emit characters belonging to the new item.** | Regression risk — chunked deltas could replay text already emitted, or completed-time residual could double the tail. | `agentMessageEmittedChars` map keyed by `itemId` (cardAdapter.ts:58, 207–209, 535–540) tracks per-item baselines so completed-time emits only the residual slice. |
| **I4** | **Tool calls and tool results are paired by provider toolUseId.** | If pairing breaks, results show up as orphan cards (or not at all — `toolResult` returns null on miss). | `toolUseIdToCardId` (cardBuilder.ts:216). `toolResult` returns null when the id is unknown (541–542). Pinned by `cardBuilder.test.ts` toolResult/toolUse pairing tests. |
| **I5** | **Tool results are truncated at 500 chars; the truncation flag is wire-visible.** | The PWA needs to know to offer "show more" without re-fetching. | `TOOL_RESULT_TRUNCATE_LENGTH = 500` (cardBuilder.ts:21). `toolResult` 540–550. Pinned by `cardBuilder.test.ts` truncation tests. |
| **I6** | **`update.patch` with `null` value clears the key, not sets it to null.** | `JSON.stringify(undefined)` drops the key on the bus, so the agent uses `null` as the wire sentinel. The receiver must `delete` after merging. | cardBuilder.ts:381–390. Pinned by `cardBuilder.edge.test.ts`. |
| **I7** | **Permission cards survive a tool_use that fires before canUseTool, and vice versa.** Whichever arrives first creates the card; the second patches it. | Without this, the card-builder duplicates a single tool invocation on the wire. | `toolCallFromPermission` patches when `toolUseIdToCardId.has(id)` (cardBuilder.ts:483–487). Mirror in `toolUse` (452–456). |
| **I8** | **Ephemeral permission cards are removed by `clearPendingInput`; non-ephemeral cards keep their tool_call card with `pendingInput: null`.** | Subagent permission UIs are throwaway; tool permissions persist as audit. | cardBuilder.ts:507–520. |
| **I9** | **A turn that aborts emits `interrupted: true` AND (Claude) prepends a `system: 'User interrupted'` card.** | The PWA distinguishes user cancel from agent error. | Codex: cardAdapter.ts:747–755 sets `interrupted: true` on `turn/completed { status: 'interrupted' }` (no extra system card today). Claude: claudeCliProvider.ts:844–846. |
| **I10** | **Codex `tokenUsage` is reported as a per-turn delta, with the raw thread-cumulative attached on three extra fields.** | The v2 protocol delivers cumulative usage via `thread/tokenUsage/updated`; the PWA's per-turn cost UI assumes deltas. The cumulative is round-tripped through eventStore so a daemon restart can re-seed. | `TokenAccounting.observe` + `awaitTurnUsage` (codexAppServer/tokenAccounting.ts) and `toCardStreamEndUsage`; emitted at `finalize` (cardAdapter.ts:737–742). `LastTurnInfo` eventStore.ts:53–63; recorded by `service/run.ts:311–340`. |
| **I11** | **`CardStreamEnd` fires exactly once per turn.** | Bus subscribers use it as the per-turn boundary marker. | `state.turnEnded` flag in the Codex adapter (cardAdapter.ts:76, 156, 731–732) and `cliSession.resultEmitted` in Claude path (610, 630, 643). |
| **I12** | **For memory-mode (Codex), `persistCards()` strips `pendingInput` and forces `streaming: false` on `assistant_text` before writing.** | A reload-time `streaming: true` would leave the UI showing a typing indicator forever. A persisted `pendingInput` would point at a long-stale requestId. | cardBuilder.ts:262–268. Pinned by `cardBuilder.edge.test.ts`. |
| **I13** | **Stream end without `turn/completed` still emits a synthetic stream-end.** | Otherwise the PWA waits forever; "session finished" never fires. | Codex: provider's catch-block synthetic failure stream-end (provider.ts:286–293) plus the adapter's `closeFallback` interrupted end (cardAdapter.ts:766–770). Claude: `if (!cliSession.resultEmitted)` (claudeCliProvider.ts:643–645). |
| **I14** | **The card-builder never emits a `Card` whose `type` is not in the closed `Card` union.** Unknown provider blocks fall back to `system { subtype: 'info' }` with a `[type]` prefix. | Forward-compat: a future SDK shipping a new block type doesn't crash the PWA. | claudeCliProvider.ts:780–785, 821–826; cardBuilder.ts:941–949 (history path). |
| **I15** | **A v2 `error` notification becomes a system error card; the turn is still expected to terminate via `turn/completed`.** | A mid-turn `error` is non-terminal — Codex retries are signaled by `willRetry: true` (silenced) and a final terminal status arrives via `turn/completed`. | cardAdapter.ts:260–266. |
| **I16** | **A repeated error message (mid-turn `error` plus terminal `turn/completed { status: 'failed' }` carrying the same message) is rendered exactly once.** | Avoid double-emitting "Connection lost" + the failed turn error. | `seenErrors` set keyed by `(codexErrorInfo, message)` in `emitErrorOnce` (cardAdapter.ts:140–147). |

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

### 7.3. `apps/agent/src/ai/codexAppServer/__tests__/cardAdapter.test.ts`

**The Codex provider's primary regression net.** Drives
`consumeAppServerStream` with v2 notifications via a paired
`InMemoryTransport` and observes `CardEvent`s through a stub
`ProviderCallbacks`. Suites cover:

- `agentMessage` chunked deltas accumulate into a single
  `assistant_text` card and finalize on `item/completed`.
- `reasoning` summaryTextDelta / textDelta produce `thinking` cards;
  whitespace-only deltas are skipped; defensive completed-time fallback
  emits the summary (or `content`) when no deltas fired.
- `commandExecution` started → `Bash` tool_call; outputDelta accumulates
  into `result.content`; completed appends `[exit code: N]` and flips
  `isError` when `status === 'failed'`.
- `fileChange` per-change Write/Edit with `parseUnifiedDiff`-derived
  `old_string` / `new_string`; child IDs `${id}#${i}` for multi-change
  items.
- `mcpToolCall` `${server}:${tool}` naming; result text from text blocks
  / structuredContent / error message.
- `webSearch` placeholder query at started, real query on completed
  (re-emit patches the input).
- `turn/completed` success path emits stream-end with
  `TokenAccounting`-derived per-turn delta + cumulative.
- `turn/completed { status: 'failed' }` plus mid-turn `error` carrying
  the same message renders exactly one system card (R3 dedup).
- `turn/completed { status: 'interrupted' }` sets `interrupted: true`.
- `serverRequest/resolved` clears the matching pending input.
- `turn/plan/updated` produces a `TodoWrite` tool_call keyed by
  `plan:${turnId}`.

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

## 8. Migration notes (SDK → app-server v2)

The Codex provider was migrated from `@openai/codex-sdk` (Thread API)
to the `codex app-server` JSON-RPC v2 protocol. The card-stream
contract (Sections 3, 5, 6) was preserved end-to-end; only the
provider→cardBuilder adapter changed. Concrete implementation choices
that the v2 protocol forced and that future maintainers should be aware
of:

- **Per-turn token usage is reconstructed from `thread/tokenUsage/updated`.**
  v2 ships cumulative usage at thread granularity. `TokenAccounting`
  (codexAppServer/tokenAccounting.ts) buffers observations and computes
  the per-turn delta in `awaitTurnUsage` (250 ms grace at `turn/completed`,
  cardAdapter.ts:32, 737–741). Resume-time re-fires of
  `thread/tokenUsage/updated` are NOT counted as a new turn.
- **`item/agentMessage/delta` carries true deltas**, not cumulative text.
  The adapter calls `bufferText(notification.delta)` directly and tracks
  `agentMessageEmittedChars` only to compute the residual at
  `item/completed` time (cardAdapter.ts:203–211, 535–540).
- **`item/commandExecution/outputDelta` carries chunks**; the adapter
  accumulates per `itemId` in `commandOutputBuffers` and calls
  `cb.toolResult(id, accumulated, false)` on each chunk so the card
  builder's truncation logic sees the full string (cardAdapter.ts:234–244).
- **Plan items replaced TodoListItems.** `turn/plan/updated` is mapped
  to `cb.toolUse('TodoWrite', { todos }, plan:${turnId})` with
  `planStatusToTodoStatus` translating `pending`/`inProgress`/`completed`
  (cardAdapter.ts:714–725, 906–917). Free-text `plan` items render as
  `system info` (cardAdapter.ts:474–478).
- **No `ErrorItem` in v2.** Errors arrive via the top-level `error`
  notification (with `codexErrorInfo`) and/or `turn/completed { status:
  'failed' }`. `emitErrorOnce` dedupes by `(codexErrorInfo, message)`
  so one logical error renders one system card (cardAdapter.ts:140–147).
  `error.willRetry === true` is silenced (transparent server retry).
- **`serverRequest/resolved` drives `cb.clearPendingInput`.** Permission
  card dismissal is now provider-pushed instead of inferred from the
  `responsePendingInput` flow on the bus (cardAdapter.ts:253–258).
- **Item-id stability.** v2 `ThreadItem.id`s are namespaced per-thread;
  the adapter never crosses turn boundaries because `cb.persistCards`
  + `cb.clearCards` runs in `runTurnImpl`'s `finally` (provider.ts:294–302).
- **Synthetic stream-ends.** Two paths handle missing `turn/completed`:
  the provider's catch-block emits a synthetic failure if `turn/start`
  itself rejects; the adapter's `closeFallback` emits a synthetic
  `interrupted` end if the transport closes mid-turn.

The legacy SDK code (`codexSdkProvider.ts`, `consumeCodexStream`,
`takeAssistantDelta`, `loadCumulativeSeed`, etc.) has been removed.
`codexMcpProvider.ts` retains an alternate Codex provider on the older
MCP-style protocol.

---
