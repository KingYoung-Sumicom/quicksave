# Component Refactoring Guidelines

Goals and rules for splitting reusable components. Each rule includes a **Why** explanation to help with edge cases.

---

## General rules

### When to split a component

Follow the **Rule of Three**: when the same UI pattern appears in 3+ files, extract it into a shared component. A component that exceeds ~300 lines and has clearly separable sub-responsibilities should also be split.

**Why:** Two duplicates are tolerable; three duplicates indicate a stable pattern worth abstracting. Premature abstraction (only 1–2 occurrences) adds unnecessary indirection.

### Priority criterion: change blast radius

Split priority is not measured by "how many lines were saved" but by **change blast radius**: how many files need to be edited together when the pattern changes.

**Why:** In AI-assisted development, every edit is one edit-tool call and burns tokens. A pattern scattered across 8 files takes 8 edits per change; once extracted, only 1 file changes. Blast radius directly drives maintenance cost and token consumption.

**How to judge:** Count "affected files" rather than the lines saved. The table below lists the blast radius for each split target:

| Split target | Blast radius (file count) | Change frequency |
|----------|-----------------|----------|
| Collapsible | 8 | Medium (style, animation tweaks) |
| Modal | 7 | Medium (z-index, backdrop, close behavior) |
| Loading/Error/Empty | 10+ | Low (but a single change touches them all) |
| ToolViewHeader | 8 | High (touched whenever a new tool view is added) |
| FormField | 6 | Low |
| StatusBadge | 5 | Medium |
| IconButton | 15+ | Low (rarely changes once styling stabilizes) |
| useLongPress | 3 | Low (but inconsistent behavior is a bug source) |

### File organization

- Generic UI components go under `components/ui/` (already includes `ActionButtons.tsx`, `ButtonGroup.tsx`, `ChevronIcon.tsx`, `ConfirmModal.tsx`, `ErrorBox.tsx`, `Modal.tsx`, `Spinner.tsx`, `ToggleSwitch.tsx`)
- Custom hooks go under `hooks/` (already includes `useEdgeSwipe`, `useMediaQuery`, `useLongPress`, etc.)
- Chat-specific reusable components stay under `components/chat/` or `components/chat/toolViews/`
- Settings sections go under `components/settings/` (already includes `ApiKeySection`, `ClaudeSettingsSection`, `ControlRequestPalette`, `DangerZoneSection`, `LanguageSection`, `MachinesSection`, `NotificationSection`, `PrimaryKeySection`)

**Why:** Following the existing directory conventions reduces cognitive load. Separating generic UI components from business components makes cross-feature reuse easier.

### Naming conventions

- UI components use descriptive nouns: `Modal`, `Collapsible`, `FormField`
- Hooks use the `use` prefix: `useLongPress`, `useExpandable`
- Props interfaces use `ComponentNameProps`: `ModalProps`, `CollapsibleProps`

---

## High-priority split targets

### 1. ~~Collapsible expand/collapse component~~ → ChevronIcon [done]

> **Actual split:** Each component's expand/collapse UI varied too much (preview text / line count / "Show more") to fit a single full Collapsible component. Instead, we extracted `ChevronIcon` to unify just the SVG portion.
> **File:** `components/ui/ChevronIcon.tsx`
> **Replaced in 8 consumer files** for chevron SVGs (ThinkingMessage, SubagentBlockMessage, ToolResultMessage, ToolCallMessage, EditToolView, MachineCard, AddNewPage, PathBrowser)

**Pattern:** 8+ components repeat the same expand/collapse logic: `useState(false)` to control expansion, click toggles state, chevron SVG rotates 90 degrees.

**Affected files:**
- `chat/ThinkingMessage.tsx` — expand thinking preview
- `chat/SubagentBlockMessage.tsx` — expand subagent description
- `chat/ToolResultMessage.tsx` — `CollapsibleResult` subcomponent
- `chat/toolViews/EditToolView.tsx` — expand/collapse diff
- `chat/ToolCallMessage.tsx` — chevron button expands result
- `MachineCard.tsx` — machine row expansion
- `AddNewPage.tsx` — section expansion
- `PathBrowser.tsx` — directory expansion

**Duplicated chevron SVG (identical across all files):**
```tsx
<svg className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
</svg>
```

**Goal:** Build `components/ui/Collapsible.tsx` providing:
- `expanded` / `onToggle` props (controlled), or internal state (uncontrolled)
- `CollapsibleTrigger` — renders chevron + children
- `CollapsibleContent` — conditionally renders children

**Why:** Blast radius 8 — modifying chevron styling or expansion behavior requires touching 8 files. Once extracted, only `Collapsible.tsx` needs to change.

---

### 2. Modal dialog shell [done]

> **File:** `components/ui/Modal.tsx`
> **Replaced (9 consumers):** AddMachineModal, EditMachineModal, AddNewPage, AgentSettingsDrawer, GitIdentityModal, PairDeviceModal, ScanToJoinModal, chat/CodexLogin, chat/WildcardEditorModal
> **Companion:** A separate `components/ui/ConfirmModal.tsx` was added for confirm/destructive dialogs and is used by MachineInfoPage, ProjectDetail, CommitForm, DevicePairingSection, settings/MachinesSection, settings/PrimaryKeySection, and chat/PermissionPrompt. SettingsPanel and the standalone GitignoreEditor confirm dialog no longer exist (settings migrated to route-based pages — see commit `144fdb9`).

**Pattern:** 5+ components repeat the same modal structure: `fixed inset-0 z-50` positioning, `bg-black/60` backdrop, `bg-slate-800 rounded-lg` content area, title + close (X) button.

**Affected files:**
- `AddMachineModal.tsx` — add machine
- `EditMachineModal.tsx` — edit machine
- `chat/WildcardEditorModal.tsx` — wildcard editor
- `GitignoreEditor.tsx` — gitignore editor (still uses an inline modal shell; not yet migrated to `Modal`)
- `DevicePairingSection.tsx` — uses `ConfirmModal`
- `MachineCard.tsx` — delete confirm now goes through `ConfirmModal` consumers

**Duplicated close-button SVG (identical across all modals):**
```tsx
<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
</svg>
```

**Goal:** Build `components/ui/Modal.tsx` with props:
- `title: string`
- `onClose: () => void`
- `children: ReactNode`
- `maxWidth?: string` (default `max-w-md`)

**Why:** Blast radius 7 — adjusting z-index, backdrop opacity, or close behavior requires editing 7 files. The current inconsistency between `z-50` and `z-[60]` exists precisely because there is no single source of truth.

---

### 3. useLongPress hook [done]

> **File:** `hooks/useLongPress.ts`
> **Replaced:** PermissionPrompt, ToolCallMessage (InlinePermissionActions), MachineCard (3 files)
> **Bonus fix:** MachineCard previously lacked the `didLongPress` guard; consolidating into a single hook unified the behavior. Also added `onTouchMove` cancellation to avoid accidental triggers during drag.

**Pattern:** 3 components repeat the exact same timer-based long-press logic: `useRef<ReturnType<typeof setTimeout>>`, `setTimeout(callback, 500)`, cleanup on mouse/touch end.

---

### 4. Loading / Error / Empty state components [partially done]

> **Done:**
> - `components/ui/Spinner.tsx` — currently imported by 24 consumer files across the app (App, routes/JoinGroupPage, MachineInfoPage, ProjectDetail, GitIdentityModal, CommitForm, GitignoreEditor, QRScanner, FloatingActionButton, ScanToJoinModal, MachineCard, ArchivedSessionsList, chat/CodexLogin, Settings, PairDeviceModal, PathBrowser, FileList, AddNewPage, files/FileBrowserPage, files/FilePreviewModal, files/MarkdownPreview, terminal/TerminalListSection, settings/ApiKeySection, settings/NotificationSection). Original `SettingsPanel` consumers migrated into the new `components/settings/*` files when settings became route-based pages.
> - `components/ui/ErrorBox.tsx` — currently imported by 14 consumers (CommitForm, RepoView, AddMachineModal, ConnectionSetup, DevicePairingSection, Settings, settings/NotificationSection, settings/ApiKeySection, settings/PrimaryKeySection, ScanToJoinModal, PairDeviceModal, GitIdentityModal, AddNewPage, routes/JoinGroupPage).
> **Not replaced:** SVG spinner (CommitForm, ClaudePanel) and bouncing dots are different patterns and were left as-is.

**Pattern:** 10+ components repeat loading spinners, error boxes, and empty states in different ways. There are currently 4+ different spinner styles.

**Loading spinner variants:**
- SVG spinner: `CommitForm.tsx`
- Border spinner: `DevicePairingSection.tsx`
- Bouncing dots: `ClaudePanel.tsx`, `AddMachineModal.tsx`
- CSS loading dots: `CommitForm.tsx`

**Error box pattern (duplicated styling):**
```tsx
<div className="p-3 bg-red-500/20 border border-red-500/50 rounded-md">
  <p className="text-sm text-red-400">{error}</p>
</div>
```

**Goal:** Under `components/ui/`, create:
- `Spinner.tsx` — unified spinner component, supports a `size` prop
- `ErrorBox.tsx` — unified error message container
- `EmptyState.tsx` — generic empty state (icon + title + description + optional action)

**Why:** Blast radius 10+ — changing the spinner animation or error styling touches 10+ files. The four different spinners today also imply a large change footprint when unifying them.

---

## Medium-priority split targets

### 5. ToolViewHeader

**Pattern:** 8 tool views repeat the same header label structure: tool name (colored) + primary value (mono font) + optional secondary info.

**Affected files:** `ReadToolView`, `WriteToolView`, `EditToolView`, `BashToolView`, `GlobToolView`, `GrepToolView`, etc.

**Duplicated structure:**
```tsx
<div className="flex items-center gap-1.5 min-w-0">
  <span className="text-[color]-400 shrink-0">{toolName}</span>
  <span className="text-blue-400 font-mono truncate">{primaryValue}</span>
  <span className="text-slate-500 shrink-0">{secondaryInfo}</span>
</div>
```

**Goal:** Build `components/chat/toolViews/ToolViewHeader.tsx`.

---

### 6. FormField

**Pattern:** 6+ components repeat the same label + input styling.

**Affected files:** `AddMachineModal.tsx`, `EditMachineModal.tsx`, `GitignoreEditor.tsx`, `chat/PermissionPrompt.tsx`.

**Duplicated styling:**
```tsx
<label className="block text-sm font-medium text-slate-300 mb-1">{label}</label>
<input className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
```

**Goal:** Build `components/ui/FormField.tsx`.

---

### 7. Generalize StatusBadge

**Pattern:** `SessionStatusBadge.tsx` already exists but its scope is limited. Several components use a similar dot + text badge pattern.

**Affected files:** `SessionStatusBadge.tsx`, `chat/SubagentBlockMessage.tsx`, `ConnectingOverlay.tsx`, `BaseStatusBar.tsx`, `chat/SessionStatusBar.tsx`. (Note: the previously listed `AgentStatusBar.tsx` no longer exists.)

**Goal:** Generalize `SessionStatusBadge` or build a generic `StatusBadge` component supporting custom dot color, pulse animation, and label.

---

### 8. IconButton

**Pattern:** 15+ components repeat the same hover button styling: `p-1.5 rounded-md hover:bg-slate-700 text-slate-400`.

**Goal:** Build `components/ui/IconButton.tsx` supporting `size` and `variant` props.

---

## Splitting large components

The following components exceed 400 lines and should be broken into smaller subcomponents:

| Component | Lines | Splitting suggestion | Status |
|------|------|----------|--------|
| `chat/ToolCallMessage.tsx` | 178 | Extract `InlinePermissionActions` into its own file | [done] — extracted to `chat/InlinePermissionActions.tsx`; ToolCallMessage trimmed from 606 → 178 lines |
| `SettingsPanel.tsx` | — | Split each section into `components/settings/` | [done] — file removed; settings now live as route-based pages (`SettingsPage.tsx` at 136 lines) plus `components/settings/*` sections |
| `ClaudePanel.tsx` | 638 | Extract a `ChatInputBar` component | Pending — file has grown rather than shrunk |
| `NavigationDrawer.tsx` | — | Extract `MachineSwitcher` and `SessionList` | [done] — file removed (route-based migration); `chat/SessionList.tsx` now exists at 66 lines |
| `FileList.tsx` | 370 | Extract `FileTreeNode` and `FileDiffRow` | Partial — under the 400-line threshold but still a split candidate |

---

## Maintenance rules

After completing any split, update this document:
- Mark the corresponding entry as **[done]** and record the actual file path
- Remove references to affected files that no longer exist
- If you discover a new duplicated pattern, add it to the appropriate priority section
