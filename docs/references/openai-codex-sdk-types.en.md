# OpenAI Codex Agent SDK — Type Reference

This document covers all data structures and types in the `@openai/codex-sdk` TypeScript SDK, as well as the message format of the underlying App-Server Protocol (JSON-RPC).

- Package: `@openai/codex-sdk` (paired with the `@openai/codex` CLI)
- Source: https://github.com/openai/codex/tree/main/sdk/typescript/src
- Official docs: https://developers.openai.com/codex

---

## 一、SDK Main API

### `Codex` — Entry class

```typescript
// sdk/typescript/src/codex.ts
export class Codex {
  constructor(options: CodexOptions = {});
  startThread(options: ThreadOptions = {}): Thread;
  resumeThread(id: string, options: ThreadOptions = {}): Thread;
}
```

### `Thread` — Conversation thread

```typescript
export class Thread {
  // Run a single turn, buffer all results, and return them
  run(prompt: Input, options?: TurnOptions): Promise<RunResult>;

  // Run a single turn and return an async-iterable event stream
  runStreamed(prompt: Input, options?: TurnOptions): RunStreamedResult;
}
```

---

## 二、Initialization Options

### `CodexOptions` — SDK-wide settings

```typescript
// sdk/typescript/src/codexOptions.ts
export type CodexOptions = {
  codexPathOverride?: string;   // Path to the codex CLI executable
  baseUrl?: string;             // API base URL (for proxies or custom endpoints)
  apiKey?: string;              // OpenAI API key (defaults to OPENAI_API_KEY)
  config?: CodexConfigObject;   // Extra CLI settings (dotted-path TOML key-value)
  env?: Record<string, string>; // Environment variables passed to the CLI
};

export type CodexConfigObject = { [key: string]: CodexConfigValue };
export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
```

### `ThreadOptions` — Thread-level settings

```typescript
// sdk/typescript/src/threadOptions.ts
export type ThreadOptions = {
  model?: string;                              // Model to use (e.g. 'codex-mini-latest')
  sandboxMode?: SandboxMode;                   // Sandbox mode
  workingDirectory?: string;                   // Working directory (must be a git repo by default)
  skipGitRepoCheck?: boolean;                  // Skip the git repo check
  modelReasoningEffort?: ModelReasoningEffort; // Reasoning effort
  networkAccessEnabled?: boolean;              // Whether network access is allowed
  webSearchMode?: WebSearchMode;               // Web search mode
  webSearchEnabled?: boolean;                  // Whether web search is enabled (deprecated; use webSearchMode)
  approvalPolicy?: ApprovalMode;               // Approval policy for tool execution
  additionalDirectories?: string[];            // Additional directories that are accessible
};

export type SandboxMode =
  | 'read-only'           // Read-only file access
  | 'workspace-write'     // Read/write within the working directory (default)
  | 'danger-full-access'; // Full filesystem access, no sandbox restrictions

export type ApprovalMode =
  | 'never'        // Auto-approve all tool calls
  | 'on-request'   // Ask only when the tool itself requests it
  | 'on-failure'   // Ask only on failure
  | 'untrusted';   // Ask every time (strictest)

export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type WebSearchMode = 'disabled' | 'cached' | 'live';
```

### `TurnOptions` — Per-turn settings

```typescript
// sdk/typescript/src/turnOptions.ts
export type TurnOptions = {
  outputSchema?: unknown;  // JSON Schema constraining the agent's output format (Structured Output)
  signal?: AbortSignal;    // AbortSignal to cancel this turn
};
```

---

## 三、Input Format

```typescript
// sdk/typescript/src/thread.ts
export type Input = string | UserInput[];

export type UserInput =
  | { type: 'text'; text: string }                // Plain-text prompt
  | { type: 'local_image'; path: string };        // Local image (absolute or relative path)
```

---

## 四、`run()` Return Value

### `RunResult` / `Turn`

```typescript
// sdk/typescript/src/thread.ts
export type Turn = {
  items: ThreadItem[];    // All items produced this turn (tool calls, messages, etc.)
  finalResponse: string; // The agent's final text reply
  usage: Usage | null;   // Token usage
};

export type RunResult = Turn;
```

---

## 五、`runStreamed()` Event Stream

### `RunStreamedResult`

```typescript
// sdk/typescript/src/thread.ts
export type RunStreamedResult = {
  events: AsyncGenerator<ThreadEvent>;
};
```

### `ThreadEvent` — All possible events

```typescript
// sdk/typescript/src/events.ts
export type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadErrorEvent;
```

### Individual event types

```typescript
// Thread created; the id can be passed to resumeThread()
export type ThreadStartedEvent = {
  type: 'thread.started';
  thread_id: string;
};

// Prompt submitted; the model has begun processing
export type TurnStartedEvent = {
  type: 'turn.started';
};

// Turn finished normally
export type TurnCompletedEvent = {
  type: 'turn.completed';
  usage: Usage;
};

// Turn failed
export type TurnFailedEvent = {
  type: 'turn.failed';
  error: ThreadError;
};

// A new item has started (tool call, agent message, etc.)
export type ItemStartedEvent = {
  type: 'item.started';
  item: ThreadItem;
};

// Item state or content has been updated (e.g. mid-execution tool output)
export type ItemUpdatedEvent = {
  type: 'item.updated';
  item: ThreadItem;
};

// Item has reached a terminal state (completed or failed)
export type ItemCompletedEvent = {
  type: 'item.completed';
  item: ThreadItem;
};

// Unrecoverable error (delivered straight from the event stream)
export type ThreadErrorEvent = {
  type: 'error';
  message: string;
};

// Token usage
export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
};

export type ThreadError = { message: string };
```

---

## 六、`ThreadItem` — All Item Types

The `item` field of `ItemStartedEvent`, `ItemUpdatedEvent`, and `ItemCompletedEvent` is always a `ThreadItem`.

```typescript
// sdk/typescript/src/items.ts
export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem;
```

### `agent_message` — Agent text reply

```typescript
export type AgentMessageItem = {
  id: string;
  type: 'agent_message';
  text: string;   // Text content of the agent's reply (grows incrementally while streaming)
};
```

### `reasoning` — Reasoning trace

```typescript
export type ReasoningItem = {
  id: string;
  type: 'reasoning';
  text: string;   // Summary text of the model's reasoning
};
```

### `command_execution` — Shell command execution

```typescript
export type CommandExecutionItem = {
  id: string;
  type: 'command_execution';
  command: string;           // The command string that was executed
  aggregated_output: string; // Accumulated stdout/stderr output
  exit_code?: number;        // Exit code (only set after execution finishes)
  status: CommandExecutionStatus;
};

export type CommandExecutionStatus = 'in_progress' | 'completed' | 'failed';
```

### `file_change` — File changes

```typescript
export type FileChangeItem = {
  id: string;
  type: 'file_change';
  changes: FileUpdateChange[];
  status: PatchApplyStatus;
};

export type FileUpdateChange = {
  path: string;             // Path of the modified file
  kind: PatchChangeKind;    // Kind of change
};

export type PatchChangeKind = 'add' | 'delete' | 'update';
export type PatchApplyStatus = 'completed' | 'failed';
```

### `mcp_tool_call` — MCP tool call

```typescript
export type McpToolCallItem = {
  id: string;
  type: 'mcp_tool_call';
  server: string;    // MCP server name
  tool: string;      // Tool name
  arguments: unknown;
  result?: {
    content: McpContentBlock[];
    structured_content: unknown;
  };
  error?: { message: string };
  status: McpToolCallStatus;
};

export type McpToolCallStatus = 'in_progress' | 'completed' | 'failed';
```

### `web_search` — Web search

```typescript
export type WebSearchItem = {
  id: string;
  type: 'web_search';
  query: string;
};
```

### `todo_list` — Todo list

```typescript
export type TodoListItem = {
  id: string;
  type: 'todo_list';
  items: TodoItem[];
};

export type TodoItem = {
  text: string;
  completed: boolean;
};
```

### `error` — Error

```typescript
export type ErrorItem = {
  id: string;
  type: 'error';
  message: string;
};
```

---

## 七、Typical Usage Examples

### Single execution (buffered)

```typescript
import { Codex } from '@openai/codex-sdk';

const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
const thread = codex.startThread({
  workingDirectory: '/path/to/project',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
});

const result = await thread.run('Fix the bug in auth.ts');
console.log(result.finalResponse);
// result.items → complete record of every tool call and file change
```

### Streamed execution

```typescript
const streamed = thread.runStreamed('Refactor utils.ts');

for await (const event of streamed.events) {
  switch (event.type) {
    case 'thread.started':
      console.log('Thread ID:', event.thread_id); // Can be passed to resumeThread
      break;
    case 'item.updated':
      if (event.item.type === 'agent_message') {
        process.stdout.write(event.item.text); // Streaming text output
      }
      break;
    case 'item.completed':
      if (event.item.type === 'command_execution') {
        console.log('Exit code:', event.item.exit_code);
      }
      break;
    case 'turn.completed':
      console.log('Tokens used:', event.usage.output_tokens);
      break;
    case 'turn.failed':
      console.error('Failed:', event.error.message);
      break;
  }
}
```

### Resume Thread

```typescript
const thread = codex.resumeThread(savedThreadId, {
  workingDirectory: '/path/to/project',
});
const result = await thread.run('Continue where you left off');
```

### Structured Output

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const schema = z.object({
  bugs: z.array(z.object({
    file: z.string(),
    line: z.number(),
    description: z.string(),
  })),
});

const result = await thread.run('Find all bugs', {
  outputSchema: zodToJsonSchema(schema, { target: 'openAi' }),
});
```

---

## 八、App-Server Protocol (the underlying JSON-RPC)

> The TypeScript types below are auto-generated from the Rust core (`codex-rs`) and represent the low-level protocol between the CLI and the UI. You do not normally need to interact with it when using the SDK, but it is helpful for understanding the underlying event structure.
> Source: `codex-rs/app-server-protocol/schema/typescript/`

### Server-pushed notifications (`ServerNotification`)

All events the server pushes during execution:

| method | Description |
|---|---|
| `thread/started` | Thread has been created |
| `thread/status/changed` | Thread status changed (idle / active / error) |
| `turn/started` | Turn has begun |
| `turn/completed` | Turn finished (includes usage) |
| `turn/diff/updated` | Git diff for this turn updated |
| `turn/plan/updated` | Agent execution plan updated (steps and statuses) |
| `item/started` | Item started (tool call, message, etc.) |
| `item/completed` | Item completed |
| `item/agentMessage/delta` | Incremental update to an agent text message (streaming) |
| `item/commandExecution/outputDelta` | Incremental shell output (streaming) |
| `item/fileChange/outputDelta` | Incremental file-change diff |
| `item/reasoning/summaryTextDelta` | Incremental reasoning summary |
| `item/reasoning/textDelta` | Incremental reasoning content |
| `item/plan/delta` | Incremental plan text |
| `thread/tokenUsage/updated` | Token usage updated |
| `thread/compacted` | Context compaction completed |
| `hook/started` / `hook/completed` | Hook execution events |

### Server-initiated requests (`ServerRequest`) — require a client response

| method | Description |
|---|---|
| `item/commandExecution/requestApproval` | Ask the user to approve executing a shell command |
| `item/fileChange/requestApproval` | Ask the user to approve a file change |
| `item/tool/requestUserInput` | Ask the user for input (Q&A) |
| `item/permissions/requestApproval` | Ask the user to grant a specific permission |
| `mcpServer/elicitation/request` | An MCP server is asking for user input |

### `ThreadItem` (low-level, richer than the SDK version)

The protocol-level `ThreadItem` carries several additional types beyond the SDK version:

| `type` | Description |
|---|---|
| `userMessage` | User input message |
| `agentMessage` | Agent text reply (includes `phase: 'commentary' \| 'final_answer'`) |
| `reasoning` | Reasoning trace (includes `summary[]` and `content[]`) |
| `plan` | Execution plan |
| `commandExecution` | Shell command (includes `cwd`, `source`, `commandActions`) |
| `fileChange` | File change (includes a `diff` field) |
| `mcpToolCall` | MCP tool call |
| `dynamicToolCall` | Server-initiated tool call to be executed by the client |
| `webSearch` | Web search (includes `action` details) |
| `imageView` | Image viewing |
| `contextCompaction` | Context compaction boundary |
| `enteredReviewMode` / `exitedReviewMode` | Entering/exiting review mode |
| `collabAgentToolCall` | Multi-agent collaboration tool call |

### `TurnPlanStep` — Execution plan step

```typescript
export type TurnPlanStep = {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
};
```

### `TokenUsageBreakdown` — Detailed token usage

```typescript
export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
```

### Error types

```typescript
export type CodexErrorInfo =
  | 'contextWindowExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'sandboxError'
  | 'other'
  | { httpConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamDisconnected: { httpStatusCode: number | null } }
  | { responseTooManyFailedAttempts: { httpStatusCode: number | null } }
  | { activeTurnNotSteerable: { turnKind: 'review' | 'compact' } };
```

---

## 九、References

| Source | Path |
|---|---|
| SDK events types | https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts |
| SDK items types | https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts |
| SDK thread types | https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts |
| SDK threadOptions types | https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts |
| SDK turnOptions types | https://github.com/openai/codex/blob/main/sdk/typescript/src/turnOptions.ts |
| SDK codexOptions types | https://github.com/openai/codex/blob/main/sdk/typescript/src/codexOptions.ts |
| SDK README | https://github.com/openai/codex/blob/main/sdk/typescript/README.md |
| App-Server Protocol (low-level) | https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript |
| Official docs | https://developers.openai.com/codex |
