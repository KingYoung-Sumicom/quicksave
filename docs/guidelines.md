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
- Threat model（單用戶、跨用戶共享 relay、外部攻擊者已知 mailbox key）
- 五層防線（sender 簽章 + paired-devices 白名單 / per-IP rate-limit / 單槽 mailbox + per-key in-flight mutex / signed cancel / pairing code）
- `SignedSyncPayload V4` schema 與收件端驗章流程
- Pairing code bootstrap 流程（OOB、5 分鐘有效、一次性）
- 對應的 file map（`syncStore.ts`、`syncClient.ts`、`identityStore.ts` 等）

**維護規則**：修改 `packages/shared/src/crypto.ts` 的 sign/verify/encrypt、`apps/relay/src/syncStore.ts` 的 slot/mutex、`apps/pwa/src/lib/syncClient.ts` 或 `syncMerge.ts` 的 payload schema、`identityStore.ts` 的 `PairedDevice` 結構、或 pairing / revocation 流程時，同步更新此文件。

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
