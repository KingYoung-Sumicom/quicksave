# Guidelines Index

Before designing or implementing any feature, check the relevant guidelines below.

---

## 系統架構

**`docs/references/quicksave-architecture.md`** — 完整系統架構文件。涵蓋：
- Monorepo 結構與各 app 職責
- Agent daemon 啟動序列、session 生命週期、事件系統
- E2E 加密通訊與 PubSub 機制
- WebSocket message protocol 與命名慣例
- PWA 狀態管理與元件層級
- 端對端資料流

**維護規則**：修改以下任一部分時，必須同步更新 `docs/references/quicksave-architecture.md`：
- 新增/移除 app 或 package
- 變更 WebSocket message type（`packages/shared/src/types.ts`）
- 變更 `MessageHandler` 路由邏輯
- 變更 `CLISessionRunner` session 生命週期或事件
- 變更 `AgentConnection` 加密或 PubSub 機制
- 變更 PWA store 狀態結構或 hook API
- 新增或移除 AI provider

---

## UI / UX Design

**`docs/plans/ui-design-rules.md`** — Rules derived from past fixes. Covers:
- Root container must use `overflow-hidden` (virtual keyboard layout)
- `interactive-widget=resizes-content` in viewport meta
- No vertical scrolling inside chat view elements (nested scroll breaks touch)
- Chat view components must not use `max-h-*` + `overflow-y-auto`
- No scrollbars anywhere inside the chat view — let content expand, let the messages list scroll
- All Enter-to-submit must guard IME composition (`!e.nativeEvent.isComposing`)

---

## 組件設計與重構

**`docs/plans/component-refactoring-guidelines.md`** — 可重用組件拆分目標與規則。涵蓋：
- 何時拆分（Rule of Three、300+ 行門檻）
- 檔案組織（`ui/`、`hooks/`、`chat/`）
- 高優先：Collapsible、Modal、useLongPress、loading 狀態元件
- 中優先：FormField、StatusBadge、IconButton、ToolViewHeader
- 大型組件拆分目標（ToolCallMessage、SettingsPanel、ClaudePanel、NavigationDrawer、FileList）

**維護規則**：完成任一拆分後，更新指南文件標記完成狀態與實際檔案路徑。

---

## Commit Messages

**`docs/guidelines/commits.md`** — Commit message format used by the AI commit summary generator. Covers:
- Default Conventional Commits format baked into the prompt
- How per-project overrides plug in (`.github/COMMIT_CONVENTION.md`, `CONTRIBUTING.md`, etc.)
- How `recentCommits` / `branchName` / `userContext` feed the prompt
- This repo's own scope vocabulary lives in `.github/COMMIT_CONVENTION.md`

**維護規則**：修改 `commitSummary.ts` / `commitSummaryCli.ts` 的 prompt、新增/變更 convention 檔案讀取路徑、或變動 attribution trailer 行為時，同步更新此文件。

---

## Testing

**`docs/guidelines/testing.md`** — Testing guidelines and procedures. Covers:
- Core principle: write tests alongside code, not as a separate batch
- Agent test structure, running, and mocking patterns
- Adversarial / edge-case testing for race conditions and reconnect bugs
- Continuous process refinement: evolve testing practices when bugs are found
- Coverage targets and priority modules

**維護規則**：發現新的 bug pattern 時，更新 testing guidelines 以記錄對應的測試策略。

---

## PWA ↔ PWA Sync Security

**`docs/guidelines/sync-security.md`** — 多台 PWA client 同步「設備 / 帳號設定」的安全設計。涵蓋：
- Threat model（單用戶、跨用戶共享 relay、`masterSecret` 外洩 = 完全失守）
- Identity model：所有 PWA 共用 `masterSecret`，X25519 / Ed25519 keypair 由它派生（無 per-PWA crypto identity、無白名單）
- 單槽 mailbox + read-modify-write + per-mailbox in-flight mutex + LWW 收斂
- `SignedSyncEnvelope` schema 與 relay 端 Ed25519 verify
- PWA pairing：A 同時出 QR + deep-link URL（`#k=<eA_pub>` fragment）+ 多槽 mailbox + B 顯示 6 碼 SAS（32 符號 alphabet）+ A 輸入過濾候選
- **Agent 信任模型**：TOFU 記一把 PWA pubkey、訂閱 `tombstone:*` pubsub、收到 tombstone 自動自毀並進入自閉模式、需 CLI `quicksave pair` 解鎖
- 退役（清 browser storage）vs. 群組 reset（tombstone + 換 `masterSecret` + agent 自動自毀）
- 與 Happy Coder 的差異（Quicksave 維持 stateless relay；agent 不持 `masterSecret`）

**維護規則**：修改 `packages/shared/src/crypto.ts` 的 sign/verify/encrypt/seed-keypair/SAS 派生、`apps/relay/src/syncStore.ts` 的 slot/mutex、`apps/relay/src/pairStore.ts` 的 `/pair-requests/*` 生命週期、`apps/pwa/src/lib/syncClient.ts` 或 `syncMerge.ts` 的 envelope schema、`apps/pwa/src/lib/pairClient.ts` 的 SAS pairing flow、`apps/agent/src/config.ts` 的 `peerPWA*` 欄位、`apps/agent/src/connection/connection.ts` 的 handshake 驗 pubkey 與自閉模式、或 group reset / tombstone pubsub 推送時，同步更新此文件。

---

## Sandbox Mode

**`docs/guidelines/sandbox-mode.md`** — Kernel-level sandbox that coding-agent sessions run under by default. Covers:
- `DEFAULT_SANDBOXED = true`, per-session override persisted on `SessionRegistryEntry`
- Filesystem write confinement to the project `cwd` + `SandboxBash` auto-approval
- Runtimes (`sandbox-exec` on macOS, `bwrap` on Linux) and the SBPL profile location
- When to turn sandbox OFF and the associated trade-offs
- Pointers to the default, the stdio MCP server, the provider wiring, and the PWA toggles

**維護規則**：變動 `DEFAULT_SANDBOXED`、支援的 sandbox backends、`SandboxBash` 工具名稱 / 參數 / auto-approval hook、SBPL profile 策略,或 PWA sandbox toggle 所在位置時,同步更新此文件。

---

## Session Settings Persistence

All user-facing session settings (e.g. `permissionMode`, `sandboxed`) **must** be persisted in `SessionRegistryEntry` so they survive daemon restarts.

**Rule**: When adding a new session setting:
1. Add the field to `SessionRegistryEntry` in `packages/shared/src/types.ts`
2. Persist it in `messageHandler.ts` when creating the registry entry (both `handleClaudeStart` and `handleClaudeResume`)
3. In `sessionManager.resumeSession`, fall back to the registry value when the in-memory map is empty
4. In `sessionManager.setSessionConfig`, persist changes via `persistRegistryField`

**Why**: In-memory maps (`sessionPermissions`, `sessionSandboxed`, `sessionConfigs`) are cleared on daemon restart. Without registry persistence, resumed sessions lose their settings.

---
