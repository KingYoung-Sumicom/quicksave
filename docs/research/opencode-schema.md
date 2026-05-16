# opencode Stream Event Schema

Extracted from `@opencode-ai/sdk/v2` OpenAPI definition for `anomalyco/opencode` (dev branch).

> **Usage note:** This schema documents the server-side SSE event types emitted via `/event` (SSE endpoint). The CLI `run` command's `--format json` flag emits its own internal event stream with a similar but distinct shape — the CLI's format is based on `ToolFrame`/`StreamCommit` objects (internal to `@opencode-ai/core/tool`), not the OpenAPI `Part` types. See the "CLI vs SDK distinction" section below.

---

## Part Union (stream event payloads)

All stream `Part` types share these base fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` (pattern `^prt`) | Yes | Unique part ID |
| `sessionID` | `string` (pattern `^ses`) | Yes | owning session ID |
| `messageID` | `string` (pattern `^msg`) | Yes | owning message ID |
| `type` | `enum` | Yes | discriminant |

Each subtype defines its own additional fields below.

---

### TextPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: integer; end?: integer }
  metadata?: object
}
```

---

### ReasoningPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "reasoning"
  reasoning: string
  time?: { start: integer; end?: integer }
  metadata?: object
}
```

---

### FilePart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "file"
  mime: string
  url: string
  filename?: string
  source: FilePartSource
}
```

#### FilePartSource (discriminated union on `kind`)

| kind | Fields |
|------|--------|
| `"embed"` | `url: string` |
| `"workspace"` | `path: string` |
| `"remote"` | `url: string` |

---

### ToolPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "tool"
  callID: string
  tool: string          // tool name: bash, edit, write, task, read, glob, grep, lsp, webfetch, websearch, skill, todo, question, batch, apply_patch, etc.
  state: ToolState      // discriminated union
  metadata?: object
}
```

#### ToolState (discriminated union on `status`)

| status | Required fields | Notes |
|--------|----------------|-------|
| `"pending"` | `input: object`, `raw: string` | First state emitted |
| `"running"` | `input: object`, `time: { start: int }`, `title?: string`, `metadata?: object` | Progress updates |
| `"completed"` | `input, output: string, title: string, metadata: object, time: { start, end }, attachments?: FilePart[]` | Final state |
| `"error"` | `input, error: string, time: { start, end }, metadata?: object` | Error state |

---

### StepStartPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "step-start"
  snapshot?: string    // text snapshot of the step
}
```

---

### StepFinishPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "step-finish"
  reason: string
  snapshot?: string
  cost: number
  tokens: {
    total: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}
```

---

### SubtaskPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "subtask"
  prompt: string
  description?: string
  agent?: string
  model?: {
    providerID: string
    modelID: string
  }
  command?: string
  status?: string
  time?: { created?: int; started?: int; ended?: int }
}
```

---

### PatchPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "patch"
  patch: string        // unified diff
  files: number        // number of files
  time?: { start?: int; end?: int }
  metadata?: object
}
```

---

### AgentPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "agent"
  agent: string
  model?: {
    providerID: string
    modelID: string
  }
  status?: string
  time?: { created: int }
}
```

---

### RetryPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "retry"
  attempt: integer
  error: string
  time: { created: int }
}
```

---

### CompactionPart

```
{
  id: string         (^prt)
  sessionID: string  (^ses)
  messageID: string  (^msg)
  type: "compaction"
  auto: boolean
  overflow?: boolean
  tail_start_id?: string  (^msg)
}
```

---

## Event Union (SSE event types)

Each event follows this envelope:

```
{
  id: string
  type: string         // event type discriminator
  properties: object   // event-specific payload
}
```

### Session lifecycle events

| Type | Properties |
|------|-----------|
| `session.status` | `{ sessionID: ^ses; type: "idle" \| "retry"; attempt?: int; message?: string; action?: … }` |
| `session.idle` | `{ sessionID: ^ses }` |
| `session.compacted` | `{ sessionID: ^ses; summary?: { additions: number; deletions: number; files: number; diffs: SnapshotFileDiff[] }; time: { compacted: int } }` |
| `session.diff` | `{ sessionID: ^ses; diff: SnapshotFileDiff[] }` |
| `session.error` | `{ sessionID: ^ses; error: { type: string; name?: string; message?: string; provider?: string; … } }` |
| `session.created` | `{ sessionID: ^ses; model?: Model; agent?: string; title?: string }` |
| `session.deleted` | `{ sessionID: ^ses }` |

#### SessionStatus (retry action detail)

```
{
  reason: string
  provider: string
  title: string
  message: string
  label: string
  link?: string
}
```

### Turn sub-events (prefixed with `session.next.`)

| Type | Description | Key properties |
|------|-------------|---------------|
| `session.next.prompted` | User sent a prompt | `{ sessionID, prompt: PromptInput, model?: Model }` |
| `session.next.synthetic` | Synthetic message (undo/redo) | `{ sessionID, messageID, type: string }` |
| `session.next.shell.started` | PTY session opened | `{ sessionID, shellID, pty }` |
| `session.next.shell.ended` | PTY session closed | `{ sessionID, shellID, exitCode }` |
| `session.next.step.started` | LLM step started | `{ sessionID, stepID, model, variants, time: { start } }` |
| `session.next.step.ended` | LLM step completed | `{ sessionID, stepID, time: { start, end }, tokens: { input, output, reasoning, cache }, cost }` |
| `session.next.step.failed` | LLM step error | `{ sessionID, stepID, error: { … }, time: { start, end } }` |
| `session.next.text.started` | Text streaming started | `{ sessionID, messageID }` |
| `session.next.text.delta` | Text chunk | `{ sessionID, messageID, partID: ^prt, text: string }` |
| `session.next.text.ended` | Text streaming finished | `{ sessionID, messageID }` |
| `session.next.reasoning.started` | Reasoning started | `{ sessionID, messageID }` |
| `session.next.reasoning.delta` | Reasoning chunk | `{ sessionID, messageID, partID: ^prt, text: string }` |
| `session.next.reasoning.ended` | Reasoning finished | `{ sessionID, messageID }` |
| `session.next.tool-input-started` | Tool input began | `{ sessionID, messageID, partID: ^prt, name: string, input: object }` |
| `session.next.tool-input-delta` | Tool input text delta | `{ sessionID, messageID, partID: ^prt, text: string }` |
| `session.next.tool-input-ended` | Tool input finished | `{ sessionID, messageID, partID: ^prt, name: string, input: object }` |
| `session.next.tool-called` | Tool call made | `{ sessionID, messageID, callID: string, partID: ^prt, name: string, input: object }` |
| `session.next.tool.progress` | Tool progress update | `{ sessionID, messageID, callID, partID: ^prt, title: string }` |
| `session.next.tool.success` | Tool completed | `{ sessionID, messageID, callID, partID: ^prt, name: string, output: string, time: { start, end }, attachments?: FilePart[] }` |
| `session.next.tool.failed` | Tool error | `{ sessionID, messageID, callID, partID: ^prt, name: string, error: string, time: { start, end } }` |
| `session.next.retried` | Retry attempt | `{ sessionID, messageID, partID: ^prt, attempt: int, error: string }` |
| `session.next.compaction.started` | Context compaction started | `{ sessionID }` |
| `session.next.compaction.delta` | Compaction progress | `{ sessionID, messageID, partID: ^prt }` |
| `session.next.compaction.ended` | Compaction finished | `{ sessionID, messageID, partID: ^prt }` |

### Agent/model switching

| Type | Properties |
|------|-----------|
| `session.next.agent.switched` | `{ sessionID, agent: string, model?: Model }` |
| `session.next.model.switched` | `{ sessionID, model: Model }` |

### System events

| Type | Properties |
|------|-----------|
| `message.part-delta` | `{ directory: string; messageID: ^msg; partID: ^prt; text: string }` |
| `permission.asked` | `{ sessionID: ^ses; permission: string; patterns: string[]; metadata: object; always: string[]; tool: { messageID, callID }; source?: string }` |
| `permission.replied` | `{ sessionID: ^ses; permission: string; action: "allow" \| "deny"; patterns?: string[] }` |
| `question.asked` | `{ sessionID: ^ses; question: { id?, text: string; questions: { text: string; options?: string[]; required?: boolean }[]; type?: string; meta?: object }; time: { created: int } }` |
| `question.replied` | `{ sessionID: ^ses; question: { id: string; reply?: string[] } }` |
| `question.rejected` | `{ sessionID: ^ses; question: { id: string } }` |
| `todo.updated` | `{ sessionID: ^ses; todos: TodoItem[] }` |
| `server.connected` | `{ version: string; installDir: string }` |
| `global.dispose` | `{}` |

---

## Request: Creating a prompt turn

When using the SDK HTTP API (`/session/{id}/prompt`, POST):

```
{
  prompt: {
    text: string           // user message
    files?: PromptFileAttachment[]
    agents?: PromptAgentAttachment[]
    references?: PromptReferenceAttachment[]
  }
  model?: {
    id?: string
    providerID?: string
    modelID?: string
  }
  agent?: string
  variant?: string       // model variant string
  thinking?: boolean     // show reasoning blocks
  fork?: boolean         // fork from current session
  resume?: boolean       // resume paused session
  title?: string         // initial session title
  files?: FilePartInput[] // file attachments
  includeFiles?: boolean  // whether to send file attachments
  limit?: string
}
```

---

## Shared Type Definitions

### PermissionAction

```
enum: "allow" | "deny" | "ask"
```

### PermissionRule

```
{
  permission: string
  pattern: string
  action: PermissionAction
}
```

### PermissionRuleset

```
array<PermissionRule>
```

### PermissionRequest

```
{
  id: string          (^per)
  sessionID: string   (^ses)
  permission: string
  patterns: string[]
  metadata: object
  always: string[]
  tool?: {
    messageID: string (^msg)
    callID: string
  }
}
```

### Session

```
{
  id: string          (^ses)
  slug: string
  projectID: string
  workspaceID: string (^wrk)
  directory: string
  path: string
  parentID?: string   (^ses)
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: SnapshotFileDiff[]
  }
  cost: number
  tokens?: {
    input, output, reasoning, 
    cache: { read, write }   // all numbers
  }
  share?: { url: string }
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  time: {
    created: int
    updated: int
    compacting?: int
    archived?: number
  }
  permission?: PermissionRuleset
  revert?: {
    messageID: string (^msg)
    partID?: string (^prt)
    snapshot?: string
    diff?: string
  }
}
```

### SessionStatus (discriminated union on `type`)

| type | Fields |
|------|--------|
| `"idle"` | (none) |
| `"retry"` | `attempt: int`, `message?: string`, `action: RetryAction` |

### SnapshotFileDiff

```
{
  file: string
  patch: string
  additions: number
  deletions: number
  status: string        // "added" | "modified" | "deleted" | "renamed"
}
```

### Model

```
{
  id: string
  providerID: string
  api?: { id: string; url: string; npm: string }
  name?: string
  family?: string
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    output: {
      text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean
    }
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" }
  }
  cost?: {
    input: number
    output: number
    cache: { read: number; write: number }
  }
  variants?: Record<string, string>  // variant label -> description
  limits?: Record<string, number>    // rate limits
}
```

### Provider

```
{
  id: string
  name: string
  models: {
    [modelID: string]: {
      id: string
      name: string
      family?: string
      capabilities: Model.capabilities
      cost?: Model.cost
      variants: Record<string, string>
    }
  }
  defaultModel?: string
}
```

### Prompt

```
{
  text: string
  files?: PromptFileAttachment[]
  agents?: PromptAgentAttachment[]
  references?: PromptReferenceAttachment[]
}
```

### Config

```
{
  providers?: Record<string, ProviderConfig>
  permissions?: PermissionConfig
  tools?: Record<string, object>
  [additional]: unknown
}
```

### PromptFileAttachment

```
{
  mime: string
  url: string
  filename?: string
  source: FilePartSource
}
```

### PromptReferenceAttachment

```
{
  url: string
  method: "auto" | "code"
  instructions: string
}
```

### PromptAgentAttachment

```
{
  name: string
  dir?: string
}
```

### TodoItem

```
{
  content: string
  status: string      // "pending" | "in_progress" | "completed"
  priority: string    // "high" | "medium" | "low"
  children?: string[] // subtask IDs
}
```

---

## CLI vs SDK Distinction

### CLI `run --format json` — verified against opencode CLI installed 2026-05

The non-interactive `opencode run [message] --format json` command emits a **different** stream format than the SSE `/event` endpoint. The shape below was captured live from `opencode run --format json --model opencode/big-pickle …` runs (text-only, tool-using, reasoning, and error scenarios). Earlier drafts of this doc described an internal `StreamCommit` (`{kind, phase, sessionId, …}`) shape that the CLI does **not** emit — do not rely on it.

#### Envelope

Every JSONL line is an envelope with this shape:

```jsonc
{
  "type": <string>,           // event discriminator (snake_case, e.g. "step_start")
  "timestamp": <ms>,          // epoch ms
  "sessionID": "ses_…",       // server-assigned session id (CAPITAL "ID")
  "part"?:  { … },            // present on all non-error events
  "error"?: { … }             // present only when type === "error"
}
```

Notes:
- The session id key is `sessionID` (not `sessionId`) and the value is whatever the server assigned for the run. There is no `kind`/`phase` discriminator.
- There is **no `session` envelope** to mark end-of-stream. The CLI signals completion by exiting; consumers must attach `proc.on('exit')` and emit their own end event.
- `part.type` uses *hyphen* case (`step-start`, `step-finish`, `tool`, `text`, `reasoning`) while the envelope `type` uses snake_case (`step_start`, `step_finish`, `tool_use`, `text`, `reasoning`). They are not the same string.

#### Per-`type` part shapes

- `type: "step_start"` — start of a model step (a sub-iteration of the turn).
  ```jsonc
  { "part": { "id": "prt_…", "messageID": "msg_…", "sessionID": "ses_…", "type": "step-start" } }
  ```

- `type: "step_finish"` — end of a step. Carries token + cost accounting.
  ```jsonc
  {
    "part": {
      "id": "prt_…", "messageID": "msg_…", "sessionID": "ses_…",
      "type": "step-finish",
      "reason": "tool-calls" | "stop" | "length" | "error" | …,
      "tokens": { "total": int, "input": int, "output": int,
                  "reasoning": int, "cache": { "write": int, "read": int } },
      "cost": number
    }
  }
  ```

- `type: "text"` — a *complete* assistant text part (not a delta). Each `text` envelope is independent; multi-part replies arrive as multiple envelopes.
  ```jsonc
  {
    "part": {
      "id": "prt_…", "messageID": "msg_…", "sessionID": "ses_…",
      "type": "text",
      "text": "…",
      "synthetic"?: bool,
      "ignored"?: bool,
      "time"?: { "start": int, "end"?: int }
    }
  }
  ```

- `type: "reasoning"` — complete reasoning trace (also non-delta).
  ```jsonc
  {
    "part": {
      "id": "prt_…", "messageID": "msg_…", "sessionID": "ses_…",
      "type": "reasoning",
      "text": "…",
      "time"?: { "start": int, "end"?: int }
    }
  }
  ```

- `type: "tool_use"` — tool invocation. Status is on `part.state.status`.
  ```jsonc
  {
    "part": {
      "id": "prt_…", "messageID": "msg_…", "sessionID": "ses_…",
      "type": "tool",
      "tool": "read" | "bash" | "edit" | …,
      "callID": "call_…",
      "state": {
        "status": "pending" | "running" | "completed" | "error",
        "input"?: { … },
        "output"?: string,       // present on completed
        "error"?: string,        // present on error
        "metadata"?: { … },
        "title"?: string,
        "time"?: { "start": int, "end"?: int }
      }
    }
  }
  ```
  In practice the consumer sees `tool_use` events once per state transition; the terminal one carries `completed`/`error`. There may not be a separate `running` event for fast tools.

- `type: "error"` — terminal error envelope. The process typically exits non-zero after this. No `part` field.
  ```jsonc
  {
    "type": "error",
    "timestamp": <ms>,
    "sessionID": "ses_…",
    "error": { "name": "UnknownError", "data"?: { "message": "Model not found: …" } }
  }
  ```

#### Mapping CLI envelopes to quicksave CardEvent

| Envelope `type`          | quicksave action                                                |
|--------------------------|------------------------------------------------------------------|
| `step_start`             | Finalize any open assistant text bubble (next text goes new card).|
| `step_finish`            | (informational — usage/cost; no card)                            |
| `text`                   | `assistantText(part.text)` + `finalizeAssistantText()`           |
| `reasoning`              | `thinkingBlock(part.text)`                                       |
| `tool_use` (new callID)  | `toolUse(tool, state.input, callID)` + `onToolUse(…)` callback   |
| `tool_use` (status=completed / error) | `toolResult(callID, state.output or state.error, isError)` |
| `error`                  | Surface as visible card + `emitStreamEnd({success:false, error})`|
| _process exit_           | `emitStreamEnd({success: code===0 && !lastError})` + `onSessionExited` |

The reference implementation lives at `apps/agent/src/ai/openCodeProvider.ts`. Its `consumeStream()` follows the table above.

#### Model id requirement

`--model` requires `provider/model` (e.g. `opencode/big-pickle`, `vllm/palmfuture/Qwen3.6-…`). A bare id like `claude-opus-4-7` makes the server respond with a generic 500 (`"Unexpected server error"`) and produce no useful output. The provider validates with `isValidOpenCodeModelId()` and drops invalid values so the CLI falls through to the config default.

---

## Relevant SDK Types (Input)

When sending prompts via the HTTP API, these input types apply:

### TextPartInput

```
{
  type: "text"
  text: string
  id?: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start: int; end?: int }
  metadata?: object
}
```

### FilePartInput

```
{
  type: "file"
  mime: string
  url: string
  id?: string
  filename?: string
  source?: FilePartSource
}
```

### AgentPartInput

```
{
  type: "agent"
  name: string
  id?: string
  source?: {
    kind: string
    model?: { providerID: string; modelID: string }
    dir?: string
  }
}
```

### SubtaskPartInput

```
{
  type: "subtask"
  prompt: string
  id?: string
  description?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  command?: string
}
```