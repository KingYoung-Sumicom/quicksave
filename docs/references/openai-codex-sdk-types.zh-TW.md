# OpenAI Codex Agent SDK — 型別參考

此文件涵蓋 `@openai/codex-sdk` TypeScript SDK 的所有資料結構與型別，以及底層 App-Server Protocol（JSON-RPC）的訊息格式。

- 套件：`@openai/codex-sdk`（搭配 `@openai/codex` CLI）
- 原始碼：https://github.com/openai/codex/tree/main/sdk/typescript/src
- 官方文件：https://developers.openai.com/codex

---

## 一、SDK 主要 API

### `Codex` — 入口類別

```typescript
// sdk/typescript/src/codex.ts
export class Codex {
  constructor(options: CodexOptions = {});
  startThread(options: ThreadOptions = {}): Thread;
  resumeThread(id: string, options: ThreadOptions = {}): Thread;
}
```

### `Thread` — 對話執行緒

```typescript
export class Thread {
  // 執行一個 turn，緩衝所有結果後回傳
  run(prompt: Input, options?: TurnOptions): Promise<RunResult>;

  // 執行一個 turn，回傳可 async iterate 的事件流
  runStreamed(prompt: Input, options?: TurnOptions): RunStreamedResult;
}
```

---

## 二、初始化選項

### `CodexOptions` — SDK 全域設定

```typescript
// sdk/typescript/src/codexOptions.ts
export type CodexOptions = {
  codexPathOverride?: string;   // 指定 codex CLI 執行檔路徑
  baseUrl?: string;             // API base URL（用於 proxy 或 custom endpoint）
  apiKey?: string;              // OpenAI API key（預設讀取 OPENAI_API_KEY）
  config?: CodexConfigObject;   // 額外 CLI 設定（dotted-path TOML key-value）
  env?: Record<string, string>; // 傳給 CLI 的環境變數
};

export type CodexConfigObject = { [key: string]: CodexConfigValue };
export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
```

### `ThreadOptions` — 執行緒層級設定

```typescript
// sdk/typescript/src/threadOptions.ts
export type ThreadOptions = {
  model?: string;                              // 使用的模型（如 'codex-mini-latest'）
  sandboxMode?: SandboxMode;                   // 沙箱模式
  workingDirectory?: string;                   // 執行工作目錄（預設需為 git repo）
  skipGitRepoCheck?: boolean;                  // 跳過 git repo 檢查
  modelReasoningEffort?: ModelReasoningEffort; // 推理強度
  networkAccessEnabled?: boolean;              // 是否允許網路存取
  webSearchMode?: WebSearchMode;               // Web 搜尋模式
  webSearchEnabled?: boolean;                  // 是否啟用 Web 搜尋（deprecated，用 webSearchMode）
  approvalPolicy?: ApprovalMode;               // 工具執行審批政策
  additionalDirectories?: string[];            // 額外可存取的目錄
};

export type SandboxMode =
  | 'read-only'           // 只能讀取檔案
  | 'workspace-write'     // 可讀寫工作目錄（預設）
  | 'danger-full-access'; // 完整檔案系統存取，無沙箱限制

export type ApprovalMode =
  | 'never'        // 所有工具呼叫自動核准
  | 'on-request'   // 僅在工具主動要求時詢問
  | 'on-failure'   // 失敗時才詢問
  | 'untrusted';   // 每次都詢問（最嚴格）

export type ModelReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type WebSearchMode = 'disabled' | 'cached' | 'live';
```

### `TurnOptions` — 單次 turn 設定

```typescript
// sdk/typescript/src/turnOptions.ts
export type TurnOptions = {
  outputSchema?: unknown;  // JSON Schema，約束 agent 輸出格式（Structured Output）
  signal?: AbortSignal;    // 取消此 turn 的 AbortSignal
};
```

---

## 三、輸入格式

```typescript
// sdk/typescript/src/thread.ts
export type Input = string | UserInput[];

export type UserInput =
  | { type: 'text'; text: string }                // 純文字 prompt
  | { type: 'local_image'; path: string };        // 本機圖片（絕對或相對路徑）
```

---

## 四、`run()` 回傳結果

### `RunResult` / `Turn`

```typescript
// sdk/typescript/src/thread.ts
export type Turn = {
  items: ThreadItem[];    // 此 turn 的所有項目（工具呼叫、訊息等）
  finalResponse: string; // agent 最終文字回覆
  usage: Usage | null;   // token 用量
};

export type RunResult = Turn;
```

---

## 五、`runStreamed()` 事件流

### `RunStreamedResult`

```typescript
// sdk/typescript/src/thread.ts
export type RunStreamedResult = {
  events: AsyncGenerator<ThreadEvent>;
};
```

### `ThreadEvent` — 所有可能的事件

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

### 各事件型別

```typescript
// thread 建立完成，id 可用來 resumeThread()
export type ThreadStartedEvent = {
  type: 'thread.started';
  thread_id: string;
};

// prompt 送出，模型開始處理
export type TurnStartedEvent = {
  type: 'turn.started';
};

// turn 正常結束
export type TurnCompletedEvent = {
  type: 'turn.completed';
  usage: Usage;
};

// turn 失敗
export type TurnFailedEvent = {
  type: 'turn.failed';
  error: ThreadError;
};

// 新的 item 開始（工具呼叫、agent 訊息等）
export type ItemStartedEvent = {
  type: 'item.started';
  item: ThreadItem;
};

// item 狀態或內容更新（如工具執行中的輸出）
export type ItemUpdatedEvent = {
  type: 'item.updated';
  item: ThreadItem;
};

// item 到達終態（completed 或 failed）
export type ItemCompletedEvent = {
  type: 'item.completed';
  item: ThreadItem;
};

// 不可恢復的錯誤（直接來自事件流）
export type ThreadErrorEvent = {
  type: 'error';
  message: string;
};

// token 用量
export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
};

export type ThreadError = { message: string };
```

---

## 六、`ThreadItem` — 所有 item 型別

`ItemStartedEvent`、`ItemUpdatedEvent`、`ItemCompletedEvent` 的 `item` 欄位都是 `ThreadItem`。

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

### `agent_message` — Agent 文字回覆

```typescript
export type AgentMessageItem = {
  id: string;
  type: 'agent_message';
  text: string;   // agent 回覆的文字內容（streaming 時逐步增長）
};
```

### `reasoning` — 推理過程

```typescript
export type ReasoningItem = {
  id: string;
  type: 'reasoning';
  text: string;   // 模型的推理摘要文字
};
```

### `command_execution` — Shell 命令執行

```typescript
export type CommandExecutionItem = {
  id: string;
  type: 'command_execution';
  command: string;           // 執行的指令字串
  aggregated_output: string; // 累積的 stdout/stderr 輸出
  exit_code?: number;        // 結束碼（執行完成後才有）
  status: CommandExecutionStatus;
};

export type CommandExecutionStatus = 'in_progress' | 'completed' | 'failed';
```

### `file_change` — 檔案變更

```typescript
export type FileChangeItem = {
  id: string;
  type: 'file_change';
  changes: FileUpdateChange[];
  status: PatchApplyStatus;
};

export type FileUpdateChange = {
  path: string;             // 被修改的檔案路徑
  kind: PatchChangeKind;    // 變更類型
};

export type PatchChangeKind = 'add' | 'delete' | 'update';
export type PatchApplyStatus = 'completed' | 'failed';
```

### `mcp_tool_call` — MCP 工具呼叫

```typescript
export type McpToolCallItem = {
  id: string;
  type: 'mcp_tool_call';
  server: string;    // MCP server 名稱
  tool: string;      // 工具名稱
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

### `web_search` — Web 搜尋

```typescript
export type WebSearchItem = {
  id: string;
  type: 'web_search';
  query: string;
};
```

### `todo_list` — 待辦清單

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

### `error` — 錯誤

```typescript
export type ErrorItem = {
  id: string;
  type: 'error';
  message: string;
};
```

---

## 七、典型使用範例

### 單次執行（buffered）

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
// result.items → 所有工具呼叫、檔案變更的完整記錄
```

### 串流執行

```typescript
const streamed = thread.runStreamed('Refactor utils.ts');

for await (const event of streamed.events) {
  switch (event.type) {
    case 'thread.started':
      console.log('Thread ID:', event.thread_id); // 可用來 resumeThread
      break;
    case 'item.updated':
      if (event.item.type === 'agent_message') {
        process.stdout.write(event.item.text); // streaming 文字輸出
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

## 八、App-Server Protocol（底層 JSON-RPC）

> 以下為 Rust 核心（`codex-rs`）自動生成的 TypeScript 型別，代表 CLI 與 UI 之間的底層協議。一般使用 SDK 不需要直接操作，但對了解底層事件結構有幫助。
> 原始碼：`codex-rs/app-server-protocol/schema/typescript/`

### 伺服器推送通知（`ServerNotification`）

執行過程中伺服器主動推送的所有事件：

| method | 說明 |
|---|---|
| `thread/started` | thread 建立完成 |
| `thread/status/changed` | thread 狀態變更（idle / active / error） |
| `turn/started` | turn 開始 |
| `turn/completed` | turn 完成（含 usage） |
| `turn/diff/updated` | 本次 turn 的 git diff 更新 |
| `turn/plan/updated` | agent 執行計畫更新（含步驟與狀態） |
| `item/started` | item 開始（tool call、message 等） |
| `item/completed` | item 完成 |
| `item/agentMessage/delta` | agent 文字訊息增量（streaming） |
| `item/commandExecution/outputDelta` | Shell 輸出增量（streaming） |
| `item/fileChange/outputDelta` | 檔案變更 diff 增量 |
| `item/reasoning/summaryTextDelta` | 推理摘要增量 |
| `item/reasoning/textDelta` | 推理內容增量 |
| `item/plan/delta` | 計劃文字增量 |
| `thread/tokenUsage/updated` | token 用量更新 |
| `thread/compacted` | context compaction 完成 |
| `hook/started` / `hook/completed` | hook 執行事件 |

### 伺服器發起請求（`ServerRequest`）— 需要客戶端回應

| method | 說明 |
|---|---|
| `item/commandExecution/requestApproval` | 要求使用者核准執行 shell 指令 |
| `item/fileChange/requestApproval` | 要求使用者核准檔案變更 |
| `item/tool/requestUserInput` | 要求使用者輸入（問答） |
| `item/permissions/requestApproval` | 要求授予特定權限 |
| `mcpServer/elicitation/request` | MCP server 要求使用者輸入 |

### `ThreadItem`（底層，比 SDK 更豐富）

底層協議的 `ThreadItem` 比 SDK 的版本多幾個 type：

| `type` | 說明 |
|---|---|
| `userMessage` | 使用者輸入訊息 |
| `agentMessage` | agent 文字回覆（含 `phase: 'commentary' \| 'final_answer'`） |
| `reasoning` | 推理過程（含 `summary[]` 和 `content[]`） |
| `plan` | 執行計畫 |
| `commandExecution` | Shell 命令（含 `cwd`、`source`、`commandActions`） |
| `fileChange` | 檔案變更（含 `diff` 欄位） |
| `mcpToolCall` | MCP 工具呼叫 |
| `dynamicToolCall` | 伺服器發起給客戶端執行的工具呼叫 |
| `webSearch` | Web 搜尋（含 `action` 詳情） |
| `imageView` | 圖片查看 |
| `contextCompaction` | Context 壓縮邊界 |
| `enteredReviewMode` / `exitedReviewMode` | Review 模式進出 |
| `collabAgentToolCall` | 多 agent 協作工具呼叫 |

### `TurnPlanStep` — 執行計畫步驟

```typescript
export type TurnPlanStep = {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
};
```

### `TokenUsageBreakdown` — 詳細 token 用量

```typescript
export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
```

### 錯誤類型

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

## 九、參考來源

| 來源 | 路徑 |
|---|---|
| SDK events 型別 | https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts |
| SDK items 型別 | https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts |
| SDK thread 型別 | https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts |
| SDK threadOptions 型別 | https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts |
| SDK turnOptions 型別 | https://github.com/openai/codex/blob/main/sdk/typescript/src/turnOptions.ts |
| SDK codexOptions 型別 | https://github.com/openai/codex/blob/main/sdk/typescript/src/codexOptions.ts |
| SDK README | https://github.com/openai/codex/blob/main/sdk/typescript/README.md |
| App-Server Protocol（底層） | https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript |
| 官方文件 | https://developers.openai.com/codex |
