# 四套 Coding Agent 整合計劃

## 一、現狀分析

### PWA 端

| 模塊 | 當前狀況 | 問題 |
|------|----------|------|
| `claudeStore.ts` | 已有 `AgentPrefsMap` 結構，鍵是 `AgentId`，預設支援 `claude-code` / `codex` / `opencode` / `pi` | 但只有 claude-code 和 codex 的預設值有意義，opencode/pi 的 prefs 用通用的 fallback |
| `useSessionConfig.ts` | merge defaults + session config | 僅處理 `claude-code` 和 `codex` 兩種 agent ID 的 normalize |
| `claudePresets.ts` | `AGENT_TYPES` 只有 2 筆；`getModelsForAgent` / `getPermissionModesForAgent` / `getReasoningEffortsForAgent` 只認 claude-code 和 codex | opencode/pi 掉進去預設分支拿不到正確值 |
| `SessionStatusBar.tsx` | hardcode `AGENT_LABEL` 只有 claude-code 和 codex；`agentId` 強轉成 `'claude-code' | 'codex'` | 換到 opencode 會顯示 "Claude" 並且 dropdown 行為錯誤 |
| `ClaudeSettingsSection.tsx` | `isClaudeAgent` / `isCodexAgent` 做 branching | 無法擴展到第四個 agent |
| `AgentSettingsDrawer.tsx` | `isClaudeCode` 決定是否顯示 Control Request Palette | 其他 agent 看不到相關 UI |

### Agent (daemon) 端

| Agent | 狀態 | 需要 PWA 知道的 metadata |
|-------|------|--------------------------|
| `claude-code` | ✅ 完整 | model list（動態從 OpenAI /v1/models）、reasoning efforts、permission modes、context windows |
| `codex` | ✅ 完整 | model list（動態）、reasoning efforts、permission presets（含 sandbox 綁定） |
| `pi` | ✅ 已實作 provider | 需要定義：有哪些 tool groups、permission mode 映射、是否支援 thinking/reasoning |
| `opencode` | ❌ 未實作 provider | 需要先決定是否要接；如果要接，需先實作 `CodingAgentProvider` |

### 通訊協定（Handshake）

`HandshakeAckPayload` 目前包含：
- `preferences?: ClaudePreferences` — 只有 claude-code 的 model + reasoningEffort + contextWindow
- `codexModels?: CodexModelInfo[]` — 只有 codex 的動態 model list
- `platform?`, `agentVersion?`, `devBuild?` 等基礎資訊

**缺失**：沒有 mechanism 讓 PWA 知道這個 agent daemon 上裝了哪幾個 provider、哪些有 valid credential。

---

## 二、設計目標

1. **Provider Probing**：PWA 連線時（handshake:ack 階段或之後）自動發現 agent 上可用的 providers 及其 credential 狀態
2. **Settings Decoupling**：每個 agent 的設定（model, permission, effort 等）只在自己的 profile 裡定義，不散落在 UI 元件中
3. **Dynamic Tags**：SessionStatusBar 的 chips/tags 根據當前 agent 的 capability profile 動態渲染，而非 hardcode

---

## 三、Implementation Plan

### Phase 0: 基礎設施 — Provider Probe Protocol

#### 3.0.1 Shared types 擴充

**File**: `packages/shared/src/types.ts`

新增兩個 message types 和 payload：

```typescript
// PWA → Agent: ask "what providers are available?"
// Can be sent via bus command or inline during handshake
export interface AgentProbeRequestPayload {
  /** optional filter — if absent, return all providers */
  filter?: string[]; // e.g. ['claude-code', 'codex']
}

export interface AgentProbeResponsePayload {
  providers: AgentProviderInfo[];
}

export interface AgentProviderInfo {
  /** The agentId, e.g. 'claude-code', 'codex', 'pi', 'opencode' */
  id: string;
  /** Human-readable label */
  label: string;
  /** Whether the backend binary/SDK is installed */
  installed: boolean;
  /** Whether valid credentials are configured (API key, OAuth token, etc.) */
  hasCredentials: boolean;
  /** Capability flags — which settings/behaviors this agent supports */
  capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  /** Supports model selection */
  supportsModelSelection: boolean;
  /** Supports permission mode selection */
  supportsPermissionMode: boolean;
  /** Supports reasoning/thinking effort selection */
  supportsReasoningEffort: boolean;
  /** Supports context window configuration */
  supportsContextWindow: boolean;
  /** Supports sandbox toggle */
  supportsSandbox: boolean;
  /** Tool groups/categories available (for status bar badges) */
  toolGroups?: string[];
}
```

#### 3.0.2 HandshakeAckPayload 擴充

在同一 payload 裡面加上 provider probe 結果，避免額外的 round-trip：

```typescript
// Extend HandshakeAckPayload
export interface HandshakeAckPayload {
  // ... existing fields ...
  
  /** Auto-probed provider availability (sent once on handshake) */
  availableProviders?: AgentProviderInfo[];
}
```

#### 3.0.3 Agent daemon: 實作 probe handler

**File**: `apps/agent/src/handlers/messageHandler.ts` (or a new file)

在 SessionManager 或 message handler 加上 `agent:probe` 命令的處理：

```typescript
// Probe all registered providers and return their status
function probeProviders(filter?: string[]): AgentProviderInfo[] {
  const registered = sessionManager.getRegisteredProviders();
  return registered.map(p => ({
    id: p.agentId,
    label: p.label,
    installed: checkBinaryInstalled(p.binaryPath),
    hasCredentials: checkCredentials(p.id),
    capabilities: p.capabilities,
  }));
}
```

各 provider 需要暴露：
- `agentId` — already exists
- `label` — new getter
- `binaryPath` / SDK path — for `installed` check
- `hasCredentials` — API key check / CLI login state
- `capabilities` — static map per provider

**credential check 邏輯**：
| Agent | 檢查方式 |
|-------|----------|
| claude-code | `ANTHROPIC_API_KEY` env var 存在且非空 |
| codex | `~/.codex/` 目錄存在 + OAuth token 存在 |
| pi | `~/.pi/` 配置存在（或 API key env var） |
| opencode | `opencode` binary 存在 + config file |

#### 3.0.4 PWA: handshake 時接收並 store provider info

**File**: `apps/pwa/src/stores/connectionStore.ts`

在 `agentConnections` 裡面新增 `availableProviders` 欄位，或在 handshake 回應裡直接帶入。

### Phase 1: Agent Profile System — Decouple Settings Logic

這是核心重構。目標是把所有 agent-specific 的設定邏輯集中到 profile 定義裡。

#### 1.1 定義 AgentProfile

**File**: `apps/pwa/src/lib/agentProfiles.ts` (new)

```typescript
import type { AgentId, CodexModelInfo } from '@sumicom/quicksave-shared';
import type { AgentCapabilities } from '@sumicom/quicksave-shared';

export interface AgentProfile {
  /** Unique agent ID */
  id: AgentId;
  /** Display label for chips/tags */
  label: string;
  /** Description for the agent selector */
  description: string;
  /** Default model to use when no model is selected */
  defaultModel: string;
  /** Default permission mode */
  defaultPermissionMode: string;
  /** Default reasoning effort */
  defaultReasoningEffort?: string;
  /** Supported models for this agent */
  models: Array<{ value: string; label: string }>;
  /** Dynamic model fetcher (returns Promise) — for agents with
   *  server-discovered model lists (codex has this via daemon) */
  dynamicModels?: (params: { codexModels?: CodexModelInfo[] }) => Promise<Array<{ value: string; label: string }>>;
  /** Permission modes available for this agent */
  permissionModes: Array<{ value: string; label: string; description?: string }>;
  /** Reasoning effort options — only if this agent supports it */
  reasoningEfforts?: Array<{ value: string; label: string }>;
  /** Context window options — only if this agent supports it */
  contextWindows?: Array<{ value: number; label: string }>;
  /** Capability flags (mirrors AgentCapabilities from shared) */
  capabilities: AgentCapabilities;
  /** Which UI components/features are relevant for this agent
   *  (e.g. claude-code supports 'controlPalette', codex does not) */
  features?: string[];
  /** Status bar chips to show by default (overridden by runtime state) */
  defaultStatusChips?: Array<{
    type: 'agent' | 'model' | 'permission' | 'effort' | 'contextWindow' | 'sandbox' | 'custom';
    label: string;
    /** For custom chips: a function that computes the display value from session config */
    computeValue?: (config: Record<string, ConfigValue>) => string | null;
  }>;
}
```

#### 1.2 實作四大 agent 的 profile

**claude-code profile**:
- models: `CLAUDE_MODELS` (hardcoded)
- permissionModes: `PERMISSION_MODES`
- reasoningEfforts: `REASONING_EFFORTS_CLAUDE`
- contextWindows: `CLAUDE_CONTEXT_WINDOWS`
- features: ['controlPalette', 'git', 'sandbox']
- defaultStatusChips: ['agent', 'model', 'contextWindow', 'permission', 'effort', 'sandbox']

**codex profile**:
- models: dynamic from `CodexModelInfo[]` via daemon
- permissionModes: `CODEX_PERMISSION_MODES`
- reasoningEfforts: dynamic per-model from `CodexModelInfo.reasoningEfforts`
- features: ['git'] (no controlPalette, no sandbox toggle)
- defaultStatusChips: ['agent', 'model', 'permission', 'effort']

**pi profile** (new):
- models: empty array initially (pi uses its own built-in model selection); or we expose a fixed set
- permissionModes: `PERMISSION_MODES` (maps to Pi permission levels: allow, deny, ask)
- reasoningEfforts: not applicable (pi manages its own context/thinking)
- features: ['git']
- defaultStatusChips: ['agent', 'permission']
- Note: pi 沒有模型選擇（它是獨立的 agent process），permission mode 可以映射到
  `PermissionLevel.AUTO_ALLOW` / `PermissionLevel.AUTO_DENY` / `PermissionLevel.ASK_USER`

**opencode profile** (placeholder, if we implement it):
- models: TBD
- permissionModes: TBD
- features: TBD

#### 1.3 建立 profile registry

```typescript
const AGENT_PROFILES: Record<AgentId, AgentProfile> = {
  'claude-code': claudeCodeProfile,
  codex: codexProfile,
  pi: piProfile,
  opencode: opencodeProfile,
};

export function getAgentProfile(agentId: AgentId): AgentProfile {
  return AGENT_PROFILES[agentId] ?? AGENT_PROFILES['claude-code'];
}

export function getAllAgentProfiles(): AgentProfile[] {
  return Object.values(AGENT_PROFILES);
}
```

#### 1.4 重構 `claudePresets.ts`

把 `AGENT_TYPES` 改為從 profile registry 產生：

```typescript
export const AGENT_TYPES: AgentType[] = getAllAgentProfiles().map(p => ({
  value: p.id,
  label: p.label,
  description: p.description,
}));
```

把 `getModelsForAgent` / `getPermissionModesForAgent` / `getReasoningEffortsForModel` 
改為從 profile 查詢（保持 backward compat 直到所有 call site 改完）。

### Phase 2: UI Refactoring — Status Bar & Settings

#### 2.1 重構 `SessionStatusBar.tsx`

**核心思路**：不再硬編譯 agent 邏輯，改為根據當前 agent profile 的 `defaultStatusChips`
動態生成 chips，並根據 runtime config 覆蓋。

具體改法：

1. 讀取當前 session 的 `agent`（透過 `useSessionConfig`）
2. 取得該 agent 的 profile
3. 根據 `profile.defaultStatusChips` 渲染對應的 chip
4. 每個 chip 型別有自己的 renderer（model picker, permission picker, effort picker 等）
5. 未知的 chip type → 顯示為 generic tooltip chip

**重構後的結構**：

```tsx
function SessionStatusBar({ sessionId, onSetSessionConfig, children }) {
  const config = useSessionConfig(sessionId);
  const profile = getAgentProfile(config.agent as AgentId);
  
  // Generate chips based on profile + config
  const chips = computeChips(profile, config);
  
  return (
    <div className="flex items-center gap-1.5 pb-2 text-xs flex-wrap">
      {chips.map(chip => (
        <ChipRenderer
          key={chip.type}
          chip={chip}
          profile={profile}
          config={config}
          onSetConfig={onSetSessionConfig}
        />
      ))}
      {children}
    </div>
  );
}
```

每個 `ChipRenderer` 根據 `chip.type` 分發到對應的 renderer：
- `model` → model dropdown (使用 profile.models)
- `permission` → permission dropdown (使用 profile.permissionModes)
- `effort` → reasoning effort dropdown (使用 profile.reasoningEfforts)
- `contextWindow` → context window picker (使用 profile.contextWindows)
- `sandbox` → toggle switch
- `custom` → 使用 `chip.computeValue(config)` 顯示自訂值
- `agent` → 靜態顯示 agent label（可點擊切換 agent，如果支援的話）

#### 2.2 重構 `ClaudeSettingsSection.tsx`

改為從 profile 讀取可用的設定欄位：

```tsx
function ClaudeSettingsSection({ sessionId, onSetConfig, agentLocked, hideFields }) {
  const config = useSessionConfig(sessionId);
  const profile = getAgentProfile(config.agent as AgentId);
  
  // Determine which fields to show based on profile capabilities
  const showModel = profile.capabilities.supportsModelSelection && !hideFields.includes('model');
  const showPermission = profile.capabilities.supportsPermissionMode && !hideFields.includes('permission');
  const showEffort = profile.capabilities.supportsReasoningEffort && !hideFields.includes('reasoningEffort');
  const showContextWindow = profile.capabilities.supportsContextWindow && !hideFields.includes('contextWindow');
  const showSandbox = profile.capabilities.supportsSandbox && !hideFields.includes('sandbox');
  
  return (
    <div className="space-y-5">
      {/* Agent selector */}
      {!hideFields.includes('agent') && (
        <AgentSelector profiles={getAllAgentProfiles()} ... />
      )}
      
      {/* Model selector — only if profile has models */}
      {showModel && (
        <ModelSelector
          profile={profile}
          models={resolveModels(profile)}
          ...
        />
      )}
      
      {/* ... other fields derived from profile capabilities ... */}
    </div>
  );
}
```

#### 2.3 重構 `AgentSettingsDrawer.tsx`

- 根據當前 agent profile 的 `features` 決定顯示哪些 advanced 選項
- `isClaudeCode` → `profile.features?.includes('controlPalette')`
- `isCodex` → 隱藏 sandbox toggle, controlPalette
- opencode/pi → 顯示對應的 features

### Phase 3: Provider Probe Integration

#### 3.1 PWA: 在 handshake 時處理 `availableProviders`

**File**: `apps/pwa/src/App.tsx`

在 `onConnected` callback 裡：

```typescript
onConnected: (agentId, path, pro, availableRepos, availableCodingPaths, preferences, 
              agentVersion, latestVersion, devBuild, codexModels, platform, availableProviders) => {
  // ... existing code ...
  
  if (availableProviders?.length) {
    // Store available providers for this agent machine
    useConnectionStore.getState().setAvailableProviders(agentId, availableProviders);
  }
}
```

**File**: `apps/pwa/src/stores/connectionStore.ts`

新增 `availableProviders` 到 per-agent connection state：

```typescript
interface AgentConnection {
  // existing fields
  availableProviders?: AgentProviderInfo[];
}
```

#### 3.2 PWA: 根據 probe 結果過濾 agent selector

**File**: `apps/pwa/src/lib/agentProfiles.ts` + `claudePresets.ts`

Agent selector（ButtonGroup）只顯示 `installed && hasCredentials` 的 agents。
其他 agents 顯示為 grayed out 並帶 tooltip "Not installed" 或 "No credentials"。

#### 3.3 新 session 時檢查 provider availability

**File**: `apps/pwa/src/components/settings/ClaudeSettingsSection.tsx`

當用戶選了一個不可用的 agent 時：
1. 顯示 warning: "Provider '{label}' is not available on this machine"
2. 自動 fallback 到第一個可用的 agent
3. 或者讓用戶確認繼續（顯示 placeholder settings）

### Phase 4: Agent Switching & Multi-Agent UI

#### 4.1 AgentSwitcher component 重構

**File**: `apps/pwa/src/components/sessions/AgentSwitcher.svelte` (or React equivalent)

顯示所有 available（installed + hasCredentials）的 agents，當前 agent 高亮。
非可用 agents 顯示 grayed out。

#### 4.2 Multi-agent 連線支援

如果用戶有多台機器（多台 agent daemon），每台可能有不同的 provider 組合：
- PWA 的 `connectionStore.agentConnections` 每筆 entry 都有自己的 `availableProviders`
- Agent selector 在選了特定 machine 後，只顯示該 machine 上可用的 agents
- 跨 machine 切換時，自動帶入該 machine 的 provider probe 結果

---

## 四、Phase Dependencies

```
Phase 0: Provider Probe Protocol (shared types + daemon handler)
  └── Phase 1: Agent Profile System (pwa lib)
        ├── Phase 2.1: SessionStatusBar 重構
        ├── Phase 2.2: ClaudeSettingsSection 重構
        └── Phase 2.3: AgentSettingsDrawer 重構
  └── Phase 3: Probe Integration (handshake + store + filter)
        └── Phase 4: Agent Switching & Multi-Agent UI
```

Phase 0 和 Phase 1 可以並行開發（不同 files）。Phase 2 的三個 component 也可以並行。
Phase 3 依賴 Phase 0 + Phase 1。Phase 4 依賴所有前面 phases。

---

## 五、File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `packages/shared/src/types.ts` | Add `AgentProviderInfo`, `AgentCapabilities`, `AgentProbeRequestPayload`, `AgentProbeResponsePayload`, extend `HandshakeAckPayload` | 0 |
| `apps/agent/src/ai/provider.ts` | Add `label`, `capabilities`, `binaryPath?`, `hasCredentials?` to `CodingAgentProvider` interface | 0 |
| `apps/agent/src/ai/piProvider.ts` | Implement new interface methods for probing | 0 |
| `apps/agent/src/handlers/messageHandler.ts` | Add `agent:probe` command handler | 0 |
| `apps/agent/src/ai/claudeCodeProvider.ts` | Implement probing methods | 0 |
| `apps/agent/src/ai/codexAppServer/provider.ts` | Implement probing methods | 0 |
| `apps/pwa/src/lib/agentProfiles.ts` | **NEW** — AgentProfile interface + 4 profile definitions + registry | 1 |
| `apps/pwa/src/lib/claudePresets.ts` | Refactor `AGENT_TYPES`, helper functions to use profiles | 1 |
| `apps/pwa/src/components/chat/SessionStatusBar.tsx` | Rewrite to use profile-based chip rendering | 2.1 |
| `apps/pwa/src/components/settings/ClaudeSettingsSection.tsx` | Rewrite to use profile capabilities | 2.2 |
| `apps/pwa/src/components/AgentSettingsDrawer.tsx` | Rewrite feature detection from profile | 2.3 |
| `apps/pwa/src/stores/connectionStore.ts` | Add `availableProviders` to per-agent state | 3 |
| `apps/pwa/src/hooks/useSessionConfig.ts` | Extend to handle all 4 agent IDs | 1 |
| `apps/pwa/src/components/sessions/AgentSwitcher.svelte` | Filter by probe results | 4 |
| `apps/pwa/src/App.tsx` | Handle `availableProviders` in handshake | 3 |

---

## 六、Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| opencode provider 尚未實作 | Phase 1 的 profile 是 placeholder，Phase 2 會顯示 empty | 先只做 claude-code + codex + pi 三個，opencode 留空 profile |
| 重構 SessionStatusBar 會破壞現有 UI | 高 — 這是 session 的核心顯示區域 | 先用 profile 代理（agent-profile.ts 回傳與現有硬編碼等價的 profile），逐步替換 chip rendering |
| probe 增加 handshake latency | 中 — 檢查 binary 和 credential 需要 fs 操作 | 所有 probe 操作在 agent daemon 端同步執行（快），只在首次 handshake 執行，後續走 WebSocket 共享 |
| Pi provider 的 permission model 與 claude-code 不同 | 中 — 需要 mapping | Pi 使用 `PermissionLevel`（auto_allow/auto_deny/ask_user），PWA 端映射到通用 label |

---

## 七、Pi 特別處理

Pi (π) 的 provider 有三個關鍵差異需要特別處理：

### 7.1 Permission Model 映射

Pi 使用 `PermissionLevel` 而非 claude-code 的 permission mode：

| Pi PermissionLevel | PWA 顯示 label | 對應操作 |
|---|---|---|
| `auto_allow` | Auto | 自動允許所有 tool calls |
| `auto_deny` | Deny | 拒絕所有 tool calls |
| `ask_user` | Ask User | 每次 tool call 彈出 permission popup |

在 pi profile 的 `permissionModes` 中定義這個映射：
```typescript
permissionModes: [
  { value: 'auto_allow', label: 'Auto', description: 'Allow all actions automatically' },
  { value: 'ask_user',   label: 'Ask User', description: 'Ask before each action' },
  { value: 'auto_deny',  label: 'Deny', description: 'Block all actions' },
]
```

### 7.2 沒有模型選擇

Pi 的 agent 使用自己內建的 model（由 `@earendil-works/pi-coding-agent` 包管理）。
PWA 端不需要提供模型選擇器。Pi profile 的 `capabilities.supportsModelSelection = false`。

### 7.3 沒有 reasoning effort

Pi 由自身管理 context window 和 thinking。PWA 端的 reasoning effort chip 對 pi 顯示為 disabled 或 hidden。
