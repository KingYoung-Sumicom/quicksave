# Claude Agent SDK — Session 訊息型別參考

此文件只涵蓋 `@anthropic-ai/claude-agent-sdk` 的 `getSessionMessages()` 所回傳的原始資料結構，不包含應用層的轉換邏輯。

- SDK 版本：`@anthropic-ai/claude-agent-sdk@0.2.91`
- 官方文件：https://code.claude.com/docs/en/agent-sdk/sessions
- 官方 TypeScript API 參考：https://code.claude.com/docs/en/agent-sdk/typescript

---

## `getSessionMessages()`

```typescript
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>;

type GetSessionMessagesOptions = {
  dir?: string;                    // 專案目錄，省略則搜尋全部 projects
  limit?: number;                  // 最多回傳幾筆（從 offset 起算）
  offset?: number;                 // 從第幾筆開始（從頭算，0-based）
  includeSystemMessages?: boolean; // 是否包含 system type，預設 false
};
```

---

## `SessionMessage` — 頂層結構

```typescript
type SessionMessage = {
  type: 'user' | 'assistant' | 'system'; // 'system' 需 includeSystemMessages: true
  uuid: string;               // 訊息唯一識別符（UUID）
  session_id: string;         // 所屬 session UUID
  message: unknown;           // 實際內容，依 type 而定（見下方各節）
  parent_tool_use_id: null;   // 保留欄位，目前恆為 null
};
```

**執行期存在但不在型別定義中的欄位：**

| 欄位 | 型別 | 說明 |
|---|---|---|
| `isSidechain` | `boolean` | subagent sidechain 訊息，通常需要過濾掉 |
| `agentId` | `string` | subagent 訊息的 agent ID |

> `SessionMessage` 是歷史讀取的精簡格式。Live streaming 的 `query()` 回傳的是完整的 `SDKMessage` union（20+ 種 type），兩者不同。

---

## `type: 'assistant'` — `message` 為 `BetaMessage`

來自 `@anthropic-ai/sdk` 的 `BetaMessage`。

### `BetaMessage`

```typescript
// @anthropic-ai/sdk → resources/beta/messages/messages.d.ts
interface BetaMessage {
  id: string;                   // msg_xxxxx
  type: 'message';              // 固定值
  role: 'assistant';            // 固定值
  content: BetaContentBlock[];  // 內容區塊陣列（見下方）
  model: string;                // 'claude-sonnet-4-6' 等
  stop_reason: StopReason;
  stop_sequence: string | null; // stop_reason 為 'stop_sequence' 時有值
  usage: BetaUsage;
  container: BetaContainer | null;
}

type StopReason =
  | 'end_turn'        // 模型自然結束回合
  | 'max_tokens'      // 達到 max_tokens 上限
  | 'stop_sequence'   // 命中自訂停止序列
  | 'tool_use'        // content 中有 tool_use block 待執行
  | 'pause_turn'      // 暫停（streaming）
  | 'incomplete';     // token 限制導致中斷

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

### `BetaContentBlock` — 所有可能的 block 型別

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

#### `text` — 文字回應

```typescript
interface BetaTextBlock {
  type: 'text';
  text: string;
  citations: BetaTextCitation[] | null;
}
```

#### `thinking` — 延伸思考（Extended Thinking）

```typescript
interface BetaThinkingBlock {
  type: 'thinking';
  thinking: string;   // Claude 的內部推理過程
  signature: string;  // 多輪對話中的完整性驗證簽名
}
```

#### `redacted_thinking` — 被遮蔽的思考

```typescript
interface BetaRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;       // 加密後的思考內容
}
```

#### `tool_use` — 工具呼叫

```typescript
interface BetaToolUseBlock {
  type: 'tool_use';
  id: string;       // toolu_xxxxx，唯一識別此次呼叫
  name: string;     // 工具名稱，如 'Bash'、'Read'、'Edit'、'Agent'
  input: unknown;   // 呼叫參數（JSON object，各工具格式不同）
  caller?: BetaDirectCaller | BetaServerToolCaller;
}

interface BetaDirectCaller {
  type: 'direct';   // 直接由模型呼叫
}

interface BetaServerToolCaller {
  type: 'code_execution_20250825' | 'code_execution_20260120';
  tool_id: string;
}
```

### 範例：純文字回應

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

### 範例：工具呼叫（stop_reason: "tool_use"）

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

### 範例：含 thinking block

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

## `type: 'user'` — `message` 為 `MessageParam`

來自 `@anthropic-ai/sdk` 的 `MessageParam`。

### `MessageParam`

```typescript
// @anthropic-ai/sdk → resources/messages.d.ts
type MessageParam = {
  role: 'user';
  content: string | Array<ContentBlockParam>;
};
```

`content` 為陣列時，每個 block 的型別：

#### `text` — 使用者輸入的文字

```typescript
interface TextBlockParam {
  type: 'text';
  text: string;
  cache_control?: CacheControlEphemeral | null;
}
```

#### `tool_result` — 工具執行結果

回應前一個 assistant 訊息中的 `tool_use` block。

```typescript
interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;             // 對應的 tool_use block 的 id（toolu_xxxxx）
  content?: string | Array<
    TextBlockParam | ImageBlockParam | ...
  >;
  is_error?: boolean;              // true 表示工具執行失敗
  cache_control?: CacheControlEphemeral | null;
}
```

#### `image` — 圖片（較少見）

```typescript
interface ImageBlockParam {
  type: 'image';
  source: Base64ImageSource | URLImageSource;
  cache_control?: CacheControlEphemeral | null;
}
```

**`SDKUserMessage` 額外欄位（歷史讀取時存在於 JSONL，但非 `MessageParam`）：**

| 欄位 | 型別 | 說明 |
|---|---|---|
| `isSynthetic` | `boolean?` | SDK 內部合成的訊息，非真正使用者輸入 |
| `tool_use_result` | `unknown?` | 工具結果（部分版本） |
| `timestamp` | `string?` | ISO 時間戳，舊版本可能缺少 |
| `isReplay` | `true?` | 僅出現在 `SDKUserMessageReplay` |

### 範例：純文字輸入

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

### 範例：工具結果（content 為陣列）

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

### 範例：工具執行失敗

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

## `type: 'system'` — 系統事件（`includeSystemMessages: true`）

system 訊息的整個 JSONL 物件本身就是系統訊息結構（`message` 欄位通常為 null 或不存在）。由 `subtype` 區分：

### `subtype: 'init'` — Session 初始化

通常是 session 的第一條記錄。

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: string;
  session_id: string;
  cwd: string;                      // 工作目錄絕對路徑
  model: string;                    // 使用的模型
  tools: string[];                  // 可用工具名稱清單
  permissionMode:
    | 'default'             // 標準行為，危險操作會詢問
    | 'acceptEdits'         // 自動接受檔案編輯
    | 'bypassPermissions'   // 跳過所有權限檢查
    | 'plan'                // 規劃模式，不執行工具
    | 'auto';               // 由模型分類器決定
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

### `subtype: 'compact_boundary'` — Context Compaction 邊界

當 session 太長被壓縮時出現，標記壓縮前後的分界點。

```typescript
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  uuid: string;
  session_id: string;
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;             // 壓縮前的 token 數
    preserved_segment?: {           // 保留未壓縮的訊息段落（若有）
      head_uuid: string;
      anchor_uuid: string;
      tail_uuid: string;
    };
  };
};
```

### `subtype: 'status'` — 狀態變更

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

### `subtype: 'task_started'` — Subagent 啟動

```typescript
type SDKTaskStartedMessage = {
  type: 'system';
  subtype: 'task_started';
  uuid: string;
  session_id: string;
  task_id: string;
  tool_use_id?: string;     // 對應 parent session 的 Agent tool_use id
  description: string;      // 任務描述
  task_type?: string;
  workflow_name?: string;   // task_type 為 'local_workflow' 時有值
  prompt?: string;
};
```

### `subtype: 'task_progress'` — Subagent 進度更新

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

### `subtype: 'task_notification'` — Subagent 完成

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  uuid: string;
  session_id: string;
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;     // subagent 的 JSONL 檔案路徑
  summary: string;         // 任務執行摘要
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
};
```

---

## 訊息順序與 tool_use / tool_result 配對

一次完整的工具呼叫在 session 中會對應兩條 `SessionMessage`：

```
1. type: 'assistant'
   message.content = [{ type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: {...} }]
   stop_reason: 'tool_use'

2. type: 'user'
   message.content = [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: [...] }]
```

`tool_use.id` 與 `tool_result.tool_use_id` 相同，是配對的依據。

一個 assistant 訊息可以同時包含多個 `tool_use` block（parallel tool calls），對應的 user 訊息也會有多個 `tool_result` block。

---

## `getSubagentMessages()`

讀取 subagent 的獨立對話記錄（存在另一個 JSONL 檔案）：

```typescript
function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options?: GetSubagentMessagesOptions
): Promise<SessionMessage[]>;

// 回傳格式與 getSessionMessages() 相同，均為 SessionMessage[]
// agentId 對應 SDKTaskStartedMessage.task_id 或 Agent tool_use 的 id
```

---

## `listSessions()` 回傳的 `SDKSessionInfo`

```typescript
type SDKSessionInfo = {
  sessionId: string;
  summary: string;           // 自動生成的摘要或第一個 prompt
  lastModified: number;      // Unix timestamp（毫秒）
  fileSize?: number;         // JSONL 檔案大小（bytes）
  customTitle?: string;      // 使用者透過 /rename 設定的標題
  firstPrompt?: string;      // 第一個有意義的使用者 prompt
  gitBranch?: string;        // session 結束時的 git branch
  cwd?: string;              // session 的工作目錄
  tag?: string;              // 使用者設定的 tag
  createdAt?: number;        // 建立時間（Unix timestamp 毫秒）
};
```

---

## 參考來源

| 來源 | 路徑 |
|---|---|
| SDK 型別定義 | `@anthropic-ai/claude-agent-sdk` → `sdk.d.ts`（本機 node_modules） |
| BetaMessage / ContentBlock | `@anthropic-ai/sdk@0.71.2` → `resources/beta/messages/messages.d.ts` |
| Agent SDK 官方文件 - Sessions | https://code.claude.com/docs/en/agent-sdk/sessions |
| Agent SDK 官方文件 - TypeScript API | https://code.claude.com/docs/en/agent-sdk/typescript |
| Anthropic Messages API | https://platform.claude.com/docs/en/api/messages |
