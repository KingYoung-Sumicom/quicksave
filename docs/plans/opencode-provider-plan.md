# Implementation Plan: OpenCode Provider for Quicksave

Goal: Integrate `anomalyco/opencode` as a CodingAgentProvider for Quicksave's SessionManager, mirroring the pattern established by `openHarnessProvider.ts`.

---

## Architecture Overview

```
SessionManager
  └── OpenCodeProvider (new)
        ├── spawn() → `opencode run [prompt] --format json [flags]`
        ├── JSONL parser → StreamCommit interpretation
        ├── CardEvent emitter (text_delta, tool_call, end, error)
        └── Permission/sandbox flag mapping (--dangerously-skip-permissions)
```

---

## Phase 1: Provider Skeleton & Spawn

**File:** `apps/agent/src/ai/openCodeProvider.ts`

### 1.1 OpenCodeProvider Class

```typescript
class OpenCodeProvider implements CodingAgentProvider {
  static readonly id: "opencode"
  readonly capabilities: AgentCapabilities

  opts: {
    readonly modelId?: string
    readonly apikey?: string
    readonly dangerouslySkipPermissions?: boolean
  }

  async startSession(params: ProviderSession): Promise<ProviderSession>
  async resumeSession(params: ProviderSession): Promise<ProviderSession>
  dispose?(): Promise<void>
}
```

### 1.2 Spawn Logic

Launch `opencode run` as a child process:

- Binary: `opencode` (must be in PATH or resolved via `pnpm`/`npm` prefix)
- Args: `run` + message + `--format json` + model flag (`-m`)
- Working directory from `params.cardBuilder.baseDir`
- Stdout parsed as JSONL stream
- Stderr used for debug logging

### 1.3 Model Flag Mapping

| Prop | CLI Flag | Format |
|------|----------|--------|
| `modelId` | `-m` / `--model` | `"providerID/modelID"` |
| `agent` (optional) | `--agent` | `"build"` or `"plan"` |

Extract available providers/models from `opencode --help` or use default.

---

## Phase 2: JSONL Stream Parser

**Same file, internal module:** `parseOpenCodeStream()`

### 2.1 Parser Architecture

Consume stdout line-by-line. Each line is a `StreamCommit` object (from `docs/research/opencode-schema.md`). Map to `CardEvent`.

### 2.2 Event Mapping

| StreamCommit (kind/phase) | CardEvent | Fields |
|---------------------------|-----------|--------|
| `step, start` | `tool_call` | `callId: stepId`, `name: "step"` |
| `tool, start` | `tool_call` | `callId: part.callID`, `name: tool`, `input` |
| `tool, progress` | `text_delta` | Append `part.raw` (stdout) |
| `tool, final` | `tool_delta` | Append output title |
| `tool, final` (completed) | `end` | Status: `completed`, attachments |
| `tool, final` (error) | `error` | Error message |
| `tool, final` (failed) | `error` | Tool failure message |
| `text, progress` | `text_delta` | `text` |
| `reasoning, progress` | `reasoning_delta` | `text` |
| `session, final` | `end` | `usage: null`, `stepCost: null` |

### 2.3 Tool Call Deduplication

Track active tool calls by `tool` name. When a new tool starts while one is active, close the previous one. Use `part.state.status` transitions:

- `pending → running`: emit `tool_call` if not already open
- `running`: emit accumulated stdout as `text_delta`
- `completed`/`error`: close with final result or error

### 2.4 Session Boundary Detection

- Exit condition: `session, final` with `status: "idle"` or process exit (SIGPIPE)
- Capture `usage` and `stepCost` from step-finish event
- Handle `retry` status → log warning, don't re-execute (single-shot CLI)

---

## Phase 3: Permission & Sandbox

**File:** `apps/agent/src/ai/openCodeProvider.ts`

### 3.1 Permission Skip Flag

Default behavior (production): pass `--dangerously-skip-permissions` to pre-approve all tool calls. The sandbox enforcement happens at the OS level via the quicksave daemon, not per-command.

### 3.2 File Attachment Handling

Convert `AttachmentRef[]` → `opencode` file format:

- `opencode` accepts files via stdin content or `--file` / `--dir` flags
- For `--format json` mode, embed file contents in the prompt text with markdown markers (````filepath`...````) — same pattern as the agent's stdin prompt

### 3.3 Working Directory

Set `--dir` flag to the card's base directory.

---

## Phase 4: Integration

### 4.1 Registration in messageHandler.ts

**File:** `apps/agent/src/handlers/messageHandler.ts`

Add `opencode` to the `AgentId` union and routing switch:

```typescript
const PROVIDER_ID_MAP: Record<AgentId, typeof CodingAgentProvider | undefined> = {
  // existing...
  "opencode": OpenCodeProvider,
}
```

### 4.2 Provider Selection Heuristic

- If `agentId === "opencode"` → use OpenCodeProvider
- If `agentId` is undefined but model matches an opencode provider → auto-detect
- Validate opencode binary is available; fallback to error with diagnostic

---

## Phase 5: Testing

**File:** `apps/agent/src/ai/openCodeProvider.test.ts`

Tests delegate to a context-isolated subagent (per CLAUDE.md guidelines).

### 5.1 Unit Tests

| Test | What |
|------|------|
| `startSession` returns session with correct properties | CardEvent emission triggers, user input handling |
| Spawn args construction | Correct `--format json`, model, directory, permissions flags |
| Spawn fails gracefully | Error handling when binary not found |
| Stdout parsing — text only | Stream emits `text_delta` for user message and response |
| Stdout parsing — tool calls | Deduplication works, completion/error states |
| Stdout parsing — session boundary | `end` event emitted, cancelled state on process exit |
| Stdout parsing — error event | Error propagated, session marked errored |
| Stdout parsing — reasoning blocks | `reasoning_delta` emitted |
| Attachment mapping | Files embedded correctly in prompt |
| `startSession` handles empty prompt | Validates input |
| `dispose` cleanup | Process killed on provider disposal |
| `resumeSession` support | Returns error or delegates to startSession (CLI is single-shot) |

### 5.2 Integration Test (Optional, gated)

- Run `opencode run --format json "Hello"` locally
- Parse output, verify stream shape
- Assert text content present

### 5.3 Test Delegation

Write a spec file `docs/plans/opencode-provider-test-spec.md` for a subagent, referencing:
- `apps/agent/src/ai/openHarnessProvider.test.ts` for style conventions
- `apps/agent/src/ai/provider.ts` for the `CardEvent` type
- `apps/agent/src/ai/openCodeProvider.ts` for the public API
- `docs/research/opencode-schema.md` for stream event shapes

---

## File Changes Summary

| File | Action | Scope |
|------|--------|-------|
| `apps/agent/src/ai/openCodeProvider.ts` | **Create** | Provider class + stream parser (~400-500 lines) |
| `apps/agent/src/ai/openCodeProvider.test.ts` | **Create** | Unit tests (delegated to subagent) |
| `apps/agent/src/handlers/messageHandler.ts` | **Modify** | Add `opencode` to `MessageContext`, `AgentId` union, routing |
| `packages/shared/src/types.ts` | **Modify** | Add `"opencode"` to `AgentId` union (if not already registered) |

---

## Implementation Order

1. `openCodeProvider.ts` — provider class + spawn + stream parser
2. Tests for `openCodeProvider.ts`
3. `messageHandler.ts` routing registration
4. `shared/src/types.ts` AgentId union update
5. Run `cd apps/agent && npx vitest run` to verify
