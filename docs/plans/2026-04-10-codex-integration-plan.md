# Codex Integration Plan

**Date:** 2026-04-13  
**Status:** Proposed

## Summary

Quicksave should integrate Codex as another `CodingAgentProvider`, not as a parallel service stack.

The old plan in this repo assumed:

- no provider abstraction yet
- a dedicated `CodexService`
- provider selection handled outside the shared session layer

That is no longer true. The current codebase already has:

- `CodingAgentProvider` in `apps/agent/src/ai/provider.ts`
- shared orchestration in `apps/agent/src/ai/sessionManager.ts`
- two Claude backends (`ClaudeCliProvider`, `ClaudeSdkProvider`)
- a provider-agnostic `Card` rendering pipeline in the PWA

So the right plan now is:

1. add a Codex provider implementation
2. make provider choice session-scoped instead of process-scoped
3. add provider metadata to shared types, registry, and UI
4. normalize Codex events into the existing `Card` model
5. introduce a provider-aware history strategy

## What Changed Since The Previous Plan

The previous version of this document is outdated in four important ways.

### 1. Provider abstraction already exists

We do not need a separate `CodexService` with its own lifecycle, event bus, and registry logic. That would duplicate `SessionManager`.

### 2. PWA card rendering is already generic enough

The PWA does not fundamentally care whether a turn came from Claude or Codex. It renders:

- `assistant_text`
- `thinking`
- `tool_call`
- `subagent`
- `system`

As long as the agent normalizes Codex events into these existing card types, the renderer mostly stays unchanged.

### 3. The current external protocol is still `claude:*`

Even though the internal architecture is now more generic, the WebSocket/shared message layer is still Claude-named (`claude:start`, `claude:get-cards`, `claude:session-updated`, etc.).

For the first Codex rollout, we should keep these wire message names to avoid a large compatibility migration. We add provider metadata inside the payloads instead.

### 4. `SessionManager` currently chooses provider by env var

Today, provider selection is process-wide via `QUICKSAVE_PROVIDER=sdk`. That is useful for development, but it is the wrong shape for real multi-provider support. Codex needs provider choice to be:

- chosen per new session
- persisted with the session
- respected on resume/history/listing

## External References

Official Codex docs worth treating as source-of-truth:

- Codex MCP server guide: https://developers.openai.com/codex/guides/agents-sdk
- Codex CLI flags: https://developers.openai.com/codex/cli/reference
- Codex auth: https://developers.openai.com/codex/auth

Key points confirmed from the official docs:

- `codex mcp-server` is an officially supported integration path
- the MCP server exposes `codex` and `codex-reply`
- current approval values are `untrusted`, `on-request`, and `never`
- `on-failure` is deprecated
- sandbox values are `read-only`, `workspace-write`, and `danger-full-access`
- API key auth is the recommended mode for programmatic Codex workflows

Local repo references to keep aligned:

- `docs/plans/2026-04-13-provider-abstraction.md`
- `docs/references/openai-codex-sdk-types.en.md`
- `docs/references/quicksave-architecture.en.md`

## Scope

### In Scope

- start/resume/list/use Codex sessions from Quicksave
- render Codex turns through the existing card UI
- support Codex permission prompts through the existing pending-input flow
- persist provider choice in session config and history
- keep Claude behavior unchanged

### Out Of Scope

- renaming the public wire protocol from `claude:*` to `coding:*`
- in-app OpenAI API key management UI
- cross-provider unified model presets
- migrating Claude history off its current JSONL source

## Decision

### ~~Primary backend: `CodexMcpProvider`~~ (rejected)

~~The first implementation should target a new provider via `codex mcp-server`.~~

**Outcome (2026-04-14):** A working `CodexMcpProvider` was built and tested. The MCP path is **rejected** due to:

- **No streaming** — `callTool` is request/response; no incremental text deltas
- **No persistent sessions** — MCP transport is torn down after each turn batch; cold resume has nothing to reconnect to
- **No approval flow** — `handlePermissionRequest` callback is never triggered; codex MCP doesn't send approval requests through the MCP notification channel
- **No interrupt** — no mechanism to cancel an in-flight `callTool`
- **Notification dead code** — `codex/event` notifications either don't arrive or arrive too late (after `activeTurn` is cleared)

The existing `codexMcpProvider.ts` remains in the repo as reference but should be replaced.

### Primary backend: `@openai/codex-sdk` (confirmed)

The implementation should use `@openai/codex-sdk` (`npm: @openai/codex-sdk`).

`apps/agent/src/ai/codexSdkProvider.ts`

Reasons:

- `startThread()` / `resumeThread(threadId)` — proper session persistence in `~/.codex/sessions`
- `runStreamed()` — async generator of `ThreadEvent` for real-time card updates
- `item.started` / `item.updated` / `item.completed` — maps directly to tool_call and assistant_text cards
- Approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) map to existing `handlePermissionRequest`
- `TurnOptions.signal` (AbortSignal) — clean interrupt semantics
- Thread stays alive between turns — no transport teardown
- Architecture mirrors `ClaudeCliProvider` closely (long-lived process, event stream, session persistence)

Type reference: `docs/references/openai-codex-sdk-types.en.md`

## Architecture

### 1. Shared provider identity

Add a shared provider identifier type, for example:

```ts
export type AgentProviderId = 'claude-cli' | 'claude-sdk' | 'codex-mcp';
```

This should be stored in:

- `ClaudeStartRequestPayload`
- `ClaudeSessionSummary`
- `ClaudeActiveSession`
- `SessionRegistryEntry`
- session config (`config.provider`)

### 2. SessionManager becomes provider-routed

Replace the current constructor pattern:

```ts
new SessionManager(new ClaudeCliProvider(), new ClaudeSdkProvider())
```

with a provider registry shape:

```ts
new SessionManager({
  'claude-cli': new ClaudeCliProvider(),
  'claude-sdk': new ClaudeSdkProvider(),
  'codex-mcp': new CodexMcpProvider(),
})
```

`SessionManager` should:

- choose provider from start payload or new-session config
- persist provider per session
- use that provider for resume
- include provider in session-updated/list/history responses

The env var can remain as a debug override, but it should stop being the primary product path.

### 3. Codex event normalization

Codex-specific transport events must be normalized into the existing `Card` model.

Target mapping:

- assistant text -> `assistant_text`
- reasoning -> `thinking`
- shell execution -> `tool_call` with `toolName: 'Bash'`
- file edit / patch -> `tool_call` with `toolName: 'Edit'` or `Write`
- web search/fetch -> existing web tool names when distinguishable
- approval wait -> existing `pendingInput` attachment
- turn end -> existing `card-stream-end`

Important rule: the PWA should not need a Codex-only renderer. Unknown Codex-specific tools may temporarily fall back to `FallbackToolView`, but the common tools should render through existing tool views.

### 4. Provider-aware history

This is the main architecture gap in the current design.

Right now `SessionManager.getCards()` assumes Claude JSONL via `buildCardsFromHistory(sessionId, cwd, ...)`.

That will not work for Codex.

We should add a history abstraction, either:

- `provider.getCardHistory(...)`, or
- a provider-owned history adapter registered alongside the provider

Recommended direction:

```ts
interface CodingAgentProvider {
  startSession(...)
  resumeSession(...)
  getHistory?(opts: ProviderHistoryOpts): Promise<CardHistoryResponse>
}
```

For v1 Codex, prefer Quicksave-owned normalized persistence over parsing internal Codex transcript files. That gives us:

- one stable history format regardless of provider internals
- full control over pending-input correlation
- simpler PWA recovery after reconnect

This can start as Codex-only if we want to minimize scope, but the abstraction should not hard-code Claude JSONL inside `SessionManager`.

### 5. Permission and sandbox mapping

Update the old mapping. The previous plan used `on-failure`; official Codex docs now mark that as deprecated.

Recommended mapping:

| Quicksave `permissionMode` | Codex approval | Codex sandbox |
|---|---|---|
| `default` | `untrusted` | `workspace-write` if sandboxed, otherwise `danger-full-access` |
| `acceptEdits` | `on-request` | `workspace-write` if sandboxed, otherwise `danger-full-access` |
| `bypassPermissions` | `never` | `workspace-write` if sandboxed, otherwise `danger-full-access` |
| `plan` | `untrusted` | `read-only` |

Notes:

- `plan` should force `read-only` regardless of the sandbox toggle
- the existing sandbox toggle means "restrict writes to project directory", so `sandboxed=false` should not silently downgrade to `workspace-write`
- if Codex exposes a dedicated planning mode or plan tool flag, wire it only after the basic turn lifecycle is stable

### 6. Auth and health checks

Codex requires local CLI availability and authentication.

For v1:

- do not build API key entry UI
- do add explicit preflight checks
- return actionable errors when `codex` is missing or unauthenticated

Minimum checks:

- `codex` executable exists on `PATH`
- one of:
  - Codex has a valid local login session
  - `OPENAI_API_KEY` is present

## Implementation Plan

### Phase 0: Transport Spike ✅ COMPLETE

Goal: validate whether MCP is sufficient for Quicksave's stream/card model.

**Result:** MCP is insufficient. Switched to `@openai/codex-sdk`. See Decision section above.

### Phase 1: Shared Type And Routing Changes ✅ COMPLETE

All shared types, routing, and PWA UI for multi-provider support are implemented:

- `AgentId = 'claude-code' | 'codex'` in shared types
- `SessionManager` routes by agent ID per session
- Provider persisted in session config, registry, and session-updated events
- PWA agent selector in new-session panel and settings drawer
- Agent selector locked on active sessions (can't switch mid-session)
- Dynamic Codex model list via OpenAI `/v1/models` API (12h cache)
- Per-agent model and reasoning effort UI

### Phase 2: Implement `CodexSdkProvider` ✅ COMPLETE

Files:

- `apps/agent/src/ai/codexSdkProvider.ts` (new — replaces `codexMcpProvider.ts`)
- `apps/agent/src/handlers/messageHandler.ts`

Implemented:

1. Installed `@openai/codex-sdk` (v0.120.0).
2. `startSession()` using `codex.startThread()` + `thread.runStreamed()`.
3. `resumeSession()` using `codex.resumeThread(threadId)` + `thread.runStreamed()`.
4. Full `ThreadEvent` → `CardEvent` mapping:
   - `item.started/updated` (`agent_message`) → `assistantText` (streaming with delta tracking)
   - `item.started/completed` (`command_execution`) → `toolUse('Bash')` + `toolResult`
   - `item.started/completed` (`file_change`) → `toolUse('Edit'/'Write')` + `toolResult`
   - `item.started/updated` (`reasoning`) → `thinkingBlock` (delta streaming)
   - `item.started/completed` (`mcp_tool_call`) → `toolUse` + `toolResult`
   - `item.started/completed` (`web_search`) → `toolUse('WebSearch')` + `toolResult`
   - `turn.completed` → `emitStreamEnd` with usage
   - `turn.failed` → `emitStreamEnd` with error
   - `error` → `systemMessage`
5. Approval: delegated to Codex CLI via `approvalPolicy` mapping (SDK v0.120.0 does not expose approval callbacks — interactive approval will require a future SDK version).
6. `interrupt()` via `AbortController.abort()` on `TurnOptions.signal`.
7. `kill()` by aborting + marking session closed.
8. `thread_id` from `thread.started` event reported as sessionId (first turn awaits it before returning).
9. Thread stays alive between turns — `sendUserMessage` calls `thread.runStreamed()` again on the same Thread instance.
10. Text buffering (150ms / 2KB threshold) for smooth streaming.
11. Shared `consumeCodexStream()` function with extracted item routing to avoid duplication between first turn and subsequent turns.

Known limitation:

- Codex SDK v0.120.0 does not expose approval request callbacks. The `approvalPolicy` CLI flag controls approval behavior. Interactive approval bridging (Phase 2 task 5) will need a future SDK version that exposes `requestApproval` events.

Exit criteria:

- a Codex session can be started, continued, interrupted, and resumed through the same card stream UI as Claude

### Phase 3: Provider-Aware History ✅ COMPLETE

Files:

- `apps/agent/src/ai/cardBuilder.ts`
- `apps/agent/src/ai/codexSdkProvider.ts`
- `apps/agent/src/ai/sessionManager.ts`

Implemented:

1. `persistCards()` method on `StreamCardBuilder` — appends current in-memory cards to `~/.quicksave/state/card-history/{sessionId}.json` before clearing.
2. `loadPersistedCards(sessionId)` function — loads persisted card history from disk.
3. `CodexSdkProvider` calls `persistCards()` before `clearCards()` at end of each turn (both initial and subsequent).
4. `SessionManager.getCards()` for memory-mode providers now loads persisted history + active streaming cards, supporting reconnect.
5. Pending-input overlays continue to work — they are applied after card loading regardless of provider mode.

Storage: `~/.quicksave/state/card-history/{sessionId}.json` — flat JSON array of Card objects, appended after each turn.

Exit criteria:

- reconnecting to an existing Codex session returns the expected cards
- history does not depend on undocumented Codex internal transcript files

### Phase 4: PWA Provider Selection And Minimal UX ✅ COMPLETE

All PWA provider selection and UX work is implemented:

- Agent selector (ButtonGroup) in NewSessionEmptyState and settings drawer
- Agent locked on active sessions (disabled ButtonGroup)
- Per-agent model lists (Claude: Haiku/Sonnet/Opus, Codex: dynamic from OpenAI API)
- Reasoning effort visible for both agents
- Provider badge in session list
- Archive session button in settings drawer
- Session agent pre-populated on start to avoid race with async session-updated event
- Log prefixes updated from `[claude:]` to `[agent:]` with agent= field

### Phase 5: Validation And Hardening ✅ COMPLETE

Files:

- `apps/agent/src/ai/codexSdkProvider.test.ts` (new — 21 tests)
- `apps/agent/src/ai/sessionManager.test.ts` (6 new tests added)
- `apps/agent/src/ai/cardBuilder.test.ts` (pre-existing persistence tests)

Implemented:

1. **Codex event normalization tests** (21 tests in `codexSdkProvider.test.ts`):
   - `thread.started` → `onThreadStarted` callback
   - `agent_message` streaming: `item.started` → text, `item.updated` → delta, `item.completed` → finalize
   - `reasoning` → `thinkingBlock` with delta tracking
   - `command_execution` → `Bash` tool_call + tool_result with exit code
   - `file_change` → `Edit`/`Write` tool_call + tool_result
   - `mcp_tool_call` → `server:tool` tool_call
   - `web_search` → `WebSearch` tool_call
   - `error` item → system error message
   - `turn.completed` → streamEnd with token usage
   - `turn.failed` → streamEnd with error
   - `error` event → system error card
   - stream ends without turn event → fallback success
   - full multi-item turn integration test
2. **Provider routing tests** (6 tests in `sessionManager.test.ts`):
   - Start routes to codex when `agent: 'codex'`
   - Start routes to claude when `agent: 'claude-code'`
   - Resume remembers agent per session
   - `session-updated` events include agent
   - `getActiveSessions` reports agent
   - `getCards` uses memory mode for codex sessions
3. **Card persistence tests** (pre-existing in `cardBuilder.test.ts`):
   - `loadPersistedCards`: missing file, valid file, invalid JSON, non-array
   - `persistCards`: no cards, strip pendingInput + streaming, append to existing

All 602 tests pass across 20 test files.

## Risks

### 1. ~~MCP event surface may be too thin~~ (confirmed — switched to SDK)

~~Mitigation: do Phase 0 first; keep SDK fallback available~~

**Outcome:** Confirmed. MCP was too thin. Now using `@openai/codex-sdk`.

### 2. Current provider abstraction is lifecycle-only

Codex exposes that history is provider-specific.

Mitigation:

- extend the abstraction in a narrow, explicit way
- do not branch on provider everywhere inside `SessionManager`

### 3. `claude:*` wire naming is now misleading

Mitigation:

- tolerate it for v1
- track a later protocol rename as separate work

### 4. Codex auth/install failures will look like product bugs if not surfaced cleanly

Mitigation:

- add preflight checks and actionable start errors early

## Recommended Order

1. ~~Phase 0 transport spike~~ ✅
2. ~~Phase 1 shared routing/types~~ ✅
3. ~~Phase 2 Codex SDK provider~~ ✅
4. ~~Phase 3 history~~ ✅
5. ~~Phase 4 PWA selection UI~~ ✅
6. ~~Phase 5 hardening/tests~~ ✅

## Acceptance Criteria

- a user can start a new session with provider `codex-mcp`
- the agent remembers that provider and resumes correctly
- Codex output appears through the existing card UI
- Codex approval prompts use the existing pending-input flow
- existing Claude sessions still work without behavior regressions
- reconnect/history for Codex sessions works through Quicksave-owned state
