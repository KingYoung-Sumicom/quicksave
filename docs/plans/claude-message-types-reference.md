# Claude Session 歷史訊息型別參考

此文件涵蓋讀取 session 歷史紀錄（`getSessionMessages`）時會碰到的所有 message type，分三層說明：
1. **SDK 原始層**：`getSessionMessages` 回傳的 `SessionMessage[]`
2. **應用層**：`claudeCodeService.getMessages()` 轉換後的 `ClaudeHistoryMessage[]`
3. **傳輸層**：透過 WebSocket 推送到 PWA 的 `ClaudeGetMessagesResponsePayload`

---

## 一、SDK 原始層：`SessionMessage`

> 來源：`@anthropic-ai/claude-agent-sdk` → `getSessionMessages(sessionId, { dir, includeSystemMessages: true })`

### 官方 API 簽名

```typescript
function getSessionMessages(
  sessionId: string,
  options?: {
    dir?: string;             // 尋找 session 的專案目錄；省略則搜尋全部
    limit?: number;           // 從 offset 起最多回傳幾筆（注意：SDK 的 offset 從頭算，應用層自行從尾部分頁）
    offset?: number;          // 跳過前幾筆（從頭算）
    includeSystemMessages?: boolean; // 是否包含 system type（預設 false）
  }
): Promise<SessionMessage[]>;
```

> **重要**：官方文件的 `SessionMessage.type` 只列 `"user" | "assistant"`。`"system"` 只在 `includeSystemMessages: true` 時才出現，且 SDK 型別定義為 `unknown` 的 `message` 欄位在 system 訊息中是整個物件本身（見 1c）。本應用呼叫時固定傳 `includeSystemMessages: true`。

### 型別定義

```typescript
// sdk.d.ts（官方）
type SessionMessage = {
  type: 'user' | 'assistant' | 'system';  // system 需 includeSystemMessages: true
  uuid: string;               // 訊息唯一識別符
  session_id: string;         // 所屬 session UUID
  message: unknown;           // 實際內容，依 type 而定（見下方各節）
  parent_tool_use_id: null;   // 保留欄位，目前恆為 null
};
```

**執行期額外欄位（非正式型別，不在 `.d.ts` 中）：**
- `isSidechain?: boolean`：subagent sidechain 訊息。`getMessages()` 以 `.filter(m => !m.isSidechain)` 排除。
- `agentId?: string`：subagent 訊息的 agent ID。

> `SessionMessage` 是**歷史讀取**的簡化格式。Live streaming 使用的是完整的 `SDKMessage` union（包含 `SDKAssistantMessage`、`SDKResultMessage`、`SDKToolProgressMessage` 等 20+ 種型別），兩者不同，請勿混用。

---

### 1a. `type: 'assistant'` → `message` 為 `BetaMessage`

assistant 訊息的 `message` 欄位是 `@anthropic-ai/sdk` 的 `BetaMessage`：

```typescript
// @anthropic-ai/sdk → resources/beta/messages/messages.d.ts
interface BetaMessage {
  id: string;                         // 訊息 ID，格式：msg_xxxxx
  role: 'assistant';
  content: BetaContentBlock[];        // 內容區塊陣列（見第二節）
  model: string;                      // 使用的模型，如 'claude-sonnet-4-6'
  stop_reason: StopReason;            // 停止原因
  stop_sequence: string | null;       // 若 stop_reason 為 'stop_sequence' 時有值
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  container: { id: string; expires_at: string } | null;  // code execution 容器
  type: 'message';                    // 固定值
}

type StopReason =
  | 'end_turn'        // 模型自然結束一個回合
  | 'max_tokens'      // 達到 max_tokens 上限
  | 'stop_sequence'   // 命中自訂停止序列
  | 'tool_use'        // 模型要呼叫工具（content 中有 tool_use block 待執行）
  | 'pause_turn'      // 暫停 turn（streaming 時）
  | 'incomplete';     // token 限制導致中斷
```

**典型 assistant 訊息結構（純文字回應）：**
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

**典型 assistant 訊息結構（工具呼叫）：**
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

### 1b. `type: 'user'` → `message` 為 `MessageParam`

user 訊息的 `message` 欄位是 `@anthropic-ai/sdk` 的 `MessageParam`：

```typescript
// @anthropic-ai/sdk → resources/messages.d.ts
type MessageParam = {
  role: 'user';
  content: string | Array<ContentBlockParam>;
};

// content 為陣列時，可包含以下 block：
// - TextBlockParam        { type: 'text', text: string }
//   → 使用者輸入的文字
// - ToolResultBlockParam  { type: 'tool_result', tool_use_id, content, is_error? }
//   → 工具執行結果（回應前一個 assistant 訊息的 tool_use）
// - ImageBlockParam       { type: 'image', source: ... }
//   → 圖片附件（較少見）
// - DocumentBlockParam    { type: 'document', source: ... }
//   → 文件附件（較少見）
```

**典型 user 訊息結構（純文字）：**
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

**典型 user 訊息結構（工具結果）：**
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

> `SDKUserMessage` 還有 `isSynthetic?: boolean`（SDK 內部合成的訊息，不是真正的使用者輸入）和 `tool_use_result?: unknown` 欄位，但這兩個在歷史讀取時通常不影響 UI 顯示。

---

### 1c. `type: 'system'` → 系統事件（僅在 `includeSystemMessages: true` 時出現）

system 訊息的整個 JSONL 物件 **本身** 就是系統訊息結構，`message` 欄位通常為 `null` 或不存在。歷史紀錄中最常見的兩種：

```typescript
// compact_boundary：context compaction 的邊界標記
// （當 session 太長，舊訊息被壓縮時出現）
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
    preserved_segment?: {           // 保留的未壓縮訊息段落
      head_uuid: string;
      anchor_uuid: string;
      tail_uuid: string;
    };
  };
  uuid: string;
  session_id: string;
};

// init：session 初始化（通常是 session 第一條訊息）
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  cwd: string;                      // 工作目錄
  model: string;                    // 模型
  tools: string[];                  // 可用工具名稱清單
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

> **應用層處理**：`claudeCodeService.getMessages()` 不區分 system 的 subtype，一律轉為 `{ role: 'system', content: 'Context compacted' }`。

---

## 二、BetaContentBlock 型別詳解

`BetaMessage.content` 的每個 block 均有 `type` 欄位區分：

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

### TextBlock — 文字回應

```typescript
interface BetaTextBlock {
  type: 'text';
  text: string;                        // Claude 回覆的文字內容
  citations: BetaTextCitation[] | null; // 引用來源（使用文件/搜尋時）
}
```

### ThinkingBlock — 延伸思考

```typescript
interface BetaThinkingBlock {
  type: 'thinking';
  thinking: string;   // Claude 的內部推理過程（可能很長）
  signature: string;  // 連續對話中的完整性驗證簽名
}

interface BetaRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;       // 被遮蔽的思考內容（加密）
}
```

### ToolUseBlock — 工具呼叫（assistant → user）

```typescript
interface BetaToolUseBlock {
  type: 'tool_use';
  id: string;                          // 工具呼叫唯一 ID，格式：toolu_xxxxx
  name: string;                        // 工具名稱，如 'Bash', 'Read', 'Edit', 'Agent'
  input: unknown;                      // 呼叫參數（JSON object，各工具不同）
  caller?: BetaDirectCaller | BetaServerToolCaller;
}
```

特殊 `name` 值：
- `'Agent'`：啟動 subagent，`input.description` 為任務描述。此 block 在 `getMessages()` 中會被跳過，改以 `subagentBlocks` 表示。

### ToolResultBlock — 工具結果（user → assistant 回合中）

出現在 user 訊息的 `content` 陣列裡，對應前一個 assistant 訊息的 `tool_use`：

```typescript
interface BetaToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;                   // 對應的 tool_use block id
  content?: string | Array<            // 工具執行結果
    BetaTextBlockParam | BetaImageBlockParam | ...
  >;
  is_error?: boolean;                    // true 表示工具執行失敗
  cache_control?: BetaCacheControlEphemeral | null;
}
```

---

## 三、應用層：`ClaudeHistoryMessage`

`claudeCodeService.getMessages()` 將 SDK 的 `SessionMessage[]` 展開（flatten）成扁平的訊息列表。**每個 SDK 訊息可能展開為多個 `ClaudeHistoryMessage`**（一個 text block + 多個 tool_use/tool_result block）。

```typescript
// packages/shared/src/types.ts
interface ClaudeHistoryMessage {
  index: number;           // 原始 SDK 訊息在 session 中的位置（0-based）
  role: 'user' | 'assistant' | 'system';
  content: string;         // 文字內容；tool_use/tool_result 訊息此欄為空字串 ''

  // 工具呼叫欄位（role 為 assistant，對應 tool_use block）
  toolName?: string;       // 工具名稱，如 'Bash'、'Read'
  toolInput?: string;      // 工具輸入，JSON.stringify 後的字串
  toolUseId?: string;      // tool_use block 的 id（toolu_xxxxx）

  // 工具結果欄位（role 為 user，對應 tool_result block）
  toolResult?: string;     // 工具執行結果文字（超過限制則截斷）
  toolResultForId?: string; // 此結果對應的 tool_use id
  truncated?: boolean;     // 結果是否已截斷（超過 TOOL_RESULT_TRUNCATE_LENGTH）
}
```

### 訊息類型對照表

| SDK block type | `role` | `content` | 有效欄位 |
|---|---|---|---|
| `text` block（assistant）| `assistant` | 文字內容 | `content` |
| `thinking` block | 不轉換，僅在 stream 中出現 | — | — |
| `tool_use` block（非 Agent）| `assistant` | `''` | `toolName`, `toolInput`, `toolUseId` |
| `tool_use` block（Agent）| 跳過 → 見 subagentBlocks | — | — |
| `tool_result` block（非 Agent）| `user` | `''` | `toolResult`, `toolResultForId`, `truncated?` |
| `tool_result` block（Agent）| 跳過 → 見 subagentBlocks | — | — |
| `system` type（任何 subtype）| `system` | `'Context compacted'` | `content` |
| user 純字串 content | `user` | 文字內容 | `content` |

> **注意**：text block 若與 tool_use 同屬同一個 assistant 訊息，text 會被 `unshift` 到前面，且共用相同的 `index`。

---

## 四、subagentBlocks：Subagent 摘要

Agent tool_use 不出現在 `messages` 陣列中，而是彙整進 `subagentBlocks`：

```typescript
// packages/shared/src/types.ts
interface ClaudeSubagentBlock {
  toolUseId: string;           // 對應 parent session 的 Agent tool_use id
  agentId: string;             // 目前與 toolUseId 相同
  description: string;         // Agent tool input.description（任務描述）
  summary?: string;            // 從 tool_result 中取出的結果摘要（前 200 字）
  status: 'running' | 'completed' | 'failed' | 'stopped';
  toolUseCount: number;        // 目前恆為 0（歷史讀取時不計算）
  lastToolName?: string;
}
```

判斷邏輯：若 Agent tool_use 有對應的 tool_result → `status: 'completed'`；否則 → `status: 'running'`。

---

## 五、回應 Payload：`ClaudeGetMessagesResponsePayload`

從 agent 傳回 PWA 的完整 payload：

```typescript
// packages/shared/src/types.ts
interface ClaudeGetMessagesResponsePayload {
  messages: ClaudeHistoryMessage[];
  total: number;           // session 中所有 SDK 訊息的總數（未分頁）
  hasMore: boolean;        // 是否還有更舊的訊息（tailStart > 0）
  error?: string;

  // 從所有訊息建立的 toolUseId → toolName 映射表（非僅當前分頁）
  // 供 tool_result 訊息反查對應工具名稱
  toolNameMap?: Record<string, string>;

  subagentBlocks?: ClaudeSubagentBlock[];
}
```

### 分頁邏輯

```
total 筆 SDK 訊息，從尾部往前取：
  tailEnd   = max(0, total - offset)
  tailStart = max(0, total - offset - limit)
  sliced    = allMessages[tailStart..tailEnd]

hasMore = tailStart > 0
```

即：`offset=0, limit=50` 取最新 50 筆；`offset=50` 取更舊的 50 筆。

---

## 六、PWA 側的 UI Message 格式

PWA `claudeStore` 中的 `messages` 陣列是 `ClaudeHistoryMessage`（歷史）加上 streaming 期間的即時事件，UI 顯示時還有一個額外欄位：

```typescript
// ClaudeHistoryMessage + 即時 streaming 擴充
interface UIMessage extends ClaudeHistoryMessage {
  // 僅在 streaming 時存在，歷史讀取不會有此欄位
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

## 七、資料流總覽

```
JSONL 檔案（~/.quicksave/state/sessions/<id>/）
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

## 八、參考來源

| 來源 | 路徑 |
|---|---|
| 應用層型別定義 | `packages/shared/src/types.ts` 行 682–711 |
| 訊息解析邏輯 | `apps/agent/src/ai/claudeCodeService.ts` 行 270–392 |
| SDK 型別定義 | `@anthropic-ai/claude-agent-sdk` → `sdk.d.ts` |
| BetaMessage / ContentBlock 型別 | `@anthropic-ai/sdk` → `resources/beta/messages/messages.d.ts` |
| Agent SDK 官方文件 - Sessions | https://code.claude.com/docs/en/agent-sdk/sessions |
| Agent SDK 官方文件 - TypeScript API | https://code.claude.com/docs/en/agent-sdk/typescript |
| Anthropic Messages API 官方文件 | https://platform.claude.com/docs/en/api/messages |
