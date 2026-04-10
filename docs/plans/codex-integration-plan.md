# OpenAI Codex Agent 整合計劃書

## 背景與目標

Quicksave 目前只支援 Anthropic Claude（透過 `@anthropic-ai/claude-agent-sdk`）。本計劃書說明如何整合 OpenAI Codex，讓使用者可以選擇使用 Codex agent 執行 session。

**目標：**
- 不破壞現有 Claude 功能
- PWA 端不感知 provider 差異（相同的 card/message 格式）
- 最小化重複程式碼

**相關參考文件：**
- 現有架構：`docs/references/quicksave-architecture.md`
- Claude SDK 型別：`docs/references/claude-agent-sdk-message-types.md`
- Codex SDK 型別：`docs/references/openai-codex-sdk-types.md`

---

## Happy Coder 的接法（參考）

> 來源：https://github.com/slopus/happy-cli（MIT open source）

Happy Coder 是目前最成熟的 Codex mobile client，他們的做法提供了重要參考。

### 關鍵發現：不用 `@openai/codex-sdk`，改走 MCP

Happy Coder **完全不使用** `@openai/codex-sdk` npm 套件。他們透過 Codex CLI 內建的 **MCP server**（`codex mcp-server`）來驅動 Codex，使用 `@modelcontextprotocol/sdk` 的 `StdioClientTransport` 與其通訊：

```typescript
// happy-cli: src/codex/codexMcpClient.ts
this.transport = new StdioClientTransport({
  command: 'codex',
  args: ['mcp-server'],  // >=0.43.0-alpha.5，舊版用 'mcp'
  env: process.env,
});
await this.client.connect(this.transport);

// 啟動 session（第一條 prompt）
await this.client.callTool({ name: 'codex', arguments: config });

// 繼續 session（後續 prompt）
await this.client.callTool({
  name: 'codex-reply',
  arguments: { sessionId, conversationId, prompt },
});
```

### MCP 接法的優點

1. **不綁定 SDK 版本**：MCP 是穩定介面，`@openai/codex-sdk` 才是 experimental
2. **Codex CLI 自己管工具執行**：bash、file patch 都在 CLI 側完成，host process 不需要處理
3. **審批走 MCP elicitation**：標準化協議，不需要自訂 callback

### Happy Coder 的 MCP 事件格式

Codex 透過 MCP notification（`codex/event`）推送事件，`msg.type` 的值：

| `msg.type` | 說明 |
|---|---|
| `task_started` | Turn 開始 |
| `task_complete` | Turn 完成 |
| `turn_aborted` | Turn 被取消 |
| `agent_message` | 最終 assistant 文字 |
| `agent_reasoning_delta` | 推理 token（streaming） |
| `agent_reasoning` | 完整推理塊 |
| `agent_reasoning_section_break` | 推理段落分隔 |
| `exec_command_begin` | Bash 指令開始 |
| `exec_approval_request` | Bash 指令需要審批 |
| `exec_command_end` | Bash 指令結果 |
| `patch_apply_begin` | 檔案 patch 開始 |
| `patch_apply_end` | 檔案 patch 結果 |
| `turn_diff` | 本次 turn 的 unified diff |
| `token_count` | Token 用量 |

### Happy Coder 的事件 → Card 對應

```
agent_message        → type: 'message'    { message }
exec_command_begin   → type: 'tool-call'  { name: 'CodexBash', callId, input: { command[], cwd } }
exec_command_end     → type: 'tool-call-result' { callId, output }
patch_apply_begin    → type: 'tool-call'  { name: 'CodexPatch', callId, input: { changes } }
patch_apply_end      → type: 'tool-call-result' { callId, output }
agent_reasoning_*    → type: 'tool-call'  { name: 'CodexReasoning' }（由 ReasoningProcessor 組合）
turn_diff            → type: 'tool-call'  { name: 'CodexDiff', input: { unified_diff } }
```

Claude 和 Codex 的訊息共用同一個 `NormalizedMessage` 格式，`MessageView → ToolView` 管線統一渲染。

### Happy Coder 的審批機制（最重要）

**這就是「pre-rendered card」做法：**

1. Codex 送出 `exec_approval_request` MCP notification
2. Happy CLI 同時：
   - 對 mobile app 推送 `tool-call` card（name: `CodexBash`，含 command）
   - 掛起 MCP elicitation handler（`ElicitRequestSchema`），等待 Promise resolve
3. Mobile app 渲染卡片，使用者點按鈕
4. Mobile app 透過 WebSocket 回傳 RPC response 給 CLI
5. CLI 的 Promise resolve，回傳 `{ decision: 'approved' | 'approved_for_session' | 'denied' | 'abort' }` 給 Codex MCP
6. Codex 繼續執行

**關鍵：** Mobile app 不做任何 pattern matching。CLI 已把意圖 encode 進 card type（`CodexBash`），client 只需查 `knownTools` 表渲染即可。

### permissionMode → Codex 設定映射（來自 Happy Coder）

| Quicksave `permissionMode` | Codex `approval-policy` | Codex `sandbox` |
|---|---|---|
| `default` | `untrusted` | `workspace-write` |
| `acceptEdits` | `on-request` | `workspace-write` |
| `bypassPermissions` | `on-failure` | `danger-full-access` |
| `plan` | `untrusted` | `workspace-write` |

### Session Resume（Happy Coder 的做法）

Codex 自己的 session transcript 存在 `~/.codex/sessions/...-{sessionId}.jsonl`。Resume 時找到對應 JSONL 並傳入 `config.experimental_resume`，等於重新啟動但帶入舊歷史。這是 experimental 做法，不穩定。

---

## 現況分析

### 問題點

目前 `ClaudeCodeService`（`apps/agent/src/ai/claudeCodeService.ts`）直接硬耦合 Anthropic SDK，`MessageHandler` 也直接持有 `ClaudeCodeService` 實例，且 message type 全部命名為 `claude:xxx`。

### Claude 與 Codex 接法對比

| 功能 | Claude（SDK） | Codex（MCP via CLI） |
|---|---|---|
| 建立 session | `unstable_v2_createSession()` | `mcp.callTool('codex', config)` |
| 繼續 session | `unstable_v2_resumeSession()` | `mcp.callTool('codex-reply', { sessionId, prompt })` |
| Streaming | `SDKMessage` union（20+ types） | MCP notification `codex/event`（~12 types） |
| 工具執行 | Host process 回傳 `tool_result` | CLI 內部自動執行 |
| 審批 | `canUseTool` callback | MCP `ElicitRequest` handler |
| 歷史讀取 | `getSessionMessages()` | 讀 `~/.codex/sessions/*.jsonl`（experimental） |
| 列出 sessions | `listSessions()` | 讀 `~/.codex/sessions/` 目錄 |
| Subagent | `listSubagents()` + sidechain | `collabAgentToolCall` item |

---

## 整合架構設計

### 1. Provider 介面

在 `apps/agent/src/ai/` 新增：

```
apps/agent/src/ai/
├── claudeCodeService.ts   # 現有（加上 implements AgentProvider）
├── codexService.ts        # 新增：MCP-based Codex provider
├── agentProvider.ts       # 新增：共用介面
└── cardBuilder.ts         # 現有（Claude 用，Codex 另建）
```

```typescript
// agentProvider.ts
export interface AgentProvider extends EventEmitter {
  startSession(opts: StartSessionOpts): Promise<string>;
  resumeSession(sessionId: string, prompt: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): void;
  listSessions(cwd: string): Promise<AgentSessionSummary[]>;
  getMessages(sessionId: string, cwd: string, offset?: number, limit?: number): Promise<GetMessagesResult>;
  getActiveSessionIds(): string[];
}
```

### 2. `CodexService` — MCP 接法

```typescript
// apps/agent/src/ai/codexService.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class CodexService extends EventEmitter implements AgentProvider {
  private client: Client;

  async connect() {
    const transport = new StdioClientTransport({
      command: 'codex',
      args: ['mcp-server'],
      env: process.env,
    });
    await this.client.connect(transport);

    // 註冊 streaming 事件
    this.client.setNotificationHandler(
      z.object({ method: z.literal('codex/event'), params: z.object({ msg: z.any() }) }).passthrough(),
      ({ params }) => this._handleCodexEvent(params.msg),
    );

    // 審批（MCP elicitation）
    this.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const decision = await this._requestApproval(req.params);
      return { decision };
    });
  }

  async startSession(opts: StartSessionOpts): Promise<string> {
    const res = await this.client.callTool({
      name: 'codex',
      arguments: {
        prompt: opts.prompt,
        cwd: opts.cwd,
        model: opts.model,
        'approval-policy': permissionModeToApprovalPolicy(opts.permissionMode),
        sandbox: permissionModeToSandbox(opts.permissionMode),
      },
    });
    return res.sessionId;
  }

  async resumeSession(sessionId: string, prompt: string): Promise<void> {
    await this.client.callTool({
      name: 'codex-reply',
      arguments: { sessionId, prompt },
    });
  }
}
```

### 3. Codex MCP Event → CardEvent 對應

```
exec_approval_request → user-input-request 事件（同時在 client 掛起 Promise）
task_started         → （記錄 sessionId）
agent_message        → add card { type: 'assistant_text', text }
agent_reasoning_*    → add/append card { type: 'thinking' }
exec_command_begin   → add card { type: 'tool_call', toolName: 'Bash', toolInput: command }
exec_command_end     → update card（加入 output、exit_code）
patch_apply_begin    → add card { type: 'tool_call', toolName: 'Edit', toolInput: changes }
patch_apply_end      → update card（加入 result）
turn_diff            → add card { type: 'tool_call', toolName: 'Diff', toolInput: { unified_diff } }
task_complete        → card-stream-end
turn_aborted         → card-stream-end（cancelled）
```

### 4. 審批卡片 — Pre-rendered card 做法

與 Happy Coder 相同，`exec_approval_request` 到來時：

1. `CodexService` emit `user-input-request`（現有格式，加入 `provider: 'codex'`）
2. `MessageHandler` 推送給 PWA（現有 `claude:user-input-request` channel）
3. PWA 渲染審批卡片（已有 `PermissionPrompt` 元件）
4. 使用者點按後 PWA 送 `claude:user-input-response`
5. `CodexService` resolve elicitation Promise，回傳 `decision` 給 Codex

PWA 端**不需要修改**，因為使用現有的 `user-input-request` 格式。

### 5. MessageHandler 多 Provider 支援

```typescript
class MessageHandler {
  private claudeService: ClaudeCodeService;
  private codexService: CodexService;
  private sessionProviders = new Map<string, 'claude' | 'codex'>();

  private getProvider(sessionId: string): AgentProvider {
    return this.sessionProviders.get(sessionId) === 'codex'
      ? this.codexService
      : this.claudeService;
  }
}
```

`claude:start` payload 加入 `provider?: 'claude' | 'codex'`（預設 `'claude'`）。

---

## 實作步驟

### Phase 1：抽象層

1. 新增 `agentProvider.ts`，定義 `AgentProvider` 介面
2. `ClaudeCodeService implements AgentProvider`

### Phase 2：CodexService

1. 安裝依賴：`@modelcontextprotocol/sdk`（已有？）、確認 `codex` CLI 可執行
2. 實作 `CodexService`（MCP 接法）：
   - `connect()` → StdioClientTransport + 註冊 notification/elicitation handler
   - `startSession()` → `callTool('codex', ...)`
   - `resumeSession()` → `callTool('codex-reply', ...)`
   - `cancelSession()` → AbortController + `turn_aborted` event
   - `listSessions()` → 讀 `~/.codex/sessions/` 目錄
   - `getMessages()` → 讀 Codex JSONL transcript（或從 CardEvent 快取）
3. `MessageHandler` 整合 `CodexService`

### Phase 3：PWA UI

1. `ClaudeStartRequestPayload` 加入 `provider?` 欄位
2. `ClaudeSessionSummary` 加入 `provider?` 欄位
3. `NewSessionEmptyState` 加入 Provider 選擇器
4. Session list 加入 provider badge（Claude / Codex）

### Phase 4：歷史讀取

- 讀取 Codex JSONL transcript（`~/.codex/sessions/`）並轉換為 `Card[]`
- 或：`startSession` 結束後把 cards 快取，`getMessages` 從快取讀

---

## 風險與注意事項

| 風險 | 說明 | 緩解方案 |
|---|---|---|
| MCP server 指令版本差異 | `>=0.43.0-alpha.5` 用 `mcp-server`，舊版用 `mcp` | 啟動時偵測版本，自動選擇 |
| Codex transcript 格式是 experimental | `experimental_resume` 可能在 Codex 更新後失效 | 從 CardEvent 自建快取，不依賴 Codex JSONL |
| MCP elicitation 非標準 | `ElicitRequestSchema` 是 MCP 的 draft spec | 同 Happy Coder 做法，接受此風險 |
| `codex` CLI 需要獨立安裝 | 不是 npm 依賴，需用戶手動安裝 | `npm i -g @openai/codex`，daemon 啟動時檢查 |
| Session ID 格式衝突 | Codex session ID 格式未知 | 加前綴 `codex:` |

---

## 不在本次範圍

- 使用者 OpenAI API key 管理 UI
- Codex 的 `experimental_resume` 跨機器同步
- 跨 provider session 歷史合併顯示
