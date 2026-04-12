# Quicksave 系統架構文件

> **維護規則**：凡修改以下任一部分時，必須同步更新此文件：
> - 新增或移除 `apps/`、`packages/` 的子模組
> - 變更 WebSocket message type（`packages/shared/src/types.ts`）
> - 變更 `MessageHandler` 的路由邏輯
> - 變更 `SessionManager` 或 `CodingAgentProvider` 的介面或生命週期
> - 變更 `AgentConnection` 的加密或 PubSub 機制
> - 變更 PWA store 的狀態結構或 hook API
> - 新增或移除 AI provider 實作（例：`ClaudeCliProvider`）

---

## 一、Monorepo 結構

```
quicksave/
├── apps/
│   ├── agent/          # Desktop daemon：AI service + Git + 加密通訊
│   ├── pwa/            # React PWA：手機/桌面 Web UI
│   └── relay/          # WebRTC 信令 relay server（最小實作）
├── packages/
│   └── shared/         # 共用 TypeScript types、crypto 工具
├── docs/
│   ├── guidelines.md   # 設計規範索引
│   ├── plans/          # 功能計劃書
│   └── references/     # 技術參考文件（含本文件）
└── tests/              # E2E 測試
```

---

## 二、apps/agent — 核心 Daemon

### 目錄結構

```
apps/agent/src/
├── service/
│   ├── run.ts              # 進程啟動點、事件串接
│   ├── ipcServer.ts        # IPC JSON-RPC server（Unix Socket）
│   ├── singleton.ts        # 單例鎖（防止重複啟動）
│   └── stateStore.ts       # 服務狀態持久化（service.json）
├── handlers/
│   └── messageHandler.ts   # 所有 WebSocket message 的路由與處理
├── connection/
│   ├── connection.ts       # AgentConnection：E2E 加密 + 訊息路由
│   ├── relay.ts            # SignalingClient：WebRTC 信令
│   ├── pubsub.ts           # Topic-based PubSub（session + broadcast 路由）
│   └── pubsub.test.ts      # PubSub 單元測試
├── ai/
│   ├── provider.ts           # CodingAgentProvider 介面 + 型別定義
│   ├── sessionManager.ts     # SessionManager：通用 session 協調層（extends EventEmitter）
│   ├── claudeCliProvider.ts  # ClaudeCliProvider：Claude CLI 實作
│   ├── cardBuilder.ts        # StreamCardBuilder：stream-json 事件 → CardEvent
│   └── sessionStore.ts       # Session 持久化（JSONL）
└── git/
    └── operations.ts         # Git 指令執行
```

### 啟動序列（`run.ts`）

```
acquireLock()
  → ipcServer.start()                                # 監聽 Unix Socket（IPC）
  → loadConfig()                                     # 讀取 ~/.quicksave/config.json
  → new AgentConnection(...)                         # 建立信令連線
  → claudeService = new SessionManager(new ClaudeCliProvider())  # 初始化 session 協調層
  → new MessageHandler(claudeService, ...)          # 初始化路由器
  → claudeService.on('card-event', ...)             # 串接 AI 事件 → WebSocket push
  → writeServiceState()                              # 寫入 service.json（ready）
  → heartbeatLoop(30s)                              # 心跳迴圈
```

### Session 生命週期（分層架構）

架構採用分層設計，由 `SessionManager` 統一協調，由 `ClaudeCliProvider` 實作 CLI 細節：

#### 層級劃分

1. **`ClaudeCliProvider`** — Claude CLI 實作細節
   - 透過 stdin/stdout 與 `claude` CLI 通訊
   - 解析 stream-json protocol（stream_event, assistant, user, system, result, control_request）
   - 管理 ChildProcess 生命週期
   - 繼承 `CodingAgentProvider` 介面

2. **`SessionManager`** — 通用協調層（extends EventEmitter）
   - Session 狀態管理（lifecycle coordination）
   - Card 組裝與歷史（StreamCardBuilder、buildCardsFromHistory）
   - Permission flow（auto-approve table、runtime allow patterns、PWA forwarding）
   - 偏好與 per-session 設定
   - 事件發射（card-event、card-stream-end、session-updated 等）
   - Session registry 整合

#### Session 操作流程

```
claude:start → MessageHandler.handle_claude_start()
  → SessionManager.startSession(opts)
    → ClaudeCliProvider.startSession()
      → spawn('claude', ['--output-format', 'stream-json', '--input-format', 'stream-json',
                          '--permission-prompt-tool', 'stdio', '-p', '', ...])
      → 等待 stdout 的 system:init 事件取得 session_id
      → stdin 寫入 { type: 'user', message: { role: 'user', content: prompt } }
      → return ProviderSession { sessionId, streamId, abort() }
    → SessionManager.startSession() 建立 card builder、permission table
    → consumeStream(sessionId, streamId):
        for await (line of stdout):
          if control_request: handleControlRequest → 自動核准 or emit card + 等使用者回應
          if stream_event/assistant/user/system: routeMessage → CardBuilder → CardEvent
          if result: emit('card-stream-end')
  ← sessionId

claude:resume → SessionManager.resumeSession(sessionId, prompt)
  → ClaudeCliProvider.resumeSession()
    → if (session.streaming && session.process):
        hot resume: stdin 寫入 user message JSON
    → else:
        cold resume: spawn('claude', [..., '--resume', sessionId])
    → return ProviderSession

claude:cancel → SessionManager.cancelSession(sessionId)
  → ClaudeCliProvider.cancelSession()
    → stdin 寫入 { type: 'control_request', request: { subtype: 'interrupt' } }

claude:close → SessionManager.closeSession(sessionId)
  → ClaudeCliProvider.closeSession()
    → process.kill('SIGTERM')
```

**Permission 處理 — control_request/control_response protocol：**
```
CLI stdout: { type: 'control_request', request_id: 'uuid', request: { subtype: 'can_use_tool', tool_name, input, tool_use_id } }
  → SessionManager.shouldAutoApprove(toolName)? 
    → stdin: { type: 'control_response', response: { subtype: 'success', request_id, response: { behavior: 'allow' } } }
  → 否則: 建立 ToolCallCard with pendingInput → emit card-event → PWA 顯示 Allow/Deny
  → 使用者回應後: sessionManager.handleUserInputResponse() → stdin: control_response with allow/deny
```

**ActiveSession 資料結構：**
```typescript
interface ActiveSession {
  sessionId: string;
  providerSession: ProviderSession;   // Provider-specific handle（包含 abort()）
  cwd: string;
  streaming: boolean;
  permissionLevel: PermissionLevel;
  sandboxed: boolean;
  cardBuilder: StreamCardBuilder | null;
  pendingControlRequests: Map<string, { requestId, toolName, toolInput, toolUseId }>;
}

interface ProviderSession {
  sessionId: string;
  streamId: string;
  abort(): Promise<void>;
}
```

### AI Provider 事件

`SessionManager` 繼承 `EventEmitter`，發出以下事件（由 `ClaudeCliProvider` 驅動）：

| 事件名稱 | Payload 型別 | 時機 |
|---|---|---|
| `card-event` | `CardEvent` | 每個 card add/update/append_text |
| `card-stream-end` | `CardStreamEnd` | turn 結束或錯誤 |
| `user-input-request` | `ClaudeUserInputRequestPayload` | 需要使用者核准工具時 |
| `session-updated` | `SessionUpdatedEvent` | session 狀態變更（active/idle） |

**Provider 介面：**
```typescript
interface CodingAgentProvider {
  startSession(opts: StartSessionOpts): Promise<ProviderSession>;
  resumeSession(sessionId: string, prompt: string, opts?: ResumeSessionOpts): Promise<ProviderSession>;
  cancelSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
```

新增 provider 時，實作此介面並傳入 `SessionManager` 建構子：
```typescript
const sessionManager = new SessionManager(new MyCustomProvider());
```

### 權限模式

| `permissionMode` | 說明 | 自動核准的工具 |
|---|---|---|
| `bypassPermissions` | 最寬鬆 | Edit, Write, Bash, WebFetch, Skill, ... 全部 |
| `acceptEdits` | 接受編輯 | Edit, Write, TodoWrite, Agent, ... |
| `default` | 標準 | TodoWrite, EnterWorktree, Agent |
| `plan` | 純規劃 | 無（不執行任何工具） |

---

## 三、通訊架構

### 端對端加密流程

```
PWA                           Relay Server                  Agent Daemon
 |                                |                              |
 |──── handshake (pubkey) ───────>|──── 轉發 ──────────────────>|
 |<─── handshake:ack (pubkey) ────|<─── 轉發 ─────────────────--|
 |                                |                              |
 |  X25519 ECDH key exchange → 產生 DEK（Data Encryption Key）   |
 |                                |                              |
 |──── [encrypt+gzip] message ───>|──── 轉發 ──────────────────>|
 |<─── [encrypt+gzip] message ────|<─── 轉發 ─────────────────--|
```

- 每個 peer 有獨立 DEK，relay server 無法解密內容
- 訊息在傳輸前會先 gzip 壓縮再加密

### PubSub 機制（`pubsub.ts`）

Topic-based pub/sub，取代舊版 `peerSessions: Map<string, string>` 一對一映射。
支援多 peer 訂閱同一 session，以及自動的 broadcast topic。

**Topic 慣例：**
| Topic 格式 | 用途 |
|---|---|
| `session:{sessionId}` | Session 級事件（cards、stream-end、user-input） |
| `broadcast` | 全域事件（session-updated、preferences-updated） |

**雙向索引：**
```typescript
class PubSub {
  topics: Map<string, Set<string>>       // topic → Set<peerAddress>  (forward)
  peerTopics: Map<string, Set<string>>   // peerAddress → Set<topic>  (reverse)
}
```
- Forward index → `subscribers(topic)` O(1)，避免全表掃描
- Reverse index → `unsubscribeAll(peer)` O(topics) 清理，斷線時用

**訂閱生命週期：**
```
Key exchange 完成 → auto-subscribe(peer, 'broadcast')
PWA 進入 session → claude:get-messages → subscribePeerToSession(peer, sessionId)
  → pubsub.subscribe(peer, 'session:{sessionId}')
PWA 離開 session → claude:unsubscribe → unsubscribePeerFromSession(peer, sessionId)
  → pubsub.unsubscribe(peer, 'session:{sessionId}')
PWA 斷線 → pubsub.unsubscribeAll(peer) 一次清理所有 topic
```

**事件路由：**
```
claudeService.emit('card-event', { sessionId, ... })
  → run.ts 攔截
  → connection.sendToSession(sessionId, message)
    → pubsub.subscribers('session:{sessionId}')   # 只發給訂閱的 peers
    → 加密 + gzip + send(peer)

claudeService.emit('session-updated', ...)
  → connection.broadcast(message)
    → pubsub.subscribers('broadcast')              # 發給所有連線 peers
```

**防禦措施：** Permission card events 若 `sendToSession` 返回 0（無訂閱者），
fallback 到 `broadcast` 確保不遺失。

### Message 請求-回應模式

```typescript
// PWA 端（useClaudeOperations.ts）
const result = await sendRequest<ResponseType>(
  { type: 'claude:start', id: uuid(), payload: {...} },
  timeoutMs = 30000
);
// 等待相同 id 的回應訊息
```

---

## 四、WebSocket Message Protocol

所有 message 格式：
```typescript
interface Message {
  type: MessageType;
  id?: string;       // 有 id = request/response 配對；無 id = push 通知
  payload?: unknown;
}
```

### 命名慣例

`{subsystem}:{action}` 或 `{subsystem}:{action}:response`

| Subsystem | 用途 |
|---|---|
| `claude:` | AI session 控制（33+ types） |
| `git:` | Git 操作（status/diff/stage/commit/...） |
| `agent:` | Daemon 管理（list-repos/add-repo/...） |
| `ai:` | AI 工具（generate-commit-summary/set-api-key/...） |
| `ping`/`pong` | 心跳 |
| `handshake`/`handshake:ack` | 連線建立 |

### Claude 相關 Message Types

| Type | 方向 | 說明 |
|---|---|---|
| `claude:list-sessions` | PWA→Agent | 列出歷史 sessions |
| `claude:list-sessions:response` | Agent→PWA | |
| `claude:start` | PWA→Agent | 啟動新 session |
| `claude:start:response` | Agent→PWA | 回傳 sessionId |
| `claude:resume` | PWA→Agent | 繼續 session |
| `claude:resume:response` | Agent→PWA | |
| `claude:cancel` | PWA→Agent | 取消 streaming |
| `claude:cancel:response` | Agent→PWA | |
| `claude:close` | PWA→Agent | 關閉 session |
| `claude:get-messages` | PWA→Agent | 讀取歷史訊息（分頁） |
| `claude:get-messages:response` | Agent→PWA | |
| `claude:card-event` | Agent→PWA（push） | card add/update/append_text |
| `claude:card-stream-end` | Agent→PWA（push） | turn 結束 |
| `claude:user-input-request` | Agent→PWA（push） | 工具審批請求 |
| `claude:user-input-response` | PWA→Agent | 使用者回應審批 |
| `claude:user-input-resolved` | Agent→PWA（push） | 審批狀態已解決 |
| `claude:session-updated` | Agent→PWA（push） | session 狀態變更 |
| `claude:set-session-permission` | PWA→Agent | 變更 session 權限模式 |
| `claude:unsubscribe` | PWA→Agent | 取消訂閱 session |
| `claude:preferences-updated` | Agent→PWA（push） | 全域偏好廣播 |

---

## 五、packages/shared — 共用型別

### 關鍵型別位置

| 型別 | 路徑（types.ts 行號） |
|---|---|
| `ClaudeSessionSummary` | 行 599 |
| `ClaudeHistoryMessage` | 行 682 |
| `ClaudeSubagentBlock` | 行 694 |
| `ClaudeGetMessagesResponsePayload` | 行 704 |
| `ClaudeStreamPayload` / `ClaudeStreamEventType` | 行 714 |
| `Card` / `CardEvent` | `cards.ts` |

### Card 資料模型

Card 是 PWA 顯示的最小單位，由 `StreamCardBuilder` 從 CLI stream-json 事件組裝：

```typescript
// packages/shared/src/cards.ts
type Card = {
  id: string;
  type: CardType;
  // ... 各型別有不同欄位
};

type CardType =
  | 'user'           // 使用者輸入
  | 'assistant_text' // Claude 文字回覆
  | 'thinking'       // 延伸思考
  | 'tool_call'      // 工具呼叫（含結果）
  | 'subagent'       // Subagent 執行塊
  | 'system';        // 系統訊息
```

---

## 六、apps/pwa — React Frontend

### 狀態管理（Zustand）

```
claudeStore.ts
  sessions: ClaudeSessionSummary[]
  activeSessionId: string | null
  isStreaming: boolean
  cards: Card[]
  historyHasMore: boolean
  selectedModel: string
  selectedPermissionMode: string
```

### Hook API（`useClaudeOperations.ts`）

```typescript
// Session 操作
listSessions(cwd?)
startSession(prompt, opts?)
resumeSession(sessionId, prompt, cwd?)
cancelSession(sessionId)
closeSession(sessionId)

// 歷史
getSessionCards(sessionId, offset?, limit?, cwd?)

// 輸入/審批
respondToUserInput(response)
setSessionPermission(sessionId, permissionMode)
unsubscribeSession(sessionId)
```

### 元件層級

```
App.tsx
└── ClaudePanel
    ├── SessionList        # sessions 列表，含 New Session 按鈕
    └── ChatView
        ├── CardRenderer   # 根據 card.type 渲染
        │   ├── UserCard
        │   ├── AssistantTextCard
        │   ├── ThinkingCard
        │   ├── ToolCallCard（含 tool result inline）
        │   └── SubagentCard
        └── InputArea      # textarea + send button
```

---

## 七、IPC 協議與 Debug CLI

### IPC 架構

Daemon 透過 Unix domain socket 提供 JSON-RPC 2.0 API，CLI 客戶端連接後即可調用。

```
CLI (index.ts)
  → IpcClient.connect(socketPath)
  → client.request('method', params)
  → IpcServer (ipcServer.ts)
    → registered method handler
  ← JSON-RPC response
```

### IPC 方法一覽

| 方法 | 用途 | 回傳型別 |
|---|---|---|
| `status` | Daemon 狀態 | `StatusResult` |
| `get-pairing-info` | QR code / 配對 URL | `PairingInfoResult` |
| `list-repos` | 已管理的 repos | `{ repos: RepoInfo[] }` |
| `add-repo` / `remove-repo` | 新增/移除 repo | `{ added/removed: boolean }` |
| `subscribe-events` | 訂閱 peer 連線事件 | — |
| `shutdown` / `restart` | 關閉/重啟 daemon | — |
| `debug` | 完整內部狀態快照 | `DebugResult` |
| `resolve-input` | 強制解決卡住的權限請求 | `{ resolved: boolean }` |
| `list-sessions` | 列出 CLI sessions（含 live state） | `{ sessions: [...] }` |
| `get-cards` | 取得 session card history | `CardHistoryResponse` |

### Debug CLI 指令

> **注意：** Debug 指令在 production build 預設關閉，需設定 `QUICKSAVE_DEBUG=1` 啟用。
> Dev 模式下預設啟用。

| CLI 指令 | IPC 方法 | 用途 |
|---|---|---|
| `service debug` | `debug` | Peers、PubSub subscriptions、pending permissions、active sessions |
| `service sessions [--cwd]` | `list-sessions` | 所有 sessions 列表（JSONL + live state） |
| `service cards <id> [--cwd] [--limit]` | `get-cards` | Session card history + pending inputs |
| `service resolve <id> [--deny]` | `resolve-input` | 手動 resolve 卡住的 permission |

### DebugResult 資料結構

```typescript
interface DebugResult {
  pid: number;
  uptime: number;
  peers: Array<{ address: string; connectedAt: number; topics: string[] }>;
  subscriptions: Record<string, string[]>;   // topic → peer addresses
  pendingInputs: Array<{ requestId: string; sessionId: string; toolName?: string; agentId?: string; inputType: string }>;
  activeSessions: Array<{ sessionId: string; cwd: string; isStreaming: boolean; hasPendingInput: boolean; permissionMode: string }>;
}
```

---

## 八、資料流總覽

```
使用者輸入 prompt
  ↓ useClaudeOperations.startSession()
  ↓ sendRequest('claude:start', payload)
  ↓ [加密] → WebRTC → [解密]
  ↓ MessageHandler.handle_claude_start()
  ↓ SessionManager.startSession()
    ↓ ClaudeCliProvider.startSession()
      ↓ spawn('claude', ['--input-format', 'stream-json', '--output-format', 'stream-json',
      ↓                    '--permission-prompt-tool', 'stdio', ...])
      ↓ stdin.write({ type: 'user', message: { role: 'user', content: prompt } })
      ↓ return ProviderSession { sessionId, streamId, abort() }
    ↓ SessionManager.startSession() 建立 card builder、permission table
    ↓ consumeStream() loop:
       for await (line of readline(proc.stdout))
         if control_request → handleControlRequest() → emit card → wait user → sendControlResponse()
         else → routeMessage() → StreamCardBuilder → CardEvent → emit('card-event')
  ↓ connection.sendToSession() → [加密] → WebRTC → [解密]
  ↓ useClaudeOperations → 收到 'claude:card-event' push
  ↓ claudeStore.handleCardEvent()
  ↓ React re-render → CardRenderer
  ↓ on 'result': turn complete, process stays alive for next stdin message
```

---

## 九、關鍵設計模式

| 模式 | 位置 | 用途 |
|---|---|---|
| EventEmitter | `SessionManager` | AI 事件廣播 |
| Strategy Pattern | `CodingAgentProvider` 介面 | 可插拔 AI provider 實作 |
| PubSub | `AgentConnection` + `pubsub.ts` | Session 級別訊息路由 |
| Request-Response | `useClaudeOperations` | 訊息 ID 配對等待 |
| Zustand Store | `claudeStore.ts` | 集中式 PWA 狀態 |
| Singleton Lock | `singleton.ts` | 確保單一 daemon |
| JSONL Append | `sessionStore.ts` | Session 歷史持久化 |

---

## 十、參考文件

| 文件 | 說明 |
|---|---|
| `docs/references/claude-agent-sdk-message-types.md` | Claude CLI stream-json 事件型別參考 |
| `docs/plans/codex-integration-plan.md` | Codex 整合計劃書 |
| `docs/plans/ui-design-rules.md` | PWA UI 設計規則 |
