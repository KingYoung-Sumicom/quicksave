# Claude Agent SDK — Session Message Type Reference

This document only covers the raw data structures returned by `getSessionMessages()` from `@anthropic-ai/claude-agent-sdk`; it does not include any application-layer transformation logic.

- SDK version: `@anthropic-ai/claude-agent-sdk@0.2.91`
- Official documentation: https://code.claude.com/docs/en/agent-sdk/sessions
- Official TypeScript API reference: https://code.claude.com/docs/en/agent-sdk/typescript

---

## `getSessionMessages()`

```typescript
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>;

type GetSessionMessagesOptions = {
  dir?: string;                    // Project directory; if omitted, all projects are searched
  limit?: number;                  // Maximum number of records to return (counted from offset)
  offset?: number;                 // Index to start from (counted from the beginning, 0-based)
  includeSystemMessages?: boolean; // Whether to include 'system' type; defaults to false
};
```

---

## `SessionMessage` — Top-Level Structure

```typescript
type SessionMessage = {
  type: 'user' | 'assistant' | 'system'; // 'system' requires includeSystemMessages: true
  uuid: string;               // Unique message identifier (UUID)
  session_id: string;         // UUID of the owning session
  message: unknown;           // Actual content; varies by type (see sections below)
  parent_tool_use_id: null;   // Reserved field; always null for now
};
```

**Fields that exist at runtime but are not part of the type definition:**

| Field | Type | Description |
|---|---|---|
| `isSidechain` | `boolean` | Subagent sidechain message; usually needs to be filtered out |
| `agentId` | `string` | Agent ID for subagent messages |

> `SessionMessage` is the trimmed-down format used for reading history. The live-streaming `query()` returns the full `SDKMessage` union (20+ types); the two are not the same.

---

## `type: 'assistant'` — `message` is a `BetaMessage`

A `BetaMessage` from `@anthropic-ai/sdk`.

### `BetaMessage`

```typescript
// @anthropic-ai/sdk → resources/beta/messages/messages.d.ts
interface BetaMessage {
  id: string;                   // msg_xxxxx
  type: 'message';              // Fixed value
  role: 'assistant';            // Fixed value
  content: BetaContentBlock[];  // Array of content blocks (see below)
  model: string;                // 'claude-sonnet-4-6', etc.
  stop_reason: StopReason;
  stop_sequence: string | null; // Set when stop_reason is 'stop_sequence'
  usage: BetaUsage;
  container: BetaContainer | null;
}

type StopReason =
  | 'end_turn'        // Model ended the turn naturally
  | 'max_tokens'      // Hit the max_tokens cap
  | 'stop_sequence'   // Matched a custom stop sequence
  | 'tool_use'        // content contains a tool_use block awaiting execution
  | 'pause_turn'      // Paused (streaming)
  | 'incomplete';     // Interrupted by token limits

interface BetaUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

interface BetaContainer {
  id: string;
  expires_at: string;
}
```

### `BetaContentBlock` — All Possible Block Types

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
  | BetaBashCodeExecutionToolResultBlock
  | BetaTextEditorCodeExecutionToolResultBlock
  | BetaToolSearchToolResultBlock
  | BetaContainerUploadBlock;
```

#### `text` — Text Response

```typescript
interface BetaTextBlock {
  type: 'text';
  text: string;
  citations: BetaTextCitation[] | null;
}
```

#### `thinking` — Extended Thinking

```typescript
interface BetaThinkingBlock {
  type: 'thinking';
  thinking: string;   // Claude's internal reasoning
  signature: string;  // Integrity-verification signature for multi-turn conversations
}
```

#### `redacted_thinking` — Redacted Thinking

```typescript
interface BetaRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;       // Encrypted thinking content
}
```

#### `tool_use` — Tool Invocation

```typescript
interface BetaToolUseBlock {
  type: 'tool_use';
  id: string;       // toolu_xxxxx; uniquely identifies this invocation
  name: string;     // Tool name, e.g., 'Bash', 'Read', 'Edit', 'Agent'
  input: unknown;   // Invocation arguments (JSON object; format varies by tool)
  caller?: BetaDirectCaller | BetaServerToolCaller;
}

interface BetaDirectCaller {
  type: 'direct';   // Invoked directly by the model
}

interface BetaServerToolCaller {
  type: 'code_execution_20250825' | 'code_execution_20260120';
  tool_id: string;
}
```

### Example: Plain Text Response

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
      { "type": "text", "text": "我來幫你分析這個問題..." }
    ],
    "model": "claude-sonnet-4-6",
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": { "input_tokens": 1024, "output_tokens": 128 },
    "container": null
  }
}
```

### Example: Tool Invocation (stop_reason: "tool_use")

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "讓我先看一下目錄結構。" },
      {
        "type": "tool_use",
        "id": "toolu_01A09q90qw90lq917835lq9",
        "name": "Bash",
        "input": { "command": "ls -la", "description": "列出目錄" }
      }
    ],
    "stop_reason": "tool_use"
  }
}
```

### Example: With a thinking Block

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "使用者想要...",
        "signature": "ErUkMy..."
      },
      { "type": "text", "text": "好的，我分析如下..." }
    ],
    "stop_reason": "end_turn"
  }
}
```

---

## `type: 'user'` — `message` is a `MessageParam`

A `MessageParam` from `@anthropic-ai/sdk`.

### `MessageParam`

```typescript
// @anthropic-ai/sdk → resources/messages.d.ts
type MessageParam = {
  role: 'user';
  content: string | Array<ContentBlockParam>;
};
```

When `content` is an array, each block has one of the following types:

#### `text` — User-Entered Text

```typescript
interface TextBlockParam {
  type: 'text';
  text: string;
  cache_control?: CacheControlEphemeral | null;
}
```

#### `tool_result` — Tool Execution Result

A response to a `tool_use` block in the preceding assistant message.

```typescript
interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;             // The id of the corresponding tool_use block (toolu_xxxxx)
  content?: string | Array<
    TextBlockParam | ImageBlockParam | ...
  >;
  is_error?: boolean;              // true indicates the tool execution failed
  cache_control?: CacheControlEphemeral | null;
}
```

#### `image` — Image (Less Common)

```typescript
interface ImageBlockParam {
  type: 'image';
  source: Base64ImageSource | URLImageSource;
  cache_control?: CacheControlEphemeral | null;
}
```

**Extra `SDKUserMessage` fields (present in the JSONL when reading history, but not part of `MessageParam`):**

| Field | Type | Description |
|---|---|---|
| `isSynthetic` | `boolean?` | Synthesized by the SDK internally; not actual user input |
| `tool_use_result` | `unknown?` | Tool result (some versions) |
| `timestamp` | `string?` | ISO timestamp; may be missing in older versions |
| `isReplay` | `true?` | Appears only on `SDKUserMessageReplay` |

### Example: Plain Text Input

```json
{
  "type": "user",
  "uuid": "661f8400-e29b-41d4-a716-556677889900",
  "session_id": "ce304b01-c8cb-4f23-be8c-6c1ab848ad35",
  "parent_tool_use_id": null,
  "message": {
    "role": "user",
    "content": "幫我新增一個 feature"
  }
}
```

### Example: Tool Result (content as Array)

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
          { "type": "text", "text": "total 0\ndrwxr-xr-x  5 user group 160 Apr 9 12:00 ." }
        ],
        "is_error": false
      }
    ]
  }
}
```

### Example: Tool Execution Failure

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
        "content": [{ "type": "text", "text": "Error: command not found: foobar" }],
        "is_error": true
      }
    ]
  }
}
```

---

## `type: 'system'` — System Events (`includeSystemMessages: true`)

For system messages, the entire JSONL object itself is the system-message structure (the `message` field is typically null or absent). They are distinguished by `subtype`:

### `subtype: 'init'` — Session Initialization

Usually the first record in a session.

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: string;
  session_id: string;
  cwd: string;                      // Absolute path of the working directory
  model: string;                    // Model in use
  tools: string[];                  // List of available tool names
  permissionMode:
    | 'default'             // Standard behavior; dangerous operations prompt for confirmation
    | 'acceptEdits'         // Auto-accept file edits
    | 'bypassPermissions'   // Skip all permission checks
    | 'plan'                // Plan mode; tools are not executed
    | 'auto';               // Determined by the model classifier
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents?: string[];
  betas?: string[];
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
  apiKeySource: string;
  fast_mode_state?: FastModeState;
};
```

### `subtype: 'compact_boundary'` — Context Compaction Boundary

Emitted when an over-long session is compacted, marking the dividing line between pre- and post-compaction.

```typescript
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  uuid: string;
  session_id: string;
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;             // Token count before compaction
    preserved_segment?: {           // The message segment kept uncompacted (if any)
      head_uuid: string;
      anchor_uuid: string;
      tail_uuid: string;
    };
  };
};
```

### `subtype: 'status'` — Status Change

```typescript
type SDKStatusMessage = {
  type: 'system';
  subtype: 'status';
  uuid: string;
  session_id: string;
  status: 'compacting' | null;
  permissionMode?: string;
};
```

### `subtype: 'task_started'` — Subagent Started

```typescript
type SDKTaskStartedMessage = {
  type: 'system';
  subtype: 'task_started';
  uuid: string;
  session_id: string;
  task_id: string;
  tool_use_id?: string;     // The Agent tool_use id from the parent session
  description: string;      // Task description
  task_type?: string;
  workflow_name?: string;   // Set when task_type is 'local_workflow'
  prompt?: string;
};
```

### `subtype: 'task_progress'` — Subagent Progress Update

```typescript
type SDKTaskProgressMessage = {
  type: 'system';
  subtype: 'task_progress';
  uuid: string;
  session_id: string;
  task_id: string;
  tool_use_id?: string;
  description: string;
  summary?: string;
  last_tool_name?: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
};
```

### `subtype: 'task_notification'` — Subagent Completed

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  uuid: string;
  session_id: string;
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;     // Path to the subagent's JSONL file
  summary: string;         // Summary of the task execution
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
};
```

---

## Message Ordering and tool_use / tool_result Pairing

A complete tool invocation corresponds to two `SessionMessage` entries in the session:

```
1. type: 'assistant'
   message.content = [{ type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: {...} }]
   stop_reason: 'tool_use'

2. type: 'user'
   message.content = [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: [...] }]
```

The pairing is based on `tool_use.id` matching `tool_result.tool_use_id`.

A single assistant message can contain multiple `tool_use` blocks at once (parallel tool calls); the corresponding user message will then carry multiple `tool_result` blocks.

---

## `getSubagentMessages()`

Reads a subagent's standalone conversation log (stored in a separate JSONL file):

```typescript
function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options?: GetSubagentMessagesOptions
): Promise<SessionMessage[]>;

// Returns the same shape as getSessionMessages() — SessionMessage[]
// agentId corresponds to SDKTaskStartedMessage.task_id or the id of the Agent tool_use
```

---

## `SDKSessionInfo` Returned by `listSessions()`

```typescript
type SDKSessionInfo = {
  sessionId: string;
  summary: string;           // Auto-generated summary or the first prompt
  lastModified: number;      // Unix timestamp (milliseconds)
  fileSize?: number;         // JSONL file size (bytes)
  customTitle?: string;      // Title set by the user via /rename
  firstPrompt?: string;      // First meaningful user prompt
  gitBranch?: string;        // Git branch at the time the session ended
  cwd?: string;              // Working directory of the session
  tag?: string;              // Tag set by the user
  createdAt?: number;        // Creation time (Unix timestamp, milliseconds)
};
```

---

## References

| Source | Path |
|---|---|
| SDK type definitions | `@anthropic-ai/claude-agent-sdk` → `sdk.d.ts` (local node_modules) |
| BetaMessage / ContentBlock | `@anthropic-ai/sdk@0.71.2` → `resources/beta/messages/messages.d.ts` |
| Agent SDK official docs — Sessions | https://code.claude.com/docs/en/agent-sdk/sessions |
| Agent SDK official docs — TypeScript API | https://code.claude.com/docs/en/agent-sdk/typescript |
| Anthropic Messages API | https://platform.claude.com/docs/en/api/messages |
