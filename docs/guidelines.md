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
- 變更 `ClaudeCodeService` session 生命週期或事件
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
