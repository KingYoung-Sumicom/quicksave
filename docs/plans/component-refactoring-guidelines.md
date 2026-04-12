# Component Refactoring Guidelines

可重用組件拆分目標與規則。每條規則附 **Why** 說明，方便判斷邊界情況。

---

## 通用規則

### 何時拆分組件

遵循 **Rule of Three**：同一 UI pattern 出現在 3+ 個檔案時，應抽取為共用組件。組件超過 ~300 行且有明確的子職責時，也應拆分。

**Why:** 重複 2 次可以容忍，3 次代表這是穩定的 pattern，值得抽象。過早抽象（只出現 1-2 次）會增加不必要的間接層。

### 優先級判斷：改動擴散度

拆分的優先級不看「省了多少行」，而看**改動擴散度**：當這個 pattern 需要修改時，有多少個檔案需要同步改動。

**Why:** 在 AI 輔助開發中，每一處改動都是一次 edit tool call，消耗 token。一個散佈在 8 個檔案的 pattern 改一次就要 8 次 edit；抽取後只需改 1 個檔案。擴散度直接決定維護成本和 token 消耗速度。

**判斷方式：** 數「受影響檔案」數量，而非計算省下的行數。下表列出各拆分目標的擴散度：

| 拆分目標 | 擴散度（檔案數） | 改動頻率 |
|----------|-----------------|----------|
| Collapsible | 8 | 中（樣式、動畫調整） |
| Modal | 7 | 中（z-index、backdrop、關閉行為） |
| Loading/Error/Empty | 10+ | 低（但一改就要改全部） |
| ToolViewHeader | 8 | 高（新增 tool view 時必觸及） |
| FormField | 6 | 低 |
| StatusBadge | 5 | 中 |
| IconButton | 15+ | 低（樣式穩定後很少改） |
| useLongPress | 3 | 低（但行為不一致是 bug 來源） |

### 檔案組織

- 通用 UI 元件放 `components/ui/`（已有 `ActionButtons.tsx`、`ButtonGroup.tsx`、`ToggleSwitch.tsx`）
- Custom hooks 放 `hooks/`（已有 `useEdgeSwipe`、`useMediaQuery` 等）
- Chat 專用的可重用元件留在 `components/chat/` 或 `components/chat/toolViews/`
- Settings 各 section 放 `components/settings/`（已有 `ClaudeSettingsSection.tsx`）

**Why:** 遵循現有的目錄慣例，降低認知負擔。通用元件與業務元件分離，方便跨功能區重用。

### 命名慣例

- UI 元件用描述性名詞：`Modal`、`Collapsible`、`FormField`
- Hooks 用 `use` 前綴：`useLongPress`、`useExpandable`
- Props interface 用 `ComponentNameProps`：`ModalProps`、`CollapsibleProps`

---

## 高優先拆分目標

### 1. ~~Collapsible 展開/收合元件~~ → ChevronIcon [已完成]

> **實際拆分：** 各組件的展開/收合 UI 差異太大（preview text / line count / "Show more"），不適合做完整 Collapsible 元件。改為抽取 `ChevronIcon` 統一 SVG 部分。
> **檔案：** `components/ui/ChevronIcon.tsx`
> **已替換 9 個檔案** 中的 chevron SVG（ThinkingMessage, SubagentBlockMessage, ToolResultMessage, ToolCallMessage, EditToolView, MachineCard×2, AgentDashboard, PathBrowser）

**Pattern:** 8+ 組件重複相同的 expand/collapse 邏輯：`useState(false)` 控制展開、點擊切換、chevron SVG 旋轉 90 度。

**受影響檔案：**
- `chat/ThinkingMessage.tsx` — 展開 thinking 預覽
- `chat/SubagentBlockMessage.tsx` — 展開 subagent 描述
- `chat/ToolResultMessage.tsx` — `CollapsibleResult` 子組件
- `chat/UserMessage.tsx` — `PlainUserMessage` 收合
- `chat/toolViews/EditToolView.tsx` — 展開/收合 diff
- `chat/ToolCallMessage.tsx` — chevron button 展開結果
- `DiffViewer.tsx` — diff 展開
- `FileList.tsx` — 檔案樹展開

**重複的 chevron SVG（所有檔案完全相同）：**
```tsx
<svg className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
</svg>
```

**目標：** 建立 `components/ui/Collapsible.tsx`，提供：
- `expanded` / `onToggle` props（controlled），或內部 state（uncontrolled）
- `CollapsibleTrigger` — 渲染 chevron + children
- `CollapsibleContent` — 條件渲染 children

**Why:** 擴散度 8 — 修改 chevron 樣式或展開行為時需同步改 8 個檔案。抽取後只改 `Collapsible.tsx` 一處。

---

### 2. Modal 對話框外殼 [已完成]

> **檔案：** `components/ui/Modal.tsx`
> **已替換：** AddMachineModal, EditMachineModal, WildcardEditorModal（3 個檔案）
> **待替換：** GitignoreEditor, SettingsPanel 確認框, DevicePairingSection 確認框, MachineCard 刪除確認（結構略有差異，需個別調整）

**Pattern:** 5+ 組件重複相同的 modal 結構：`fixed inset-0 z-50` 定位、`bg-black/60` 背景遮罩、`bg-slate-800 rounded-lg` 內容區、標題 + 關閉 X 按鈕。

**受影響檔案：**
- `AddMachineModal.tsx` — 新增機器
- `EditMachineModal.tsx` — 編輯機器
- `chat/WildcardEditorModal.tsx` — wildcard 編輯
- `GitignoreEditor.tsx` — gitignore 編輯
- `SettingsPanel.tsx` — 確認對話框
- `DevicePairingSection.tsx` — 確認對話框
- `MachineCard.tsx` — 刪除確認

**重複的關閉按鈕 SVG（所有 modal 完全相同）：**
```tsx
<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
</svg>
```

**目標：** 建立 `components/ui/Modal.tsx`，props：
- `title: string`
- `onClose: () => void`
- `children: ReactNode`
- `maxWidth?: string`（預設 `max-w-md`）

**Why:** 擴散度 7 — 調整 z-index、backdrop 透明度或關閉行為時需改 7 個檔案。目前已有 `z-50` vs `z-[60]` 不一致的問題，正是因為缺乏單一來源。

---

### 3. useLongPress hook [已完成]

> **檔案：** `hooks/useLongPress.ts`
> **已替換：** PermissionPrompt, ToolCallMessage (InlinePermissionActions), MachineCard（3 個檔案）
> **附帶修復：** MachineCard 原本缺少 `didLongPress` guard，統一 hook 後行為一致；新增 `onTouchMove` 取消避免拖動誤觸

**Pattern:** 3 組件重複完全相同的 timer-based long-press 邏輯：`useRef<ReturnType<typeof setTimeout>>`、`setTimeout(callback, 500)`、mouse/touch end 時清理。

---

### 4. Loading / Error / Empty 狀態元件 [部分完成]

> **已完成：**
> - `components/ui/Spinner.tsx` — 替換 13 個檔案中的 border spinner（FileList, MachineCard, GitignoreEditor, FloatingActionButton, CommitForm, Settings, AgentSettingsDrawer×2, DevicePairingSection, SettingsPanel×3, PathBrowser×2, QRScanner, ClaudePanel）
> - `components/ui/ErrorBox.tsx` — 替換 8 個檔案中的 error box（CommitForm, RepoView, AddMachineModal, ConnectionSetup×2, DevicePairingSection×2, SettingsPanel×2, Settings）
> **未替換：** SVG spinner（CommitForm, ClaudePanel）和 bouncing dots 為不同 pattern，保留原樣

**Pattern:** 10+ 組件以不同方式重複 loading spinner、error box、empty state。目前有 4+ 種不同的 spinner 樣式。

**Loading spinner 變體：**
- SVG spinner：`CommitForm.tsx`
- Border spinner：`DevicePairingSection.tsx`
- Bouncing dots：`ClaudePanel.tsx`、`AddMachineModal.tsx`
- CSS loading dots：`CommitForm.tsx`

**Error box pattern（重複樣式）：**
```tsx
<div className="p-3 bg-red-500/20 border border-red-500/50 rounded-md">
  <p className="text-sm text-red-400">{error}</p>
</div>
```

**目標：** 在 `components/ui/` 建立：
- `Spinner.tsx` — 統一 spinner 元件，支援 `size` prop
- `ErrorBox.tsx` — 統一 error 訊息容器
- `EmptyState.tsx` — 通用 empty state（icon + 標題 + 描述 + 可選 action）

**Why:** 擴散度 10+ — 改 spinner 動畫或 error 樣式時需觸及 10+ 個檔案。目前 4 種不同 spinner 也代表統一時的改動量極大。

---

## 中優先拆分目標

### 5. ToolViewHeader 工具視圖標題

**Pattern:** 8 個 tool view 重複相同的 header label 結構：工具名稱（帶顏色）+ 主要值（mono 字體）+ 可選次要資訊。

**受影響檔案：** `ReadToolView`、`WriteToolView`、`EditToolView`、`BashToolView`、`GlobToolView`、`GrepToolView` 等。

**重複結構：**
```tsx
<div className="flex items-center gap-1.5 min-w-0">
  <span className="text-[color]-400 shrink-0">{toolName}</span>
  <span className="text-blue-400 font-mono truncate">{primaryValue}</span>
  <span className="text-slate-500 shrink-0">{secondaryInfo}</span>
</div>
```

**目標：** 建立 `components/chat/toolViews/ToolViewHeader.tsx`。

---

### 6. FormField 表單欄位

**Pattern:** 6+ 組件重複相同的 label + input 樣式。

**受影響檔案：** `AddMachineModal.tsx`、`EditMachineModal.tsx`、`GitignoreEditor.tsx`、`chat/PermissionPrompt.tsx`。

**重複樣式：**
```tsx
<label className="block text-sm font-medium text-slate-300 mb-1">{label}</label>
<input className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
```

**目標：** 建立 `components/ui/FormField.tsx`。

---

### 7. StatusBadge 泛化

**Pattern:** `SessionStatusBadge.tsx` 已存在但範圍有限。6+ 組件使用類似的 dot + text badge pattern。

**受影響檔案：** `SessionStatusBadge.tsx`、`chat/SubagentBlockMessage.tsx`、`ConnectingOverlay.tsx`、`AgentStatusBar.tsx`、`BaseStatusBar.tsx`。

**目標：** 泛化 `SessionStatusBadge` 或建立通用 `StatusBadge` 元件，支援自訂 dot 顏色、pulse 動畫、label。

---

### 8. IconButton 圖標按鈕

**Pattern:** 15+ 組件重複相同的 hover button 樣式：`p-1.5 rounded-md hover:bg-slate-700 text-slate-400`。

**目標：** 建立 `components/ui/IconButton.tsx`，支援 `size`、`variant` props。

---

## 大型組件拆分

以下組件超過 400 行，應拆分為更小的子組件：

| 組件 | 行數 | 拆分建議 |
|------|------|----------|
| `chat/ToolCallMessage.tsx` | 606 | 抽出 `InlinePermissionActions` 到獨立檔案 |
| `SettingsPanel.tsx` | 593 | 各 section 拆到 `components/settings/` |
| `ClaudePanel.tsx` | 527 | 抽出 `ChatInputBar` 元件 |
| `NavigationDrawer.tsx` | 456 | 抽出 `MachineSwitcher`、`SessionList` |
| `FileList.tsx` | 444 | 抽出 `FileTreeNode`、`FileDiffRow` |

---

## 維護規則

完成任一拆分後，更新本文件：
- 在對應項目標記 **[已完成]** 並記錄實際檔案路徑
- 移除已不存在的受影響檔案引用
- 如發現新的重複 pattern，新增到對應優先級區段
