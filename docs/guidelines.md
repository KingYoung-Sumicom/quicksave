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

## Testing

**`docs/guidelines/testing.md`** — Testing guidelines and procedures. Covers:
- Core principle: write tests alongside code, not as a separate batch
- Agent test structure, running, and mocking patterns
- Adversarial / edge-case testing for race conditions and reconnect bugs
- Continuous process refinement: evolve testing practices when bugs are found
- Coverage targets and priority modules

**維護規則**：發現新的 bug pattern 時，更新 testing guidelines 以記錄對應的測試策略。

---
