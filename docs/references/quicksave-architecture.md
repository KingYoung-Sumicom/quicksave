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
│   ├── claudeCliProvider.ts  # ClaudeCliProvider：Claude CLI 實作（互動式 session）
│   ├── cardBuilder.ts        # StreamCardBuilder：stream-json 事件 → CardEvent
│   ├── sessionStore.ts       # Session 持久化（JSONL）
│   ├── commitSummary.ts      # CommitSummaryService：commit message via Anthropic SDK（需 API key）
│   └── commitSummaryCli.ts   # CommitSummaryCliService：commit message via `claude -p`（agentic，用 Claude 訂閱）
├── terminal/
│   └── terminalManager.ts    # PTY pool + 每個 terminal 的 scrollback buffer
├── files/
│   └── fileBrowser.ts        # 唯讀檔案瀏覽器（list / read，含 path sandboxing）
└── git/
    └── operations.ts         # Git 指令執行
```

> **Terminal 子系統**：`TerminalManager`（見上）是一個獨立的 EventEmitter，與 AI session 不共享狀態。它用 `node-pty` 開啟 shell（預設 `$SHELL -l`），把每個 PTY 的原始輸出（含 ANSI 碼）保留在一個上限 256 KiB 的 ring buffer 裡。PWA 透過 `/terminals` + `/terminals/:id/output` 兩個 bus 訂閱重建終端機畫面，離線重連時 snapshot 會帶回整個 scrollback，讓畫面立刻回到斷線前的狀態。

> **File browser 子系統**：`FileBrowser`（`apps/agent/src/files/fileBrowser.ts`）是純 request-response、無狀態的唯讀模組——沒有 EventEmitter、沒有 bus subscription，因為檔案內容是 on-demand 抓取而非串流。每次請求都帶 `cwd`（專案根）+ `path`（相對路徑），`resolveWithinRoot()` 會把目標 resolve 到絕對路徑後 assert 仍位於 `realpath(cwd)` 之內，越界即拒；二進位偵測用前 8 KiB 的 NUL byte sniff，預設預覽上限 100 KiB（`maxBytes` 可覆寫，但被 hard-clamp 在 512 KiB）。

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
                          '--permission-prompt-tool', 'stdio', '--append-system-prompt', '...',
                          '-p', '', ...])
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
  → 1. Hot resume (active turn): existing.streaming && providerSession.alive
       → 將 streamId push 到 providerSession.pendingStreamIds，stdin 寫入 user message
         consumeStream 在當前 turn result 後消耗 pendingStreamIds 開新 turn
  → 2. Hot resume (idle): !existing.streaming && providerSession.alive && !modelChanged
       → 直接重用同一個 CLI process：cardBuilder.startNewTurn(newStreamId)，
         providerSession.currentStreamId = newStreamId，resultEmitted = false，
         stdin 寫入 user message。避免 kill+spawn 的延遲與「ghost inactive」閃爍。
  → 3. Cold resume: providerSession 已死或 model 改變
       → spawn('claude', [..., '--resume', sessionId])
       → 注意：CLI 的 --resume 可能 fork 新的 session_id（由 init 事件回報）。
         若新 id 與 opts.sessionId 不同，SessionManager 會 rekey sessions map
         及 side maps (migrateSessionIdState)，並對舊 id emit isActive=false，
         讓 PWA 清掉舊的 active 狀態。

claude:cancel → SessionManager.cancelSession(sessionId)
  → ClaudeCliProvider.cancelSession()
    → stdin 寫入 { type: 'control_request', request: { subtype: 'interrupt' } }

claude:close → SessionManager.closeSession(sessionId)
  → ClaudeCliProvider.closeSession()
    → process.kill('SIGTERM')
  （只 kill 底層 CLI process；registry entry 維持在 active 列表，
   給 Advanced > Terminate Coding Agent Process 使用）

claude:end-task → handleClaudeEndTask
  → 1. 先抓 SessionManager.getSessionCwd(sessionId) 拿 cwd（process 還活著時）
       若 session 不在 in-memory map，fall back getSessionRegistry().findBySessionId
       以便冷掉的 session 也能 archive。
  → 2. SessionManager.closeSession(sessionId) — kill live process（如果有）
  → 3. registry.updateEntry(cwd, sessionId, { archived: true })
       + onHistoryUpdated(cwd, entry, 'upsert') 廣播 /sessions/history
  PWA 端 End Task 按鈕走這條，session 從 active 列表消失、進 archived。

CLI process 自然退出 (stdout EOF 或 crash):
  → consumeStream finally block:
      - 失敗所有 pendingControlResponses
      - 若未 emit result，補 emit streamEnd { error: 'Process exited unexpectedly' }
      - callbacks.onSessionExited(sessionId, providerSession)
  → SessionManager.onSessionExited:
      - 若當前 slot 的 providerSession 仍是同一個（未被 cold resume 取代）
        → sessions.delete(sessionId) + emitSessionUpdate(isActive=false)
      - providerSession identity check 保護：避免 cold resume 期間舊 CLI 死掉
        的 stale callback 誤清新 CLI 的 session
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
  /** Optional — claude-code CLI only. Queries `get_context_usage`
   * control_request and returns a category-level breakdown of the
   * current context window. Fetched after every turn_ended and stored
   * in the event's data blob (see `contextUsage` field). */
  getContextUsage?(): Promise<ContextUsageBreakdown | null>;
}
```

### Session Registry（persistence）

`SessionRegistry`（`ai/sessionRegistry.ts`）負責 session metadata 的持久化，分兩層 on-disk 子樹：

```
~/.quicksave/state/session-registry/
├── {encoded-cwd}/                        # Active 子樹 — daemon 啟動時全部載入記憶體
│   └── {sessionId}.json
└── archived/
    └── {encoded-cwd}/                    # Archived 子樹 — 只在需要時讀磁碟，不進記憶體
        └── {sessionId}.json
```

- `encoded-cwd` 把 `/` 替換成 `-`（對齊 Claude Code `~/.claude/projects/` 慣例）
- **記憶體只保留 active entries**：archive 後 daemon 記憶體佔用 & `/sessions/history` snapshot 大小只跟「使用中」的 session 數成正比，與歷史總量無關
- `upsertEntry(entry)` 依 `entry.archived` 自動路由到正確子樹，並刪掉另一邊的舊檔；`updateEntry()` 能找 memory 或 archived 磁碟上的 entry，翻轉 `archived` flag 時自動搬家
- `loadAll()` 忽略 `archived/` 子目錄；若在 active 子樹遇到 `archived: true` 的 legacy 檔案會自動搬到 archived 子樹（一次性遷移）
- 需要讀取 archived metadata（unarchive UI 之類）：`readArchivedEntry(cwd, id)` / `listArchivedEntries(cwd?)` 都 on-demand 讀磁碟

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

**Sandbox MCP 工具權限：**
- `UpdateSessionStatus` — 永遠自動核准，在 `sessionManager.shouldAutoApprove` 中處理，把
  `subject` / `stage` / `blocked` / `note` 寫回 session config 與 `SessionRegistryEntry`，
  並觸發 `session-config-updated` 事件。`note` 欄位採 append-only：每次呼叫附帶非空 `note`
  時，會附加一筆 `{ts, text}` 到 `SessionRegistryEntry.noteHistory`，超過
  `SESSION_NOTE_HISTORY_CAP`（50）時由舊至新裁切；同時把最新一行鏡射到 `note` 供 home
  screen 快速顯示。`noteHistory` 透過既有的 `/sessions/history` bus 頻道廣播。
- `SandboxBash`（sandbox ON）— 自動核准，在 kernel sandbox 內執行
- `SandboxBash`（sandbox OFF）— 視為 `Bash`，依 permissionMode 的 auto-approve 規則處理

### System Prompt

透過 `--append-system-prompt` CLI 參數注入，start 和 resume 都帶。固定內容：
- 引導 Claude 偏好 `SandboxBash` 做 read-only commands
- 要求 Claude 在每個新 session 的第一回合呼叫 `UpdateSessionStatus`（ticket model：
  `subject` + `stage ∈ {investigating, working, verifying, done}` + `blocked` flag + `note`），
  並在 stage 變化 / 卡住解除 / 有值得回報的進度時再次更新。`note` 會寫入 session 的 append-only
  event log（`noteHistory`），長任務（研究 / 大型重構）鼓勵在每個 sub-goal 或 finding 時
  emit 一筆 note，供 user 開啟 session 時 skim 最近幾筆作為進度訊號
- PWA agent type 可附加自定義 system prompt

### Commit Message 生成（兩條路徑）

`ai:generate-commit-summary` 的 payload 帶 `source: 'api' | 'claude-cli'`（預設 `'api'`）。`handleGenerateCommitSummary` 依此分流：

- **`source: 'api'`** → `CommitSummaryService`（`commitSummary.ts`）
  - 透過 Anthropic SDK 直接打 API（需使用者在 Settings 設定 Anthropic API key）
  - 把 staged diff 截斷後塞進單一 prompt，快速但看不到跨檔案 context
  - 有 in-memory cache（5 分鐘 TTL，按 diff + model + context 做 key）

- **`source: 'claude-cli'`** → `CommitSummaryCliService`（`commitSummaryCli.ts`）
  - 一次性 spawn `claude -p "<prompt>"`，`--output-format stream-json --verbose --no-session-persistence`
  - 只 whitelist 只讀工具：`Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(git show:*),Bash(git blame:*)`
  - 走使用者本地 Claude Code 訂閱／登入，**不需要** Anthropic API key
  - Agentic loop：Claude 自行跑 `git diff --cached`、grep 相關 caller、讀周邊檔案後再寫訊息
  - Stream-json events 用 `interpretStreamEvent()` 解析成 `CommitSummaryProgress`（`preparing` / `inspecting` / `generating` / `finalizing`）一路 push 給 PWA
  - 不快取（輸出非決定性）；timeout 120s；exit code / stderr 會 map 成 `NO_CLI_BINARY` / `NO_CLI_AUTH` / `CLI_TIMEOUT` / `CLI_PARSE_ERROR` / `CLI_ERROR` 傳回 UI

#### Agent-Owned Commit Summary State

Generation 可能跑 ~2 分鐘，state 住在 PWA 會被 reload / 換 tab 打斷。所以 AI-generated suggestion 的 state 搬到 agent 上由 `CommitSummaryStateStore`（`ai/commitSummaryStore.ts`）保管：

- 按 `repoPath` 分桶；每桶一個 `CommitSummaryState`（status: `idle` / `generating` / `ready` / `error`）
- `startGenerating()` 回傳一個 opaque `Symbol` token；後續 progress / result / error 寫入都要帶 token，token 不匹配就 drop（避免 stale 或 superseded 的 run 覆寫新 state）
- 每次狀態變更 emit `state-updated`；`service/run.ts` 把事件 bridge 到 `connection.broadcast('ai:commit-summary:updated', state)`，所有連線的 peer 一起同步
- 訊息 API：
  - `ai:generate-commit-summary` — kickoff（同步回 kickoff response，後續靠 push）
  - `ai:commit-summary:clear` — 使用者 dismiss 或 apply 後清掉；kill 在跑的 CLI
  - `/repos/commit-summary` bus subscription — PWA 連線時自動拿 snapshot + 增量，重連時 bus 會自動重送 sub（取代已移除的 `ai:commit-summary:get` 命令）
  - `ai:commit-summary:updated` — agent → PWA 的 state push（列在 `CROSS_TAB_MESSAGE_TYPES`，BroadcastChannel 同裝置多 tab 共用）
- Commit 成功後 `handleCommit` 自動呼叫 `commitSummaryStore.clear(repoPath)`（suggestion 已 stale）
- PWA gitStore 只做 mirror：收到 `ai:commit-summary:updated` → `applyCommitSummaryState()`；使用者打的 commit draft 仍是 PWA localStorage，不進 agent

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

### MessageBus (`packages/message-bus`) — PWA↔Agent 的 RPC + PubSub

PWA 與 Agent 之間的所有 request-response、state subscribe、server push 都走 MessageBus。用 `bus:frame` 封包信封疊在既有 `Message` 之上，封裝 `command` / `subscribe(+snapshot)` / `publish` 三個 primitives：

- **Server transport** (`apps/agent/src/messageBus/busServerTransport.ts`) 包住 `AgentConnection`，過濾 `type === 'bus:frame'` 的訊息；其餘 message（handshake、`push:subscription-offer`）走舊路徑。
- **Client transport** (`apps/pwa/src/lib/busClientTransport.ts`) 由外部驅動（`notifyMessage` / `notifyConnected` / `notifyDisconnected`），因 `WebSocketClient` 只有單一 `onMessage` callback。
- **Snapshot-on-subscribe**：`sub` frame 的 snapshot 是原子交付，斷線重連後 `MessageBusClient` 自動重發 `sub`，server 再次送出當下的 snapshot，消除「reconnect 後狀態 stale」視窗。
- **Command queueing**：PWA 的 `bus.command(verb, payload, { queueWhileDisconnected: true })` 會在未連線時 hold 住，連上後自動 flush；避免 reconnect 競態丟失請求。

**現行 subscribe path：**
| Path | Snapshot 型別 | Update 型別 | 來源 |
|---|---|---|---|
| `/sessions/active` | `SessionUpdatePayload[]` | `SessionUpdatePayload` | `claudeService.snapshotActiveSessions()` + `session-updated` 事件 |
| `/preferences` | `ClaudePreferences` | `ClaudePreferences` | `claudeService.getPreferences()` + `preferences-updated` 事件 |
| `/sessions/history` | `SessionRegistryEntry[]` | `SessionHistoryUpdatedPayload` | `sessionRegistry.getEntriesForProject()`（active only；archived 不在此 snapshot）+ `messageHandler.onHistoryUpdated` |
| `/repos/commit-summary` | `CommitSummaryState[]` | `CommitSummaryState` | `commitSummaryStore.snapshot()` + `state-updated` 事件 |
| `/sessions/config` | `Record<sessionId, Record<key, ConfigValue>>` | `SessionConfigUpdatedPayload` | `claudeService.getAllSessionConfigs()` + `session-config-updated` 事件 |
| `/sessions/:sessionId/cards` | `CardHistoryResponse`（offset=0、含 pendingInput overlay + title） | `SessionCardsUpdate`（`{ kind: 'card', event }` 或 `{ kind: 'stream-end', result }`） | `claudeService.getCards()` + `card-event` / `card-stream-end` 事件 |
| `/sessions/:sessionId/attention` | `null`（presence-only） | — | PWA 僅在 session 頁面且 tab 可見+獲焦時訂閱；`subscriberCount === 0` 作為 push gate |
| `/terminals` | `TerminalSummary[]` | `TerminalsUpdate`（`{ kind: 'upsert', terminal }` 或 `{ kind: 'remove', terminalId }`） | `terminalManager.listSummaries()` + `terminals-updated` / `terminal-updated` 事件 |
| `/terminals/:terminalId/output` | `TerminalOutputSnapshot \| null`（scrollback + seq + size + exit 狀態） | `TerminalOutputChunk`（新一段輸出，monotonic `seq`） | `terminalManager.outputSnapshot()` + PTY `'data'` 事件 |

**Command adapter**（`service/run.ts` — `LEGACY_BUS_VERBS`）：
所有 request-response verb（`git:*`、`ai:*`、`agent:*`、`claude:*`、`session:*`、`project:*`、`push:*`、`codex:*`、`terminal:*`、`files:*`）在啟動時被註冊成 `bus.onCommand(verb, ...)`。Adapter 把 payload 包回 `Message` 信封，dispatch 給既有 `messageHandler.handleMessage`，把結果翻譯回 resolved payload 或 reject Error。結構化錯誤編碼成 `"CODE: message"` 字串（PWA 端靠 `err.message.startsWith('REPO_MISMATCH')` 辨識）。

> ⚠️ **Gotcha — 加新 request/response verb 必須兩處同步**：`LEGACY_BUS_VERBS` 是顯式 allowlist，不在裡面的 verb 即使在 `messageHandler` 的 `switch` 有 case，bus 也不會註冊 handler，PWA 端會收到 `"Unknown command: <verb>"` reject。新增任何 PWA→Agent 命令時，三處都要動：(1) `packages/shared/src/types.ts` 的 `MessageType` union 與 `protocol.ts` 的 request→response 對應；(2) `messageHandler.ts` 的 switch case + handler；(3) `run.ts` 的 `LEGACY_BUS_VERBS` 陣列。

**`git:*` 的 `__repoPath` smuggle**：bus 協議沒有信封級 metadata，所以 `useGitOperations.sendCommand` 把當前 repoPath 塞到 payload 的保留欄 `__repoPath`；adapter 讀出後放回 `msg.repoPath` 給 REPO_MISMATCH guard 檢查，回應時再把 server 認可的 repoPath 鏡射回 data 的 `__repoPath` 讓 PWA 做 scope 驗證。

**PubSub 內部（`connection/pubsub.ts`）**：
`AgentConnection` 內部仍保留 topic-based pubsub 供 `connection.broadcast()` 使用（全域廣播給所有 peers），但 PWA ↔ Agent 的 session/state 事件都已改走 MessageBus 的 `/path` 訂閱，不再需要 `session:{id}` 這類 topic。Broadcast topic 主要留給 relay 側事件 fan-out。

### Web Push 側通道（signed HTTP）

當 PWA 未連線（tab 關閉、背景）但 session 需要注意時，agent 透過 relay 的簽章 HTTP 路由觸發 Web Push 通知。

**鑰匙**（與既有 box keypair 並存）：
- **Agent Ed25519 signing keypair**（`config.signKeyPair`）— 簽 HTTP 請求的身份
- **Relay VAPID keypair** — 證明 relay 身份給 FCM/APNs／Mozilla autopush

**端點**：
| Route | 觸發者 | 用途 |
|---|---|---|
| `POST /push/{signPubKey}/register` | Agent | 新增一個 PushSubscription 到 relay store |
| `POST /push/{signPubKey}/unregister` | Agent | 移除一個 endpoint |
| `POST /push/{signPubKey}/notify` | Agent | 對該 agent 所有訂閱發送通知 |

**簽章協議**（`apps/relay/src/sigVerify.ts`）：
- Canonical body：`${action}|${signPubKey}|${ts}|${nonce}|${extra.join('|')}`
- Ed25519 self-signed（無 server-issued challenge）→ 避免 pending-channel DoS
- Replay 防護：`ts` 60s window + `nonce` 120s TTL cache；`NONCE_TTL_MS >= TS_WINDOW_MS` 為不變量

**資料流**：
```
PWA ──[browser subscribe()]──▶ FCM/APNs
 │  PushSubscription {endpoint, p256dh, auth}
 │
 │ [E2E WS: push:subscription-offer]
 ▼
Agent ──[POST /push/{signPubKey}/register, signed]──▶ Relay store（in-memory + JSON 快照）
Agent ──[POST /push/{signPubKey}/notify,   signed]──▶ Relay → web-push (VAPID+ECE) → FCM/APNs
```

**Agent 觸發條件**（`run.ts` 事件掛鉤）：
- `user-input-request`，且 `bus.subscriberCount('/sessions/:id/attention') === 0`（沒有 peer 在看這個 session）→ 通知
- `card-stream-end`，且 `bus.subscriberCount('/sessions/:id/attention') === 0`、未 interrupted、且 `hasPendingInputForSession` 為 false → 通知

兩種觸發產生同 `{title, body, sessionId, tag, agentId}` 結構；`tag: sessionId` 讓後續訊息在瀏覽器端自動摺疊成單一通知。

**為什麼是 `attention` 而不是 `cards`**：多裝置同帳號時，其他裝置的背景 tab 仍會保留 cards 訂閱，會把通知整個吃掉。`/sessions/:id/attention` 由 PWA 在 `document.visibilityState === 'visible' && document.hasFocus()` 時才訂閱，並監聽 `visibilitychange` / `focus` / `blur` / `pagehide` 即時斷訂；離開 session 頁面或關 tab 也會釋放。這樣 push gate 只反映「目前有沒有裝置正拿在手上看這個 session」，其他被後台化的裝置不會影響判斷。

**PWA 側**（`apps/pwa/src/lib/pushSubscription.ts` + `components/NotificationPrompt.tsx`）：
- Service Worker：`apps/pwa/src/sw.ts`（`injectManifest` 策略）處理 `push` 與 `notificationclick`
- 授權提示：首次連線後若 `Notification.permission === 'default'` 顯示 Banner
- 自動 offer：每次連線完成且權限已 `granted`，由 `App.tsx` 重送 `push:subscription-offer`（agent 的 register 是 upsert，等冪）

### PWA 群組同步（shared-mailbox sync）

PWA 之間的「machine 列表 / machine tombstones / apiKey / masterSecret」走 relay 的 signed sync mailbox，不走 WebRTC：

- 所有同一帳號的 PWA 派生同一把 `masterSecret`（放 IndexedDB）→ `deriveSharedKeys()` 產生共用 X25519 + Ed25519 keypair
- 單一 mailbox 位址 = `hash(shared_X25519_pubkey)`；所有 paired PWA 都讀寫同一個 mailbox
- Client (`apps/pwa/src/lib/syncClient.ts`) 每次 push 用 `SignedSyncEnvelope`（Ed25519 簽）給 relay；relay 用 per-mailbox mutex（10s TTL）serialize PUT，409 時 client 指數退避重試
- Payload 是 `SyncPayloadV3`（`apps/pwa/src/lib/syncMerge.ts`），欄位級 `Timestamped<T>` + LWW 合併

### Agent TOFU 信任錨 + Tombstone catch-up

Agent 不持 `masterSecret`，只 TOFU 釘一把 PWA 群組的共用 pubkey：

- `AgentPairState = 'unpaired' | 'paired' | 'closed'`
- **unpaired** → 第一次 signed handshake 把 peer 的 X25519 + Ed25519 pubkey 寫入 `~/.quicksave/config.json` 的 `peerPWAPublicKey` / `peerPWASignPublicKey`
- **paired** → 後續 handshake 必須用 pinned Ed25519 pubkey 簽章；不符即拒
- **closed**（runtime flag）→ 全拒入站 handshake；由 CLI `quicksave pair` 解鎖
- Tombstone 檢查走 catch-up GET：relay `'connected'` 事件觸發 `runTombstoneCheck`（`apps/agent/src/tombstoneCheck.ts`），驗章通過後清除 config 的 peer pubkey、emit `'tombstoned'`、設 closed flag

CLI：
- `quicksave status` → 印出 state / agentId / peers / peerPWA pubkey
- `quicksave pair` → 解鎖 closed + 顯示 QR/URL

詳細設計見 `docs/guidelines/sync-security.md`。

### Request-response 模式（MessageBus command）

```typescript
// PWA 端（useClaudeOperations.ts / useGitOperations.ts）
const result = await busRef.current.command<ResponseType, RequestPayload>(
  'claude:start',
  payload,
  { timeoutMs: 30_000, queueWhileDisconnected: true },
);
// bus 內部以 id 配對 cmd/result frame；錯誤會 reject 為 Error
```

Agent 端每個 verb 由 `service/run.ts` 註冊成 `bus.onCommand(verb, handler)`，adapter 會把 payload 包回 Message 信封 → `messageHandler.handleMessage` → 回 result frame。詳見前文「MessageBus Command adapter」。

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
| `agent:` | Daemon 管理（list-repos/add-repo/clone-repo/...） |
| `ai:` | AI 工具（generate-commit-summary/set-api-key/...） |
| `terminal:` | PTY 終端機（create/input/resize/rename/close） |
| `files:` | 唯讀檔案瀏覽器（list / read，純 request-response，無 bus subscription） |
| `ping`/`pong` | 心跳 |
| `handshake`/`handshake:ack` | 連線建立 |

### Claude 相關 Message Types

PWA↔Agent 的 session / cards / preferences 事件現在都走 MessageBus 的 `/path` 訂閱（見「MessageBus」章節）。下表的「Message type」欄是 `MessageHandler` 內部仍使用的 verb 名稱；對應的 bus 用法在「bus 對應」欄。

| Type | 方向 | bus 對應 | 說明 |
|---|---|---|---|
| — | Agent→PWA push | `bus.subscribe('/sessions/history')` | 歷史 sessions 全量 snapshot + 增量更新（取代已移除的 `claude:list-sessions` 命令，避免與 `/sessions/active` 競態） |
| `claude:start` | PWA→Agent | `bus.command('claude:start', …)` | 啟動新 session |
| `claude:resume` | PWA→Agent | `bus.command('claude:resume', …)` | 繼續 session |
| `claude:cancel` | PWA→Agent | `bus.command('claude:cancel', …)` | 取消 streaming |
| `claude:close` | PWA→Agent | `bus.command('claude:close', …)` | 只 kill 底層 CLI process；registry 不變（用於 Advanced > Terminate） |
| `claude:end-task` | PWA→Agent | `bus.command('claude:end-task', …)` | kill process **並** archive registry entry（End Task 按鈕） |
| `claude:get-cards` | PWA→Agent | `bus.command('claude:get-cards', …)` | 分頁讀取歷史 cards（offset>0） |
| `claude:user-input-response` | PWA→Agent | `bus.command('claude:user-input-response', …)` | 回應工具審批／permission |
| `claude:set-preferences` | PWA→Agent | `bus.command('claude:set-preferences', …)` | 全域偏好寫入（讀取走 `/preferences` sub） |
| `claude:set-session-permission` | PWA→Agent | `bus.command('claude:set-session-permission', …)` | 變更 session 權限模式 |
| — | Agent→PWA push | `bus.subscribe('/sessions/:id/cards')` → `{kind: 'card', event}` / `{kind: 'stream-end', result}` | 舊 `claude:card-event` / `claude:card-stream-end` / `claude:user-input-request` 都已改走此 path（CardBuilder 在 pendingInput overlay 內承載 input request） |
| — | Agent→PWA push | `bus.subscribe('/sessions/active')` | 替代已移除的 `claude:active-sessions` 命令與 `claude:session-updated` push |
| — | Agent→PWA push | `bus.subscribe('/preferences')` | 替代已移除的 `claude:get-preferences` 命令與 `claude:preferences-updated` push |
| — | Agent→PWA push | `bus.subscribe('/sessions/config')` | 全部 session 的 config dict（替代已移除的 `session:get-config` 命令；一次性讀取可用 `bus.getSnapshot('/sessions/config')`） |
| — | Agent→PWA push | `bus.subscribe('/repos/commit-summary')` | 全部 repo 的 AI commit summary state（替代已移除的 `ai:commit-summary:get` 命令） |
| `bus:frame` | 雙向 | — | MessageBus 封包信封：payload 為 `ClientFrame` / `ServerFrame`（sub / unsub / cmd / snap / upd / result / sub-error） |
| `push:subscription-offer` | PWA→Agent | 走舊 WS path（`connection.send`） | 多 agent routing 需要 `sendToAgent`，bus 為單 active agent |
| `push:subscription-offer:response` | Agent→PWA | 註冊結果 `{success, error?}` |

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

identityStore.ts
  publicKey: string | null             // base64 X25519 group pubkey（所有 PWA 相同）
  initialized: boolean
  // 所有 keypair 都由 `masterSecret` 派生；store 本身不存任何 keypair
  getSecretKey() / getSigningSecretKey() / getSigningPublicKey()
  rotateIdentity()  // 產生新 masterSecret → 回傳舊 signing keys 供 tombstone
  clearAll()        // 清除 masterSecret
```

詳細 threat model 與 key derivation 見 `docs/guidelines/sync-security.md`。

### Hook API（`useClaudeOperations.ts`）

```typescript
// Session 操作
startSession(prompt, opts?)
resumeSession(sessionId, prompt, cwd?)
cancelSession(sessionId)
closeSession(sessionId)

// 歷史（session 列表由 `/sessions/history` + `/sessions/active` bus 訂閱提供，
// 沒有對應的 command；一次性讀取用 `bus.getSnapshot('/sessions/history')`）
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
  ↓ bus.command('claude:start', payload, { queueWhileDisconnected: true })
  ↓ bus:frame { kind: 'cmd', verb: 'claude:start' } → [加密] → WebRTC → [解密]
  ↓ busServerTransport → bus.onCommand('claude:start') adapter
  ↓ adapter 包回 Message 信封 → MessageHandler.handle_claude_start()
  ↓ SessionManager.startSession()
    ↓ ClaudeCliProvider.startSession()
      ↓ spawn('claude', ['--input-format', 'stream-json', '--output-format', 'stream-json',
      ↓                    '--permission-prompt-tool', 'stdio', '--append-system-prompt', '...', ...])
      ↓ stdin.write({ type: 'user', message: { role: 'user', content: prompt } })
      ↓ return ProviderSession { sessionId, streamId, abort() }
    ↓ SessionManager 建立 card builder、permission table
    ↓ consumeStream() loop:
       for await (line of readline(proc.stdout))
         if control_request → handleControlRequest() → emit card → wait user → sendControlResponse()
         else → routeMessage() → StreamCardBuilder → CardEvent → emit('card-event')
  ↓ claudeService.on('card-event') → bus.publish('/sessions/:id/cards', { kind: 'card', event })
  ↓ bus:frame { kind: 'upd', path: '/sessions/.../cards' } → [加密] → WebRTC → [解密]
  ↓ MessageBusClient dispatch → applySessionCardsUpdate(sessionId, update)
  ↓ claudeStore.handleCardEvent() → React re-render → CardRenderer
  ↓ on 'result': turn complete, process stays alive for next stdin message
```

---

## 九、關鍵設計模式

| 模式 | 位置 | 用途 |
|---|---|---|
| EventEmitter | `SessionManager` | AI 事件廣播 |
| Strategy Pattern | `CodingAgentProvider` 介面 | 可插拔 AI provider 實作 |
| MessageBus (RPC + PubSub) | `packages/message-bus` + `busServerTransport` / `busClientTransport` | PWA↔Agent 的 command / subscribe / publish |
| Snapshot-on-subscribe | `bus.onSubscribe(path, { snapshot })` | 斷線重連自動重放當下 state，消除 stale window |
| Command adapter | `service/run.ts — LEGACY_BUS_VERBS` | 把每個 verb 包裝成 bus command，delegate 給既有 `messageHandler.handleMessage` |
| Zustand Store | `claudeStore.ts` / `gitStore.ts` | 集中式 PWA 狀態 |
| Singleton Lock | `singleton.ts` | 確保單一 daemon |
| JSONL Append | `sessionStore.ts` | Session 歷史持久化 |

---

## 十、參考文件

| 文件 | 說明 |
|---|---|
| `docs/references/claude-agent-sdk-message-types.md` | Claude CLI stream-json 事件型別參考 |
| `docs/plans/codex-integration-plan.md` | Codex 整合計劃書 |
| `docs/plans/ui-design-rules.md` | PWA UI 設計規則 |
