# Pi Coding Agent — Event Format Reference

> **Source:** `@earendil-works/pi` monorepo (cloned to `/tmp/pi-repo` during development)
>
> **Key files:**
> - `packages/agent/src/types.ts` — `AgentEvent` union, agent loop types
> - `packages/coding-agent/src/modes/rpc/rpc-types.ts` — RPC command/response/event types
> - `packages/coding-agent/src/modes/rpc/jsonl.ts` — JSONL framing (LF-only)
> - `packages/coding-agent/src/modes/rpc/rpc-client.ts` — `RpcClient` API surface

---

## 1. Session File Format (JSONL)

Pi stores sessions as newline-delimited JSON (JSONL) files under `PI_CODING_AGENT_DIR/sessions/<project-id>/<session-id>.jsonl`. Each line is a JSON object with a `type` field.

### Entry types

| `type` field | Purpose | Shape |
|---|---|---|
| `"session"` | Header: session metadata, model, thinking level | `{ type: "session", sessionId: string, model?: string, thinkingLevel?: string, ... }` |
| `"message"` | User / assistant / tool-result / bash-execution message | `{ type: "message", message: AgentMessage, timestamp?: number }` |
| `"compaction"` | Summary produced by context compaction | `{ type: "compaction", summary: string, tokensBefore: number, ... }` |
| `"session_info"` | Session metadata updates (name, etc.) | `{ type: "session_info", name?: string, ... }` |

> **Note:** The session file format is **not** directly compatible with Quicksave's card history reader. Quicksave's Pi provider uses `'memory'` history mode, tracking cards in-memory only.

---

## 2. `AgentEvent` — Core Event Stream

**Definition** (`packages/agent/src/types.ts`):

```typescript
export type AgentEvent =
  // ── Agent lifecycle (start/end of the entire run) ──
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }

  // ── Turn lifecycle (one assistant response + its tool calls/results) ──
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }

  // ── Message lifecycle (emitted for user, assistant, and tool-result messages) ──
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }

  // ── Tool execution lifecycle ──
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

### Event sequence for a simple text response

```
agent_start
turn_start
message_start       { message: { role: "user", content: "..." } }
message_end         { message: { role: "user", ... } }
message_start       { message: { role: "assistant", content: [] } }
message_update      { message, assistantMessageEvent: { content: [{ type: "text", text: "Hello" }] } }
message_end         { message: { role: "assistant", ... } }
turn_end            { message: { role: "assistant" }, toolResults: [] }
agent_end           { messages: [...] }
```

### Event sequence for a tool call (sequential mode)

```
agent_start
turn_start
message_start       { role: "user" }
message_end         { role: "user" }
message_start       { role: "assistant" }
message_update      { assistantMessageEvent: { content: [{ type: "toolCall", toolName: "Bash", input: {...}, toolCallId: "tc-1" }] } }
message_end         { role: "assistant" }
tool_execution_start { toolCallId: "tc-1", toolName: "Bash", args: {...} }
tool_execution_update { toolCallId: "tc-1", toolName: "Bash", partialResult: {...} }
tool_execution_end   { toolCallId: "tc-1", toolName: "Bash", result: {...}, isError: false }
message_start       { role: "assistant", content: [{ type: "text", text: "Done!" }] }
message_update      { ... }
message_end         { role: "assistant" }
turn_end            { message, toolResults: [ToolResultMessage] }
agent_end           { messages }
```

### `message_update` content blocks

The `assistantMessageEvent.content` array can contain these block types:

| `type` | Fields | Description |
|---|---|---|
| `"text"` | `text: string` | Plain assistant text |
| `"toolCall"` | `toolCallId: string`, `toolName: string`/`name: string`, `input: object`/`arguments: object`, `id?: string` | A tool invocation |
| `"thinking"` | `thinking: string`, `text?: string` | Model's chain-of-thought reasoning |
| `"image"` | (image-specific) | Image content |

> **Mapping note:** In `piProvider.ts`, the event bridge reads `toolName ?? name` and `input ?? arguments` to handle field name variations across Pi versions.

### `tool_execution_*` events vs `message_update` tool calls

Pi emits tool events in **two parallel streams**:

1. **Message stream**: `message_update` with content blocks (`type: "toolCall"`) — these appear in the assistant message's content array.
2. **Execution stream**: `tool_execution_start` / `tool_execution_update` / `tool_execution_end` — these fire independently as tools run.

In **parallel mode**, the execution stream events arrive in **tool completion order**, not definition order. In **sequential mode**, they arrive in the same order as the tool calls in the assistant message.

---

## 3. RPC Protocol (JSONL stdin/stdout)

Pi's RPC mode uses **strict LF-only JSONL framing** (`\n` delimiters, no `\r`). Each line is a JSON object. Commands are sent on **stdin**; responses and events arrive on **stdout**.

### Framing details

- **Line separator:** `\n` (LF only) — no CRLF handling
- **No batching:** each JSON object is exactly one line
- **Error handling:** partial lines or invalid JSON are silently dropped
- **Source:** `packages/coding-agent/src/modes/rpc/jsonl.ts`

> **Quicksave implementation note:** The `piProvider.ts` event bridge reads from the `RpcClient.onEvent()` callback, which internally handles the JSONL parsing. Do **not** use Node's `readline` module — it splits on `\n` but can corrupt Unicode. Always use the `RpcClient` abstraction.

### RPC Commands (stdin → agent)

Each command has an optional `id` field for correlating responses. If omitted, the agent assigns one.

#### Prompting

| Command | Fields | Response |
|---|---|---|
| `"prompt"` | `message: string`, `images?: ImageContent[]`, `streamingBehavior?: "steer" \| "followUp"` | `response { success: true }` + event stream |
| `"steer"` | `message: string`, `images?: ImageContent[]` | `response { success: true }` + event stream |
| `"follow_up"` | `message: string`, `images?: ImageContent[]` | `response { success: true }` + event stream |
| `"abort"` | (none) | `response { success: true }` |
| `"new_session"` | `parentSession?: string` | `response { success: true; data: { cancelled: boolean } }` |

#### State

| Command | Response |
|---|---|
| `"get_state"` | `response { success: true; data: RpcSessionState }` |

#### Model management

| Command | Response |
|---|---|
| `"set_model"` | `response { success: true; data: Model<any> }` |
| `"cycle_model"` | `response { success: true; data: { model, thinkingLevel, isScoped } \| null }` |
| `"get_available_models"` | `response { success: true; data: { models: Model<any>[] } }` |

#### Thinking level

| Command | Response |
|---|---|
| `"set_thinking_level"` | `response { success: true }` |
| `"cycle_thinking_level"` | `response { success: true; data: { level: ThinkingLevel } \| null }` |

#### Session management

| Command | Response |
|---|---|
| `"switch_session"` | `response { success: true; data: { cancelled: boolean } }` |
| `"get_messages"` | `response { success: true; data: { messages: AgentMessage[] } }` |
| `"get_session_stats"` | `response { success: true; data: SessionStats }` |
| `"export_html"` | `response { success: true; data: { path: string } }` |
| `"fork"` | `response { success: true; data: { text: string, cancelled: boolean } }` |
| `"clone"` | `response { success: true; data: { cancelled: boolean } }` |
| `"get_fork_messages"` | `response { success: true; data: { messages: Array<{ entryId, text }> } }` |
| `"get_last_assistant_text"` | `response { success: true; data: { text: string \| null } }` |
| `"set_session_name"` | `response { success: true }` |
| `"compact"` | `response { success: true; data: CompactionResult }` |
| `"set_auto_compaction"` | `response { success: true }` |
| `"get_commands"` | `response { success: true; data: { commands: RpcSlashCommand[] } }` |

#### Bash execution

| Command | Response |
|---|---|
| `"bash"` | `response { success: true; data: BashResult }` |
| `"abort_bash"` | `response { success: true }` |

### `RpcSessionState`

```typescript
export interface RpcSessionState {
  model?: Model<any>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}
```

### ThinkingLevel enum

```typescript
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

> **Mapping from Quicksave `reasoningEffort`:**
> - `"minimal"` → `"minimal"`
> - `"low"` → `"low"`
> - `"medium"` → `"medium"`
> - `"high"` → `"high"`
> - `"xhigh"` / `"max"` → `"high"` (pi does not support xhigh via RPC in all versions)

### Error responses

Any command can fail and return:
```json
{ "id": "...", "type": "response", "command": "<command-name>", "success": false, "error": "<string>" }
```

---

## 4. Extension UI Events (stdout only)

Pi extensions can emit UI requests. These are emitted as **event-style** objects on stdout:

```json
{ "type": "extension_ui_request", "id": "<uuid>", "method": "...", ... }
```

### Methods

| `method` | Shape | Description |
|---|---|---|
| `"select"` | `{ id, title, options: string[], timeout? }` | Dropdown picker |
| `"confirm"` | `{ id, title, message, timeout? }` | Confirmation dialog |
| `"input"` | `{ id, title, placeholder?, timeout? }` | Text input |
| `"editor"` | `{ id, title, prefill? }` | Code editor modal |
| `"notify"` | `{ id, message, notifyType?: "info" \| "warning" \| "error" }` | Notification toast |
| `"setStatus"` | `{ id, statusKey, statusText? }` | Update status bar |
| `"setWidget"` | `{ id, widgetKey, widgetLines?, widgetPlacement? }` | Update widget area |
| `"setTitle"` | `{ id, title }` | Update session title |
| `"set_editor_text"` | `{ id, text }` | Update editor content |

### Extension UI responses (stdin)

The host responds via stdin:
```json
{ "type": "extension_ui_response", "id": "<uuid>", "value": "<string>" }
```
or
```json
{ "type": "extension_ui_response", "id": "<uuid>", "confirmed": true }
```
or
```json
{ "type": "extension_ui_response", "id": "<uuid>", "cancelled": true }
```

> **Quicksave integration:** The current `piProvider.ts` does **not** handle extension UI requests. If an extension emits one, it arrives as an unknown `type` and is silently ignored by the event bridge (the `default` case).

---

## 5. Session File JSONL Record Shapes

### Session header (first entry)

```json
{
  "type": "session",
  "sessionId": "abc123",
  "cwd": "/path/to/project",
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
  "thinkingLevel": "medium",
  "timestamp": 1700000000000
}
```

### Message entry

```json
{
  "type": "message",
  "message": {
    "role": "user" | "assistant" | "toolResult" | "bashExecution",
    "content": "string" | [{ type: "text", text: "..." }, { type: "toolCall", ... }, { type: "thinking", ... }]
  },
  "timestamp": 1700000000000
}
```

### Compaction entry

```json
{
  "type": "compaction",
  "summary": "Human-readable summary of the conversation so far...",
  "tokensBefore": 12000,
  "timestamp": 1700000000000
}
```

### Session info entry

```json
{
  "type": "session_info",
  "name": "my session name",
  "timestamp": 1700000000000
}
```

---

## 6. Quicksave ↔ Pi Event Mapping

The `PiCodingAgentProvider` in `piProvider.ts` maps Pi events to Quicksave `CardEvent` types:

| Pi Event | Quicksave CardEvent | Notes |
|---|---|---|
| `agent_start` | (none) | Calls `cardBuilder.startNewTurn()` |
| `message_start` / `message_end` (user) | `card-user-message` | Extracts text from content blocks |
| `message_update` (assistant, text) | `card-assistant-text` | Streaming text deltas |
| `message_update` (assistant, toolCall) | `card-tool-use` | Also calls `onToolUse` callback |
| `message_update` (assistant, thinking) | `card-thinking-block` | Chain-of-thought display |
| `tool_execution_start` | `card-tool-use` | Also calls `onToolUse` callback |
| `tool_execution_update` | `card-system-message` (type: `"info"`) | Partial result, truncated to 200 chars |
| `tool_execution_end` | `card-tool-result` | Extracts text from result content |
| `turn_end` (assistant text) | `card-assistant-text` (flush) | Calls `finalizeAssistantText()` |
| `agent_end` | `card-assistant-text` (flush) + `emitStreamEnd` | Signals completion |

### Extract helpers

- **`extractTextContent(content)`** — flattens `[{ type: "text", text }]` arrays to `\n`-joined strings; returns raw string if content is already a string; returns `""` for invalid input.
- **`extractResultText(result)`** — extracts text from `{ content: [{ type: "text", text }] }` structures; falls back to `JSON.stringify(result)` for unknown formats; truncates to 2000 chars.

---

## 7. RPC Client API (Programmatic)

**Import:**
```typescript
import { RpcClient } from '@earendil-works/pi-coding-agent';
```

**Constructor options:**
```typescript
const client = new RpcClient({
  cliPath: string,              // Path to pi-coding-agent CLI
  cwd: string,                  // Working directory
  env: Record<string, string>,  // Environment (include PI_CODING_AGENT_DIR)
  provider?: string,            // e.g. "anthropic"
  model?: string,               // e.g. "claude-sonnet-4-5"
});
```

**Lifecycle methods:**

| Method | Returns | Description |
|---|---|---|
| `start()` | `Promise<void>` | Spawn process, establish JSONL pipe |
| `stop()` | `Promise<void>` | Kill process, clean up |
| `getState()` | `Promise<{ sessionId: string }>` | Get current session state |

**Prompting methods:**

| Method | Returns | Description |
|---|---|---|
| `prompt(message)` | `Promise<void>` | Send user prompt (async — events follow) |
| `promptAndWait(message)` | `Promise<AgentEvent[]>` | Send prompt and return all events until `agent_end` |
| `steer(message)` | `Promise<void>` | Send steering message mid-run |
| `followUp(message)` | `Promise<void>` | Send follow-up message |
| `abort()` | `Promise<void>` | Abort current turn |

**State/model methods:**

| Method | Returns | Description |
|---|---|---|
| `setModel(provider, modelId)` | `Promise<void>` | Switch model |
| `getAvailableModels()` | `Promise<Model[]>` | List available models |
| `setThinkingLevel(level)` | `Promise<void>` | Set thinking level |
| `cycleThinkingLevel()` | `Promise<{ level } \| null>` | Cycle to next level |

**Session methods:**

| Method | Returns | Description |
|---|---|---|
| `switchSession(path)` | `Promise<void>` | Switch to existing session file |
| `getMessages()` | `Promise<AgentMessage[]>` | Get full message history |
| `getSessionStats()` | `Promise<SessionStats>` | Get session statistics |
| `exportHtml()` | `Promise<{ path }>` | Export session as HTML |
| `getLastAssistantText()` | `Promise<string \| null>` | Get last assistant text |
| `setSessionName(name)` | `Promise<void>` | Set session name |
| `compact()` | `Promise<CompactionResult>` | Manually compact context |
| `newSession()` | `Promise<void>` | Create new session |

**Bash:**

| Method | Returns | Description |
|---|---|---|
| `bash(command)` | `Promise<BashResult>` | Execute bash command |

**Event subscription:**

| Method | Returns | Description |
|---|---|---|
| `onEvent(callback)` | `() => void` | Subscribe to events; returns unsubscribe function |

---

## 8. Agent Loop Extension Points (Config)

The agent loop (`@earendil-works/pi-agent-core`) supports these extension hooks via `AgentLoopConfig`:

### `beforeToolCall(context, signal)`
Called **before** a tool executes, after argument validation. Return `{ block: true, reason?: string }` to prevent execution.

### `afterToolCall(context, signal)`
Called **after** a tool finishes, before `tool_execution_end` events. Return partial overrides:
```typescript
{
  content?: (TextContent | ImageContent)[];  // Replace full content
  details?: unknown;                           // Replace details
  isError?: boolean;                           // Override error flag
  terminate?: boolean;                         // Hint: stop after this batch
}
```

### `shouldStopAfterTurn(context)`
Called after `turn_end`. Return `true` to emit `agent_end` and exit.

### `prepareNextTurn(context)`
Called after `shouldStopAfterTurn`. Return `AgentLoopTurnUpdate` to override context/model/thinking for the next turn.

### `getSteeringMessages()`
Called when the agent is idle. Return `AgentMessage[]` to inject steering messages.

### `getFollowUpMessages()`
Called when the agent would normally stop. Return `AgentMessage[]` to continue processing.

### `convertToLlm(messages)`
Converts `AgentMessage[]` to LLM-compatible `Message[]`. Must filter out non-LLM messages (notifications, UI).

### `transformContext(messages, signal)`
Optional pre-processing of the message context (e.g., token pruning).

### `getApiKey(provider)`
Dynamically resolves API keys per provider.

---

## 9. Known Quirks & Gotchas

### 9.1 Tool call field name variations
Pi's `message_update` content blocks may use either:
- `toolName` **or** `name` for the tool name
- `input` **or** `arguments` for tool arguments
- `toolCallId` **or** `id` for the tool call ID

The Quicksave bridge uses nullish-coalescing (`??`) to handle both:
```typescript
const toolName = block.toolName ?? block.name ?? 'Unknown';
const toolInput = block.input ?? block.arguments ?? {};
const toolId = block.toolCallId ?? block.id ?? '';
```

### 9.2 Parallel vs Sequential tool execution
In **parallel mode**, `tool_execution_end` events arrive in **completion order**, which may differ from the order of tool calls in the assistant message. Quicksave uses the `toolCallId` to correlate.

### 9.3 `agent_end` listener settle time
The agent is not truly idle until all `agent_end` subscribers have settled. `RpcClient.onEvent()` handles this internally.

### 9.4 Image/attachment support in RPC
Pi's RPC `prompt` command supports `images?: ImageContent[]`, but the Quicksave `piProvider.ts` does **not** pass attachments. Pi RPC currently lacks full image support in all modes. Attachments are persisted to disk via `persistAttachments()` for visibility on other tabs, but are not forwarded to the Pi agent.

### 9.5 JSONL framing
Pi's RPC transport uses **strict LF-only** line framing. Node.js `readline` will work in most cases but can split on `\n` within multi-byte Unicode sequences. The `RpcClient` handles this correctly; always use the `RpcClient` abstraction, never raw `process.stdout`/`process.stdin` reading.

### 9.6 Session file persistence
Pi writes session files **after** the first assistant message completes. During `startSession`, the session directory may exist but contain no `.jsonl` files. The `findPiSessionFile()` helper checks for `.jsonl` files before attempting `switchSession()`.

---

## 10. File Index

| File | Contents |
|---|---|
| `packages/agent/src/types.ts` | `AgentEvent`, `ThinkingLevel`, `AgentLoopConfig`, tool hooks, `AgentState`, `AgentTool` |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | `RpcCommand`, `RpcResponse`, `RpcSessionState`, extension UI events |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | `RpcClient` class implementation |
| `packages/coding-agent/src/modes/rpc/jsonl.ts` | JSONL framing utilities |
| `packages/coding-agent/src/core/agent-session.ts` | `AgentSession`, `SessionStats` |
| `packages/coding-agent/src/core/extensions/index.ts` | Extension hook system |
| `apps/agent/src/ai/piProvider.ts` | Quicksave's `PiCodingAgentProvider` (event bridge + process lifecycle) |
| `apps/agent/src/ai/__tests__/piProvider.test.ts` | Unit tests for event bridge, text extraction, permission modes |
