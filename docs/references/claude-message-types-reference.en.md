# Claude Session History Message Type Reference

This document covers every message type you will encounter when reading session history (`getSessionMessages`), explained across three layers:
1. **SDK raw layer**: the `SessionMessage[]` returned by `getSessionMessages`
2. **Application layer**: the `ClaudeHistoryMessage[]` produced after `claudeCodeService.getMessages()` transforms them
3. **Transport layer**: the `ClaudeGetMessagesResponsePayload` pushed to the PWA over WebSocket

---

## 一、SDK raw layer: `SessionMessage`

> Source: `@anthropic-ai/claude-agent-sdk` → `getSessionMessages(sessionId, { dir, includeSystemMessages: true })`

### Official API signature

```typescript
function getSessionMessages(
  sessionId: string,
  options?: {
    dir?: string;             // Project directory in which to look up the session; if omitted, all are searched
    limit?: number;           // Maximum number of entries returned starting from offset (note: the SDK's offset counts from the beginning; the application layer paginates from the tail itself)
    offset?: number;          // Number of leading entries to skip (counted from the beginning)
    includeSystemMessages?: boolean; // Whether to include the system type (default false)
  }
): Promise<SessionMessage[]>;
```

> **Important**: the official documentation only lists `"user" | "assistant"` for `SessionMessage.type`. `"system"` only appears when `includeSystemMessages: true`, and the `message` field — typed as `unknown` in the SDK — is the entire object itself for system messages (see 1c). This application always passes `includeSystemMessages: true` when calling.

### Type definition

```typescript
// sdk.d.ts (official)
type SessionMessage = {
  type: 'user' | 'assistant' | 'system';  // system requires includeSystemMessages: true
  uuid: string;               // Unique message identifier
  session_id: string;         // UUID of the owning session
  message: unknown;           // Actual content; depends on type (see the sections below)
  parent_tool_use_id: null;   // Reserved field, currently always null
};
```

**Additional runtime fields (informal — not present in `.d.ts`):**
- `isSidechain?: boolean`: subagent sidechain message. `getMessages()` filters these out via `.filter(m => !m.isSidechain)`.
- `agentId?: string`: agent ID for subagent messages.

> `SessionMessage` is the simplified format used for **history reads**. Live streaming uses the full `SDKMessage` union (which includes `SDKAssistantMessage`, `SDKResultMessage`, `SDKToolProgressMessage`, and 20+ other types). The two are distinct — do not mix them up.

---

### 1a. `type: 'assistant'` → `message` is a `BetaMessage`

For assistant messages, the `message` field is `@anthropic-ai/sdk`'s `BetaMessage`:

```typescript
// @anthropic-ai/sdk → resources/beta/messages/messages.d.ts
interface BetaMessage {
  id: string;                         // Message ID, format: msg_xxxxx
  role: 'assistant';
  content: BetaContentBlock[];        // Array of content blocks (see section 二)
  model: string;                      // Model used, e.g. 'claude-sonnet-4-6'
  stop_reason: StopReason;            // Stop reason
  stop_sequence: string | null;       // Set when stop_reason is 'stop_sequence'
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  container: { id: string; expires_at: string } | null;  // Code execution container
  type: 'message';                    // Fixed value
}

type StopReason =
  | 'end_turn'        // The model finished a turn naturally
  | 'max_tokens'      // The max_tokens cap was reached
  | 'stop_sequence'   // A custom stop sequence matched
  | 'tool_use'        // The model wants to invoke a tool (a tool_use block in content awaits execution)
  | 'pause_turn'      // Turn paused (during streaming)
  | 'incomplete';     // Interrupted due to a token limit
```

**Typical assistant message structure (plain-text reply):**
```json
{
  "type": "assistant",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": "ce304b01-c8cb-4f23-be8c-6c1ab848ad35",
  "parent_tool_use_id": null,
  "message": {
    "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "我來幫你..." }
    ],
    "model": "claude-sonnet-4-6",
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": { "input_tokens": 1024, "output_tokens": 128 },
    "container": null
  }
}
```

**Typical assistant message structure (tool call):**
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01A09q90qw90lq917835lq9",
        "name": "Bash",
        "input": { "command": "ls -la" }
      }
    ],
    "stop_reason": "tool_use"
  }
}
```

---

### 1b. `type: 'user'` → `message` is a `MessageParam`

For user messages, the `message` field is `@anthropic-ai/sdk`'s `MessageParam`:

```typescript
// @anthropic-ai/sdk → resources/messages.d.ts
type MessageParam = {
  role: 'user';
  content: string | Array<ContentBlockParam>;
};

// When content is an array, it can contain the following blocks:
// - TextBlockParam        { type: 'text', text: string }
//   → Text typed by the user
// - ToolResultBlockParam  { type: 'tool_result', tool_use_id, content, is_error? }
//   → Tool execution result (responding to the tool_use in the previous assistant message)
// - ImageBlockParam       { type: 'image', source: ... }
//   → Image attachment (less common)
// - DocumentBlockParam    { type: 'document', source: ... }
//   → Document attachment (less common)
```

**Typical user message structure (plain text):**
```json
{
  "type": "user",
  "uuid": "...",
  "session_id": "...",
  "parent_tool_use_id": null,
  "message": {
    "role": "user",
    "content": "幫我新增一個 feature"
  }
}
```

**Typical user message structure (tool result):**
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
        "content": [
          { "type": "text", "text": "total 0\ndrwxr-xr-x  2 user..." }
        ],
        "is_error": false
      }
    ]
  }
}
```

> `SDKUserMessage` also has `isSynthetic?: boolean` (a message synthesized by the SDK internally, not actual user input) and `tool_use_result?: unknown` fields, but neither typically affects how the UI renders during history reads.

---

### 1c. `type: 'system'` → system events (only present when `includeSystemMessages: true`)

For system messages the entire JSONL object **itself** is the system message structure; the `message` field is usually `null` or absent. The two most common variants in history are:

```typescript
// compact_boundary: marks a context compaction boundary
// (appears when a session grows long enough that older messages get compacted)
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
    preserved_segment?: {           // The segment of messages preserved uncompacted
      head_uuid: string;
      anchor_uuid: string;
      tail_uuid: string;
    };
  };
  uuid: string;
  session_id: string;
};

// init: session initialization (typically the very first message in a session)
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  cwd: string;                      // Working directory
  model: string;                    // Model
  tools: string[];                  // List of available tool names
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents?: string[];
  betas?: string[];
  slash_commands: string[];
  skills: string[];
  plugins: { name: string; path: string }[];
  apiKeySource: string;
  uuid: string;
  session_id: string;
};
```

> **Application-layer handling**: `claudeCodeService.getMessages()` does not distinguish between system subtypes — it converts all of them uniformly to `{ role: 'system', content: 'Context compacted' }`.

---

## 二、`BetaContentBlock` types in detail

Each block within `BetaMessage.content` is discriminated by its `type` field:

```typescript
type BetaContentBlock =
  | BetaTextBlock
  | BetaThinkingBlock
  | BetaRedactedThinkingBlock
  | BetaToolUseBlock
  | BetaServerToolUseBlock
  | BetaWebSearchToolResultBlock
  | BetaWebFetchToolResultBlock
  | BetaMCPToolUseBlock
  | BetaMCPToolResultBlock
  | BetaCodeExecutionToolResultBlock
  | BetaContainerUploadBlock;
```

### TextBlock — text reply

```typescript
interface BetaTextBlock {
  type: 'text';
  text: string;                        // Text content of Claude's reply
  citations: BetaTextCitation[] | null; // Citation sources (when documents/search were used)
}
```

### ThinkingBlock — extended thinking

```typescript
interface BetaThinkingBlock {
  type: 'thinking';
  thinking: string;   // Claude's internal reasoning (can be quite long)
  signature: string;  // Integrity signature for continuous conversations
}

interface BetaRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;       // Redacted thinking content (encrypted)
}
```

### ToolUseBlock — tool call (assistant → user)

```typescript
interface BetaToolUseBlock {
  type: 'tool_use';
  id: string;                          // Unique tool-call ID, format: toolu_xxxxx
  name: string;                        // Tool name, e.g. 'Bash', 'Read', 'Edit', 'Agent'
  input: unknown;                      // Call arguments (JSON object; varies per tool)
  caller?: BetaDirectCaller | BetaServerToolCaller;
}
```

Special `name` values:
- `'Agent'`: spawns a subagent; `input.description` is the task description. This block is skipped in `getMessages()` and represented via `subagentBlocks` instead.

### ToolResultBlock — tool result (within a user → assistant turn)

Appears inside the `content` array of a user message and corresponds to the `tool_use` from the previous assistant message:

```typescript
interface BetaToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;                   // ID of the corresponding tool_use block
  content?: string | Array<            // Tool execution result
    BetaTextBlockParam | BetaImageBlockParam | ...
  >;
  is_error?: boolean;                    // true if the tool call failed
  cache_control?: BetaCacheControlEphemeral | null;
}
```

---

## 三、Application layer: `ClaudeHistoryMessage`

`claudeCodeService.getMessages()` flattens the SDK's `SessionMessage[]` into a flat list of messages. **Each SDK message may expand into multiple `ClaudeHistoryMessage` entries** (one text block plus several tool_use/tool_result blocks).

```typescript
// packages/shared/src/types.ts
interface ClaudeHistoryMessage {
  index: number;           // Position of the originating SDK message within the session (0-based)
  role: 'user' | 'assistant' | 'system';
  content: string;         // Text content; empty string '' for tool_use/tool_result messages

  // Tool-call fields (role is assistant, derived from a tool_use block)
  toolName?: string;       // Tool name, e.g. 'Bash', 'Read'
  toolInput?: string;      // Tool input, JSON.stringify'd into a string
  toolUseId?: string;      // ID of the tool_use block (toolu_xxxxx)

  // Tool-result fields (role is user, derived from a tool_result block)
  toolResult?: string;     // Tool execution result text (truncated if it exceeds the limit)
  toolResultForId?: string; // The tool_use id this result corresponds to
  truncated?: boolean;     // Whether the result was truncated (exceeded TOOL_RESULT_TRUNCATE_LENGTH)
}
```

### Message-type mapping table

| SDK block type | `role` | `content` | Active fields |
|---|---|---|---|
| `text` block (assistant) | `assistant` | text content | `content` |
| `thinking` block | not converted; only appears in stream | — | — |
| `tool_use` block (non-Agent) | `assistant` | `''` | `toolName`, `toolInput`, `toolUseId` |
| `tool_use` block (Agent) | skipped → see subagentBlocks | — | — |
| `tool_result` block (non-Agent) | `user` | `''` | `toolResult`, `toolResultForId`, `truncated?` |
| `tool_result` block (Agent) | skipped → see subagentBlocks | — | — |
| `system` type (any subtype) | `system` | `'Context compacted'` | `content` |
| user with plain string content | `user` | text content | `content` |

> **Note**: when a text block belongs to the same assistant message as a tool_use block, the text gets `unshift`ed to the front and shares the same `index`.

---

## 四、subagentBlocks: subagent summaries

Agent tool_use blocks do not appear in the `messages` array; they are aggregated into `subagentBlocks` instead:

```typescript
// packages/shared/src/types.ts
interface ClaudeSubagentBlock {
  toolUseId: string;           // Maps to the Agent tool_use id in the parent session
  agentId: string;             // Currently identical to toolUseId
  description: string;         // The Agent tool's input.description (task description)
  summary?: string;            // Result summary extracted from tool_result (first 200 chars)
  status: 'running' | 'completed' | 'failed' | 'stopped';
  toolUseCount: number;        // Currently always 0 (not computed during history reads)
  lastToolName?: string;
}
```

Determination logic: if an Agent tool_use has a matching tool_result → `status: 'completed'`; otherwise → `status: 'running'`.

---

## 五、Response payload: `ClaudeGetMessagesResponsePayload`

The full payload returned from agent to PWA:

```typescript
// packages/shared/src/types.ts
interface ClaudeGetMessagesResponsePayload {
  messages: ClaudeHistoryMessage[];
  total: number;           // Total count of all SDK messages in the session (un-paginated)
  hasMore: boolean;        // Whether older messages remain (tailStart > 0)
  error?: string;

  // toolUseId → toolName mapping built from all messages (not just the current page)
  // Used by tool_result messages to look up the corresponding tool name
  toolNameMap?: Record<string, string>;

  subagentBlocks?: ClaudeSubagentBlock[];
}
```

### Pagination logic

```
For total SDK messages, take from the tail backwards:
  tailEnd   = max(0, total - offset)
  tailStart = max(0, total - offset - limit)
  sliced    = allMessages[tailStart..tailEnd]

hasMore = tailStart > 0
```

That is: `offset=0, limit=50` fetches the most recent 50 entries; `offset=50` fetches the 50 entries just before that.

---

## 六、UI Message format on the PWA side

The `messages` array in the PWA's `claudeStore` consists of `ClaudeHistoryMessage` (history) plus real-time events received during streaming. The UI rendering layer also tacks on one extra field:

```typescript
// ClaudeHistoryMessage + real-time streaming extension
interface UIMessage extends ClaudeHistoryMessage {
  // Present only during streaming; never set on history reads
  pendingInputRequest?: {
    sessionId: string;
    requestId: string;
    inputType: 'permission' | 'question';
    title: string;
    message?: string;
    options?: { key: string; label: string; description?: string }[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
  };
}
```

---

## 七、Data flow overview

```
JSONL file (~/.quicksave/state/sessions/<id>/)
      ↓ getSessionMessages() [SDK]
SessionMessage[]  (type: user | assistant | system, message: BetaMessage | MessageParam | ...)
      ↓ filter(!isSidechain)
      ↓ build toolNameMap & agentToolUses
      ↓ flatMap → expand blocks
ClaudeHistoryMessage[]  (role: user | assistant | system, flat blocks)
      ↓ paginate (offset/limit from tail)
ClaudeGetMessagesResponsePayload  { messages, total, hasMore, toolNameMap, subagentBlocks }
      ↓ WebSocket claude:get-messages:response
PWA claudeStore.messages[]
```

---

## 八、References

| Source | Path |
|---|---|
| Application-layer type definitions | `packages/shared/src/types.ts` lines 682–711 |
| Message parsing logic | `apps/agent/src/ai/claudeCodeService.ts` lines 270–392 |
| SDK type definitions | `@anthropic-ai/claude-agent-sdk` → `sdk.d.ts` |
| BetaMessage / ContentBlock types | `@anthropic-ai/sdk` → `resources/beta/messages/messages.d.ts` |
| Agent SDK official docs — Sessions | https://code.claude.com/docs/en/agent-sdk/sessions |
| Agent SDK official docs — TypeScript API | https://code.claude.com/docs/en/agent-sdk/typescript |
| Anthropic Messages API official docs | https://platform.claude.com/docs/en/api/messages |
