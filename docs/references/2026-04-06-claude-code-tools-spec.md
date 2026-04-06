# Claude Code 與 Claude Agent SDK 內建工具類型完整規格總覽

本報告彙整 **Claude Code / Claude Agent SDK**（以下合稱「SDK」）在官方文件與官方發佈之型別定義中可辨識的**所有內建 tool type**，並為每個 tool 提供可直接落地的規格（用途、輸入/輸出 JSON Schema、範例、限制與權限注意事項、官方來源）。結論上，SDK 的內建工具面可分為 **Agent（子代理）**、**Shell（命令執行）**、**File IO（檔案/Notebook/PDF）**、**Search（Grep/Glob/WebSearch）**、**Web（WebFetch/WebSearch）**、**Workflow（Todo/Plan/Config/AskUserQuestion）**、**MCP（resource 與自訂工具）**、**Other（Skills）** 八大類。citeturn33search12turn42view0turn37view0turn41view3turn43view1

在治理面（permissions）上，請把它當作「工具不是不能用，而是要先過內控」。SDK 的權限評估流程明確分層：**hooks → deny rules → permission mode → allow rules → canUseTool callback**；並且 `allowed_tools`/`disallowed_tools` 只管「是否自動核准/拒絕」，**不等於**「工具是否存在或是否出現在模型上下文」。若要「從根本上讓模型看不到某些內建工具」，應使用 `tools` 選項移除它，而非僅靠 deny。citeturn18view0turn41view3turn41view2

## 目錄

- [涵蓋範圍與資料來源](#涵蓋範圍與資料來源)  
- [工具分類對照表](#工具分類對照表)  
- [代理迴圈與權限模型](#代理迴圈與權限模型)  
- [內建工具逐一規格](#內建工具逐一規格)  
- [MCP、自訂工具與「裸模式」注意事項](#mcp自訂工具與裸模式注意事項)  
- [命名差異、別名與版本漂移](#命名差異別名與版本漂移)  

## 涵蓋範圍與資料來源

本報告以兩類「一手來源」為主：

- 官方 **TypeScript Agent SDK 參考文件**（含 Tool Input/Output types 與語意描述）。citeturn42view0turn13view4turn17view0  
- 官方發佈套件內的 `sdk-tools.d.ts`（自 **Claude Code** 套件版本頁面可取得），該檔明確標註為由 JSON Schema 產生，並包含多項**約束/註解**（例如：Bash timeout 上限、PDF pages 每次最多 20 頁、AskUserQuestion 的 questions/options 數量限制等）。citeturn29view0turn37view0turn37view1turn38view0

另補強以下官方指南作為「權限/可用性/Skills」與「自訂工具」的規範依據：citeturn18view0turn41view3turn43view1turn43view0

> 重要原則：若官方文件未明示某 tool 的輸出/輸入 schema，本報告會標註為 **unspecified**（不自行腦補欄位）。citeturn42view0turn43view1

## 工具分類對照表

下表用「治理/風險」視角整理內建工具（含官方文件與型別定義可辨識者）。工具名稱以**呼叫時的 tool name**為準。citeturn42view0turn37view0turn30view0turn43view1

| 類別 | 工具（tool name） | 主要副作用面 | 常見限制/特性（節錄） |
|---|---|---|---|
| Agent | `Agent` | 生成/編排子代理（可背景） | `run_in_background` 會回傳 output 檔案路徑；`Agent` 有 `Task` 別名（仍接受）citeturn42view0 |
| Shell | `Bash`, `TaskOutput`, `TaskStop` | 執行命令、停止背景任務 | Bash timeout（ms）上限 600000；背景命令可拿 `backgroundTaskId`；`TaskStop` 支援 `shell_id` 但標註 deprecated citeturn42view0turn37view0turn37view1 |
| File IO | `Read`, `Write`, `Edit` | 讀/寫/修改檔案 | `Read.pages` 適用 PDF，單次最多 20 頁；`Edit` 是精確字串置換；`Write` 覆寫寫入 citeturn37view0turn42view0 |
| Repo/隔離 | `EnterWorktree`, `ExitWorktree` | 建/退 git worktree | `EnterWorktree` 在 TS 參考有輸入/輸出；`ExitWorktree` 在 `sdk-tools.d.ts` 中可見但本次可取得文件未揭示 schema（故標註 unspecified）citeturn42view0turn30view0 |
| 本地搜尋 | `Glob`, `Grep` | 讀取 codebase 結構/內容 | `Grep` 基於 ripgrep，支援 `output_mode`、context、`head_limit`、`multiline` 等 citeturn37view1turn42view0 |
| Notebook | `NotebookEdit` | 修改 `.ipynb` cell | 支援 `replace/insert/delete`；回傳 original/updated 檔案內容 citeturn37view1turn42view0 |
| Web | `WebSearch`, `WebFetch` | 對外網路存取 | `WebSearch` 支援 domain allow/block；`WebFetch` 回 HTTP code/bytes/duration citeturn37view1turn42view0 |
| Workflow | `TodoWrite`, `ExitPlanMode`, `AskUserQuestion`, `Config` | 任務治理/互動/設定 | `AskUserQuestion` questions 1–4、options 2–4、header ≤12 chars；`ExitPlanMode` 可帶 `allowedPrompts` citeturn37view1turn38view0turn42view0 |
| MCP | `ListMcpResources`, `ReadMcpResource`, `Mcp` | 連接外部工具/資源 | MCP tool 名稱格式 `mcp__{server}__{tool}`；`Mcp` 在 `sdk-tools.d.ts` 中存在但 schema 泛型（動態）citeturn41view3turn37view1turn30view0turn17view0 |
| Other | `Skill` | 啟用並調用 Skills（檔案系統載入） | 必須把 `"Skill"` 放進 `allowedTools` 並啟用 `settingSources`/`setting_sources` 才會載入 Skills；SDK 不提供「程式化註冊 Skill」API citeturn43view1turn43view0 |

## 代理迴圈與權限模型

### Tool 呼叫在 Agent loop 中的生命週期

以下用高層抽象描述 SDK 的運作：模型提出 tool request → SDK 進行權限評估 → 通過則執行並回傳 tool_result → 進入下一輪，直到完成或被中止。citeturn18view0turn41view3turn33search12

```mermaid
flowchart TD
  U[User prompt] --> A[Agent loop / query()]
  A --> M[Model proposes tool call]
  M --> P[Permission evaluation]
  P -->|Denied| D[Return denial / tool not executed]
  P -->|Approved| T[Execute tool]
  T --> R[tool_result -> model context]
  D --> R
  R --> A
  A -->|Done| O[Final ResultMessage]
```

### 權限評估順序與「內控」要點

SDK 的權限評估順序為：**Hooks → Deny rules → Permission mode → Allow rules → canUseTool callback**。其中 deny rules（`disallowed_tools` 或 settings.json deny）在流程早期就可直接擋掉，且即使在 `bypassPermissions` 也仍會生效（deny 優先）。citeturn18view0turn41view2

幾個實務上最容易踩雷的規則：

- `allowed_tools` / `allowedTools` 只是在 allow rules 加規則，**不代表其它工具不存在**；未列出的工具仍可能被模型嘗試，然後才落到 permission mode / `canUseTool`。citeturn41view2turn18view0  
- 若要讓模型「連看到都看不到」某些內建工具，應用 `tools: [...]` 限定可用內建工具集合；`disallowedTools` 只是「看得到但一律拒絕」，會浪費回合。citeturn41view3turn18view0  
- `acceptEdits` 會自動核准檔案操作與部分 filesystem 指令（如 `mkdir/touch/rm/mv/cp`），但非 filesystem 的 Bash 仍需走一般權限。citeturn41view0turn41view1  

## 內建工具逐一規格

本節每個工具均提供：

- **工具名稱**：canonical 與別名（若官方明示）  
- **用途簡述**  
- **Input JSON Schema**：以 JSON Schema（draft 2020-12 風格）表示  
- **Output JSON Schema**  
- **Example**：示例 input/output JSON（不等同 Messages API 的完整封包，只聚焦 tool 層）  
- **特殊行為 / 限制**  
- **權限 / 可用性**  
- **官方來源**：以引用方式提供

### Agent

**工具名稱**：`Agent`（別名：`Task` 仍接受）citeturn42view0  

**用途簡述**：啟動子代理執行任務，可選擇背景執行並以檔案追蹤輸出；輸出以 `status` 區分（完成、背景啟動、或進入互動式子代理）。citeturn42view0turn37view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentInput",
  "type": "object",
  "required": ["description", "prompt", "subagent_type"],
  "properties": {
    "description": {
      "type": "string",
      "description": "任務短描述（官方註解：3-5 個字/詞）"
    },
    "prompt": { "type": "string", "description": "子代理要執行的任務內容" },
    "subagent_type": { "type": "string", "description": "子代理類型/專長" },
    "model": {
      "type": "string",
      "enum": ["sonnet", "opus", "haiku"],
      "description": "可選模型覆寫；未指定則繼承"
    },
    "resume": { "type": "string", "description": "恢復既有 agentId（若支援）" },
    "run_in_background": { "type": "boolean", "description": "背景執行" },
    "max_turns": { "type": "number", "description": "最多 agentic 回合數（內部用途註解）" },
    "name": { "type": "string", "description": "子代理命名" },
    "team_name": { "type": "string", "description": "團隊名稱（若支援 team context）" },
    "mode": {
      "type": "string",
      "enum": ["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan"],
      "description": "子代理 permission mode"
    },
    "isolation": {
      "type": "string",
      "enum": ["worktree"],
      "description": "隔離模式：worktree（在隔離副本中工作）"
    }
  }
}
```
> 註：不同版本對必填/選填欄位可能略有差異；本 schema 以官方 TS 參考為主，並吸收 `sdk-tools.d.ts` 中可見欄位（例如 `isolation: worktree`）。citeturn42view0turn37view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentOutput",
  "oneOf": [
    {
      "type": "object",
      "required": ["status", "agentId", "content", "totalToolUseCount", "totalDurationMs", "totalTokens", "usage", "prompt"],
      "properties": {
        "status": { "const": "completed" },
        "agentId": { "type": "string" },
        "content": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["type", "text"],
            "properties": { "type": { "const": "text" }, "text": { "type": "string" } }
          }
        },
        "totalToolUseCount": { "type": "number" },
        "totalDurationMs": { "type": "number" },
        "totalTokens": { "type": "number" },
        "usage": { "type": "object", "description": "token 與 server tool use 統計（欄位依官方型別）" },
        "prompt": { "type": "string" }
      }
    },
    {
      "type": "object",
      "required": ["status", "agentId", "description", "prompt", "outputFile"],
      "properties": {
        "status": { "const": "async_launched" },
        "agentId": { "type": "string" },
        "description": { "type": "string" },
        "prompt": { "type": "string" },
        "outputFile": { "type": "string" },
        "canReadOutputFile": { "type": "boolean" }
      }
    },
    {
      "type": "object",
      "required": ["status", "description", "message"],
      "properties": {
        "status": { "const": "sub_agent_entered" },
        "description": { "type": "string" },
        "message": { "type": "string" }
      }
    }
  ]
}
```
citeturn42view0  

**Example（input / output）**
```json
{
  "tool": "Agent",
  "input": {
    "description": "修復登入錯誤",
    "prompt": "找出 auth.py 的 bug 並修好，補上測試。",
    "subagent_type": "code",
    "model": "sonnet",
    "run_in_background": true,
    "mode": "acceptEdits",
    "isolation": "worktree"
  }
}
```

```json
{
  "status": "async_launched",
  "agentId": "agent_123",
  "description": "修復登入錯誤",
  "prompt": "找出 auth.py 的 bug 並修好，補上測試。",
  "outputFile": "/tmp/claude/agents/agent_123.out",
  "canReadOutputFile": true
}
```

**特殊行為 / 限制**：背景模式會提供 `outputFile` 供後續讀取；輸出以 `status` 判別不同生命週期狀態。citeturn42view0  

**權限 / 可用性**：`Agent` 本身也受 permission flow 管控；若主代理使用 `bypassPermissions`，子代理繼承且不可覆寫的風險需特別控管。citeturn41view1turn18view0  

**官方來源**：citeturn42view0turn37view0  

### AskUserQuestion

**工具名稱**：`AskUserQuestion`citeturn42view0turn37view1  

**用途簡述**：在執行途中向使用者提出 1–4 個結構化問題（每題 2–4 個選項，可單選/多選），用於釐清需求或取得核准。輸出回傳 questions 與 answers。citeturn42view0turn37view1turn38view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AskUserQuestionInput",
  "type": "object",
  "required": ["questions"],
  "properties": {
    "questions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["question", "header", "options", "multiSelect"],
        "properties": {
          "question": { "type": "string", "description": "完整問題句（官方註解：清楚、具體、以 ? 結尾）" },
          "header": { "type": "string", "maxLength": 12, "description": "極短標籤（≤12 字元）" },
          "options": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "object",
              "required": ["label", "description"],
              "properties": {
                "label": { "type": "string", "description": "選項顯示文字（官方註解：1–5 words）" },
                "description": { "type": "string" },
                "preview": { "type": "string", "description": "可選：聚焦時顯示的預覽內容（格式官方描述為準）" }
              }
            }
          },
          "multiSelect": { "type": "boolean", "description": "true 則允許多選" }
        }
      }
    }
  }
}
```
citeturn37view1turn38view0turn38view1turn42view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AskUserQuestionOutput",
  "type": "object",
  "required": ["questions", "answers"],
  "properties": {
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["question", "header", "options", "multiSelect"],
        "properties": {
          "question": { "type": "string" },
          "header": { "type": "string" },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["label", "description"],
              "properties": {
                "label": { "type": "string" },
                "description": { "type": "string" },
                "preview": { "type": "string" }
              }
            }
          },
          "multiSelect": { "type": "boolean" }
        }
      }
    },
    "answers": {
      "type": "object",
      "additionalProperties": { "type": "string" },
      "description": "以 key-value 回傳答案（value 為 string）。multiSelect 的多選串接格式：官方文件未在此型別片段中明示，故不推測。"
    }
  }
}
```
citeturn42view0turn37view1turn38view0  

**Example**
```json
{
  "tool": "AskUserQuestion",
  "input": {
    "questions": [
      {
        "question": "要用哪種驗證方式？",
        "header": "Auth",
        "options": [
          { "label": "JWT", "description": "無狀態、適合 API" },
          { "label": "Session", "description": "伺服器端 session，較易撤銷" }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

```json
{
  "questions": [
    {
      "question": "要用哪種驗證方式？",
      "header": "Auth",
      "options": [
        { "label": "JWT", "description": "無狀態、適合 API" },
        { "label": "Session", "description": "伺服器端 session，較易撤銷" }
      ],
      "multiSelect": false
    }
  ],
  "answers": {
    "Auth": "JWT"
  }
}
```

**特殊行為 / 限制**：questions 1–4、options 2–4、header ≤12 字元；可提供 preview 協助比較。citeturn37view1turn38view0  

**權限 / 可用性**：AskUserQuestion 是典型「阻塞式互動點」；在 `dontAsk` 模式下，若未被 allow 規則核准，可能直接被否決而不會走到 `canUseTool`（視整體 permission 設定）。citeturn18view0turn41view1  

**官方來源**：citeturn42view0turn37view1turn38view0  

### Bash

**工具名稱**：`Bash`citeturn42view0turn13view4turn37view0  

**用途簡述**：在持久化 shell session 中執行命令，支援 timeout、背景執行、以及（高風險）取消 sandbox。citeturn13view4turn37view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BashInput",
  "type": "object",
  "required": ["command"],
  "properties": {
    "command": { "type": "string", "description": "要執行的命令" },
    "timeout": { "type": "number", "maximum": 600000, "description": "毫秒；上限 600000" },
    "description": { "type": "string", "description": "命令用途簡述（官方給了大量寫法指引）" },
    "run_in_background": { "type": "boolean", "description": "true 則背景執行，後續可用 TaskOutput 取得輸出" },
    "dangerouslyDisableSandbox": { "type": "boolean", "description": "true 則危險地關閉 sandbox（高風險）" }
  }
}
```
citeturn37view0turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BashOutput",
  "type": "object",
  "required": ["stdout", "stderr", "interrupted"],
  "properties": {
    "stdout": { "type": "string" },
    "stderr": { "type": "string" },
    "rawOutputPath": { "type": "string" },
    "interrupted": { "type": "boolean" },
    "isImage": { "type": "boolean" },
    "backgroundTaskId": { "type": "string" },
    "backgroundedByUser": { "type": "boolean" },
    "dangerouslyDisableSandbox": { "type": "boolean" },
    "returnCodeInterpretation": { "type": "string" },
    "structuredContent": { "type": "array", "items": {}, "description": "unknown[]（官方型別）" },
    "persistedOutputPath": { "type": "string" },
    "persistedOutputSize": { "type": "number" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "Bash",
  "input": {
    "command": "pytest -q",
    "timeout": 600000,
    "description": "Run unit tests",
    "run_in_background": true
  }
}
```

```json
{
  "stdout": "",
  "stderr": "",
  "interrupted": false,
  "backgroundTaskId": "task_456"
}
```

**特殊行為 / 限制**：timeout 最高 600000ms；背景命令會提供 `backgroundTaskId`。citeturn37view0turn42view0  

**權限 / 可用性**：Bash 通常是最高風險工具之一；可用 `disallowed_tools=["Bash"]` 強制禁止，且 deny 在流程中優先且跨模式有效。citeturn41view2turn18view0  

**官方來源**：citeturn37view0turn42view0  

### TaskOutput

**工具名稱**：`TaskOutput`（舊版/跨文件可能見到 `BashOutput` 作為「取輸出工具」的命名；以現行 TS 參考的 `TaskOutput` 為主）citeturn13view4turn37view0  

**用途簡述**：取得背景任務（例如背景 Bash）在執行中或完成後的輸出。citeturn13view4turn37view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskOutputInput",
  "type": "object",
  "required": ["task_id", "block", "timeout"],
  "properties": {
    "task_id": { "type": "string", "description": "背景 task ID" },
    "block": { "type": "boolean", "description": "是否等待完成" },
    "timeout": { "type": "number", "description": "等待上限（ms）" }
  }
}
```
citeturn37view0turn13view4  

**Output JSON Schema**（unspecified）
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskOutputOutput",
  "description": "官方 TS 參考可見 TaskOutputInput，但在可取得之 ToolOutputSchemas 片段未明示 TaskOutput 的回傳型別；為避免臆測，此處標註 unspecified。",
  "type": ["object", "string", "array", "null"],
  "additionalProperties": true
}
```
citeturn13view4turn42view0  

**Example**
```json
{
  "tool": "TaskOutput",
  "input": { "task_id": "task_456", "block": true, "timeout": 30000 }
}
```

```json
{
  "unspecified": true
}
```

**特殊行為 / 限制**：與 `Bash.run_in_background` 搭配使用；`block` 與 `timeout` 控制等待策略。citeturn37view0turn13view4  

**權限 / 可用性**：屬於低副作用（讀取輸出）但仍是 tool call；可透過 allow/deny 規則控管。citeturn41view2turn18view0  

**官方來源**：citeturn13view4turn37view0turn42view0  

### TaskStop

**工具名稱**：`TaskStop`（輸入型別中可見 `shell_id` 註記 deprecated：代表舊版以 shell_id 命名/傳參的兼容面）citeturn13view4turn37view1  

**用途簡述**：停止背景 task（或舊版 shell）之執行。citeturn13view4turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskStopInput",
  "type": "object",
  "properties": {
    "task_id": { "type": "string", "description": "背景 task ID" },
    "shell_id": { "type": "string", "description": "Deprecated：改用 task_id" }
  }
}
```
citeturn37view1turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskStopOutput",
  "type": "object",
  "required": ["message", "task_id", "task_type"],
  "properties": {
    "message": { "type": "string" },
    "task_id": { "type": "string" },
    "task_type": { "type": "string" },
    "command": { "type": "string" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "TaskStop",
  "input": { "task_id": "task_456" }
}
```

```json
{
  "message": "Stopped",
  "task_id": "task_456",
  "task_type": "bash",
  "command": "pytest -q"
}
```

**特殊行為 / 限制**：`shell_id` 仍可能出現在相容層，但官方型別註記為 deprecated。citeturn37view1turn13view4  

**權限 / 可用性**：終止背景執行屬「控制類」操作；建議納入 allow 規則而非讓模型任意終止。citeturn41view2turn18view0  

**官方來源**：citeturn13view4turn37view1turn42view0  

### Edit

**工具名稱**：`Edit`citeturn13view4turn42view0  

**用途簡述**：對檔案做「精確字串置換」，可選 replace_all；回傳結構化 patch 與（可選）git diff 資訊。citeturn13view4turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileEditInput",
  "type": "object",
  "required": ["file_path", "old_string", "new_string"],
  "properties": {
    "file_path": { "type": "string", "description": "檔案路徑（官方註解：absolute path）" },
    "old_string": { "type": "string" },
    "new_string": { "type": "string", "description": "必須不同於 old_string（官方註解）" },
    "replace_all": { "type": "boolean", "description": "是否替換全部匹配（預設 false）" }
  }
}
```
citeturn37view0turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileEditOutput",
  "type": "object",
  "required": ["filePath", "oldString", "newString", "originalFile", "structuredPatch", "userModified", "replaceAll"],
  "properties": {
    "filePath": { "type": "string" },
    "oldString": { "type": "string" },
    "newString": { "type": "string" },
    "originalFile": { "type": "string" },
    "structuredPatch": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["oldStart", "oldLines", "newStart", "newLines", "lines"],
        "properties": {
          "oldStart": { "type": "number" },
          "oldLines": { "type": "number" },
          "newStart": { "type": "number" },
          "newLines": { "type": "number" },
          "lines": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    "userModified": { "type": "boolean" },
    "replaceAll": { "type": "boolean" },
    "gitDiff": {
      "type": "object",
      "properties": {
        "filename": { "type": "string" },
        "status": { "type": "string", "enum": ["modified", "added"] },
        "additions": { "type": "number" },
        "deletions": { "type": "number" },
        "changes": { "type": "number" },
        "patch": { "type": "string" }
      }
    }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "Edit",
  "input": {
    "file_path": "/repo/auth.py",
    "old_string": "timeout=5",
    "new_string": "timeout=10",
    "replace_all": false
  }
}
```

```json
{
  "filePath": "/repo/auth.py",
  "oldString": "timeout=5",
  "newString": "timeout=10",
  "originalFile": "...",
  "structuredPatch": [
    { "oldStart": 10, "oldLines": 1, "newStart": 10, "newLines": 1, "lines": ["- timeout=5", "+ timeout=10"] }
  ],
  "userModified": false,
  "replaceAll": false
}
```

**特殊行為 / 限制**：Edit 是「精確字串替換」，對上下文依賴高；通常先 `Read` 再 `Edit`。citeturn13view4turn42view0  

**權限 / 可用性**：在 `acceptEdits` 模式下，Edit/Write 等檔案操作會被自動核准。citeturn41view0turn41view1  

**官方來源**：citeturn13view4turn42view0turn41view0  

### Read

**工具名稱**：`Read`citeturn13view4turn42view0  

**用途簡述**：讀取檔案（文字、圖片、PDF、Notebook 等），輸出以 `type` 區分。PDF 可用 `pages` 指定頁碼範圍，且單次最多 20 頁。citeturn42view0turn13view4turn37view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileReadInput",
  "type": "object",
  "required": ["file_path"],
  "properties": {
    "file_path": { "type": "string", "description": "檔案路徑（官方註解：absolute path）" },
    "offset": { "type": "number", "description": "起始行（檔案太大時才提供）" },
    "limit": { "type": "number", "description": "讀取行數（檔案太大時才提供）" },
    "pages": {
      "type": "string",
      "description": "PDF 頁碼範圍（例：\"1-5\"、\"3\"、\"10-20\"）；單次最多 20 頁（官方註解）"
    }
  }
}
```
citeturn13view4turn37view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileReadOutput",
  "oneOf": [
    {
      "type": "object",
      "required": ["type", "file"],
      "properties": {
        "type": { "const": "text" },
        "file": {
          "type": "object",
          "required": ["filePath", "content", "numLines", "startLine", "totalLines"],
          "properties": {
            "filePath": { "type": "string" },
            "content": { "type": "string" },
            "numLines": { "type": "number" },
            "startLine": { "type": "number" },
            "totalLines": { "type": "number" }
          }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "file"],
      "properties": {
        "type": { "const": "image" },
        "file": {
          "type": "object",
          "required": ["base64", "type", "originalSize"],
          "properties": {
            "base64": { "type": "string" },
            "type": { "type": "string", "enum": ["image/jpeg", "image/png", "image/gif", "image/webp"] },
            "originalSize": { "type": "number" },
            "dimensions": { "type": "object", "description": "可選尺寸資訊（官方型別）" }
          }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "file"],
      "properties": {
        "type": { "const": "notebook" },
        "file": {
          "type": "object",
          "required": ["filePath", "cells"],
          "properties": { "filePath": { "type": "string" }, "cells": { "type": "array", "items": {} } }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "file"],
      "properties": {
        "type": { "const": "pdf" },
        "file": {
          "type": "object",
          "required": ["filePath", "base64", "originalSize"],
          "properties": { "filePath": { "type": "string" }, "base64": { "type": "string" }, "originalSize": { "type": "number" } }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "file"],
      "properties": {
        "type": { "const": "parts" },
        "file": {
          "type": "object",
          "required": ["filePath", "originalSize", "count", "outputDir"],
          "properties": {
            "filePath": { "type": "string" },
            "originalSize": { "type": "number" },
            "count": { "type": "number" },
            "outputDir": { "type": "string" }
          }
        }
      }
    }
  ]
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "Read",
  "input": {
    "file_path": "/repo/spec.pdf",
    "pages": "1-5"
  }
}
```

```json
{
  "type": "pdf",
  "file": {
    "filePath": "/repo/spec.pdf",
    "base64": "JVBERi0xLjcKJc...",
    "originalSize": 1048576
  }
}
```

**特殊行為 / 限制**：PDF `pages` 單次最多 20 頁。citeturn37view0  

**權限 / 可用性**：Read 通常是低風險工具，常被列入 `allowedTools`；但仍遵守 permission flow。citeturn41view2turn18view0  

**官方來源**：citeturn42view0turn37view0turn13view4  

### Write

**工具名稱**：`Write`citeturn13view4turn42view0  

**用途簡述**：寫入檔案（若存在則覆寫），回傳 create/update 與結構化 patch。citeturn13view4turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileWriteInput",
  "type": "object",
  "required": ["file_path", "content"],
  "properties": {
    "file_path": { "type": "string", "description": "檔案路徑（官方註解：must be absolute）" },
    "content": { "type": "string" }
  }
}
```
citeturn37view0turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileWriteOutput",
  "type": "object",
  "required": ["type", "filePath", "content", "structuredPatch", "originalFile"],
  "properties": {
    "type": { "type": "string", "enum": ["create", "update"] },
    "filePath": { "type": "string" },
    "content": { "type": "string" },
    "structuredPatch": { "type": "array", "items": { "type": "object" } },
    "originalFile": { "type": ["string", "null"] },
    "gitDiff": { "type": "object" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "Write",
  "input": {
    "file_path": "/repo/README.md",
    "content": "# Project\n\nUpdated."
  }
}
```

```json
{
  "type": "update",
  "filePath": "/repo/README.md",
  "content": "# Project\n\nUpdated.",
  "structuredPatch": [],
  "originalFile": "# Project\n\nOld."
}
```

**特殊行為 / 限制**：覆寫式寫入；通常搭配 `acceptEdits` 或明確 allow 控制。citeturn41view0turn42view0  

**權限 / 可用性**：`acceptEdits` 會自動核准 Write。citeturn41view0turn41view1  

**官方來源**：citeturn37view0turn42view0  

### Glob

**工具名稱**：`Glob`citeturn13view4turn42view0  

**用途簡述**：以 glob pattern 快速列出檔案路徑，可指定搜尋路徑；回傳檔名、數量、耗時與是否 truncated。citeturn13view4turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "GlobInput",
  "type": "object",
  "required": ["pattern"],
  "properties": {
    "pattern": { "type": "string" },
    "path": { "type": "string", "description": "可選搜尋目錄；官方註解：省略即用預設目錄，勿傳 null/undefined 字串" }
  }
}
```
citeturn37view0turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "GlobOutput",
  "type": "object",
  "required": ["durationMs", "numFiles", "filenames", "truncated"],
  "properties": {
    "durationMs": { "type": "number" },
    "numFiles": { "type": "number" },
    "filenames": { "type": "array", "items": { "type": "string" } },
    "truncated": { "type": "boolean" }
  }
}
```
citeturn42view0  

**Example**
```json
{ "tool": "Glob", "input": { "pattern": "**/*.py", "path": "/repo" } }
```

```json
{ "durationMs": 12, "numFiles": 3, "filenames": ["/repo/a.py", "/repo/b.py", "/repo/c.py"], "truncated": false }
```

**特殊行為 / 限制**：適合大 codebase 的檔案匹配；結果排序為「依修改時間」的說明見 TS 參考。citeturn42view0  

**權限 / 可用性**：通常低風險（讀取型）。citeturn18view0turn41view2  

**官方來源**：citeturn37view0turn42view0  

### Grep

**工具名稱**：`Grep`citeturn13view4turn37view1turn42view0  

**用途簡述**：基於 ripgrep 的強力搜尋工具，支援 regex、多種輸出模式（content/files/count）、context、行號、大小寫、檔案類型、multiline 等。citeturn37view1turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "GrepInput",
  "type": "object",
  "required": ["pattern"],
  "properties": {
    "pattern": { "type": "string", "description": "regex pattern" },
    "path": { "type": "string" },
    "glob": { "type": "string" },
    "type": { "type": "string", "description": "rg --type" },
    "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"] },
    "-B": { "type": "number" },
    "-A": { "type": "number" },
    "-C": { "type": "number" },
    "context": { "type": "number" },
    "-n": { "type": "boolean", "description": "僅對 content 模式生效；官方註解：預設 true" },
    "-i": { "type": "boolean" },
    "head_limit": { "type": "number", "description": "官方註解：預設 250；0 表示不限制（慎用）" },
    "offset": { "type": "number", "description": "跳過前 N 筆後再套 head_limit；官方註解：預設 0" },
    "multiline": { "type": "boolean", "description": "官方註解：預設 false；對應 rg -U --multiline-dotall" }
  }
}
```
citeturn37view1turn42view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "GrepOutput",
  "type": "object",
  "required": ["numFiles", "filenames"],
  "properties": {
    "mode": { "type": "string", "enum": ["content", "files_with_matches", "count"] },
    "numFiles": { "type": "number" },
    "filenames": { "type": "array", "items": { "type": "string" } },
    "content": { "type": "string" },
    "numLines": { "type": "number" },
    "numMatches": { "type": "number" },
    "appliedLimit": { "type": "number" },
    "appliedOffset": { "type": "number" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "Grep",
  "input": {
    "pattern": "TODO\\(",
    "path": "/repo",
    "output_mode": "files_with_matches",
    "head_limit": 50
  }
}
```

```json
{
  "mode": "files_with_matches",
  "numFiles": 2,
  "filenames": ["/repo/a.py", "/repo/b.py"],
  "appliedLimit": 50,
  "appliedOffset": 0
}
```

**特殊行為 / 限制**：`head_limit=0` 代表不限制，但會快速吃掉 context window；應視為「高成本查詢」。citeturn37view1turn16view0  

**權限 / 可用性**：通常低風險；建議預設 allow（特別在 `dontAsk` headless 場景）。citeturn41view2turn18view0  

**官方來源**：citeturn37view1turn42view0  

### NotebookEdit

**工具名稱**：`NotebookEdit`citeturn37view1turn42view0  

**用途簡述**：編輯 Jupyter notebook cell（replace/insert/delete），可指定 cell_id 與 cell_type；回傳更新結果與原/新檔案內容。citeturn37view1turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "NotebookEditInput",
  "type": "object",
  "required": ["notebook_path", "new_source"],
  "properties": {
    "notebook_path": { "type": "string", "description": "notebook 路徑（官方註解：absolute）" },
    "cell_id": { "type": "string", "description": "要編輯/插入位置的 cell id" },
    "new_source": { "type": "string" },
    "cell_type": { "type": "string", "enum": ["code", "markdown"] },
    "edit_mode": { "type": "string", "enum": ["replace", "insert", "delete"] }
  }
}
```
citeturn37view1  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "NotebookEditOutput",
  "type": "object",
  "required": ["new_source", "cell_type", "language", "edit_mode", "notebook_path", "original_file", "updated_file"],
  "properties": {
    "new_source": { "type": "string" },
    "cell_id": { "type": "string" },
    "cell_type": { "type": "string", "enum": ["code", "markdown"] },
    "language": { "type": "string" },
    "edit_mode": { "type": "string" },
    "error": { "type": "string" },
    "notebook_path": { "type": "string" },
    "original_file": { "type": "string" },
    "updated_file": { "type": "string" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "NotebookEdit",
  "input": {
    "notebook_path": "/repo/analysis.ipynb",
    "cell_id": "cell-3",
    "new_source": "print('hello')\n",
    "cell_type": "code",
    "edit_mode": "replace"
  }
}
```

```json
{
  "new_source": "print('hello')\n",
  "cell_id": "cell-3",
  "cell_type": "code",
  "language": "python",
  "edit_mode": "replace",
  "notebook_path": "/repo/analysis.ipynb",
  "original_file": "{...}",
  "updated_file": "{...}"
}
```

**特殊行為 / 限制**：insert 模式若未指定 cell_type，官方註解指出其為 required。citeturn37view1  

**權限 / 可用性**：屬寫入型工具，建議納入 `acceptEdits` 或明確 allow。citeturn41view0turn18view0  

**官方來源**：citeturn37view1turn42view0  

### WebFetch

**工具名稱**：`WebFetch`citeturn13view4turn42view0  

**用途簡述**：抓取指定 URL 的內容並回傳結果與 HTTP metadata。citeturn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WebFetchInput",
  "type": "object",
  "required": ["url", "prompt"],
  "properties": {
    "url": { "type": "string" },
    "prompt": { "type": "string", "description": "對抓取內容要執行的處理/摘要指令" }
  }
}
```
citeturn37view1turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WebFetchOutput",
  "type": "object",
  "required": ["bytes", "code", "codeText", "result", "durationMs", "url"],
  "properties": {
    "bytes": { "type": "number" },
    "code": { "type": "number" },
    "codeText": { "type": "string" },
    "result": { "type": "string" },
    "durationMs": { "type": "number" },
    "url": { "type": "string" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "WebFetch",
  "input": {
    "url": "https://example.com/spec",
    "prompt": "Extract the key requirements and return them as bullet points."
  }
}
```

```json
{
  "bytes": 12345,
  "code": 200,
  "codeText": "OK",
  "result": "Key requirements:\n- ...",
  "durationMs": 842,
  "url": "https://example.com/spec"
}
```

**特殊行為 / 限制**：屬 server-side/對外存取工具，通常會納入額外 usage 統計（見 AgentOutput.usage.server_tool_use）。citeturn42view0  

**權限 / 可用性**：可透過 allow/deny 與 `tools` 限定模型是否能看到/呼叫 WebFetch。citeturn41view3turn18view0  

**官方來源**：citeturn13view4turn42view0  

### WebSearch

**工具名稱**：`WebSearch`citeturn13view4turn42view0  

**用途簡述**：網路搜尋並回傳格式化結果，支援 domain allow/block。citeturn42view0turn37view1  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WebSearchInput",
  "type": "object",
  "required": ["query"],
  "properties": {
    "query": { "type": "string" },
    "allowed_domains": { "type": "array", "items": { "type": "string" } },
    "blocked_domains": { "type": "array", "items": { "type": "string" } }
  }
}
```
citeturn37view1turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WebSearchOutput",
  "type": "object",
  "required": ["query", "results", "durationSeconds"],
  "properties": {
    "query": { "type": "string" },
    "results": {
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "required": ["tool_use_id", "content"],
            "properties": {
              "tool_use_id": { "type": "string" },
              "content": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": ["title", "url"],
                  "properties": { "title": { "type": "string" }, "url": { "type": "string" } }
                }
              }
            }
          },
          { "type": "string" }
        ]
      }
    },
    "durationSeconds": { "type": "number" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "WebSearch",
  "input": { "query": "Claude Agent SDK built-in tools", "allowed_domains": ["platform.claude.com"] }
}
```

```json
{
  "query": "Claude Agent SDK built-in tools",
  "results": [
    {
      "tool_use_id": "tooluse_1",
      "content": [{ "title": "Agent SDK reference - TypeScript", "url": "https://platform.claude.com/..." }]
    }
  ],
  "durationSeconds": 1.2
}
```

**特殊行為 / 限制**：可用 allow/block domains 做企業內控；也可在 permissions 層做 deny。citeturn37view1turn18view0  

**權限 / 可用性**：若要「完全禁用網路能力」，除了 deny 規則外，更建議 `tools` 直接移除 WebSearch/WebFetch，避免模型浪費回合嘗試。citeturn41view3  

**官方來源**：citeturn37view1turn42view0  

### TodoWrite

**工具名稱**：`TodoWrite`citeturn13view4turn42view0  

**用途簡述**：建立/更新結構化 todo list，回傳更新前後列表（利於可觀測性與進度追蹤）。citeturn42view0turn37view1  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TodoWriteInput",
  "type": "object",
  "required": ["todos"],
  "properties": {
    "todos": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["content", "status", "activeForm"],
        "properties": {
          "content": { "type": "string" },
          "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] },
          "activeForm": { "type": "string" }
        }
      }
    }
  }
}
```
citeturn37view1turn42view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TodoWriteOutput",
  "type": "object",
  "required": ["oldTodos", "newTodos"],
  "properties": {
    "oldTodos": { "type": "array", "items": { "type": "object" } },
    "newTodos": { "type": "array", "items": { "type": "object" } }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "TodoWrite",
  "input": {
    "todos": [
      { "content": "Run tests", "status": "in_progress", "activeForm": "Running tests" },
      { "content": "Fix bug", "status": "pending", "activeForm": "Fixing bug" }
    ]
  }
}
```

```json
{
  "oldTodos": [],
  "newTodos": [
    { "content": "Run tests", "status": "in_progress", "activeForm": "Running tests" },
    { "content": "Fix bug", "status": "pending", "activeForm": "Fixing bug" }
  ]
}
```

**特殊行為 / 限制**：屬 workflow 工具，重點在一致性與可追蹤性（對企業整合很友善：能做審計/報表）。citeturn42view0turn33search12  

**權限 / 可用性**：低風險，但仍可用 allow/deny 控制是否允許模型自動維護 todo。citeturn18view0turn41view2  

**官方來源**：citeturn37view1turn42view0  

### ExitPlanMode

**工具名稱**：`ExitPlanMode`citeturn42view0turn37view0  

**用途簡述**：退出 planning mode；可選帶入 `allowedPrompts`（以 prompt-based 的方式表示執行方案所需權限）。citeturn42view0turn37view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExitPlanModeInput",
  "type": "object",
  "properties": {
    "allowedPrompts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["tool", "prompt"],
        "properties": {
          "tool": { "type": "string", "enum": ["Bash"] },
          "prompt": { "type": "string", "description": "語意描述 actions（例：run tests, install dependencies）" }
        }
      }
    }
  },
  "additionalProperties": true
}
```
citeturn37view0turn42view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExitPlanModeOutput",
  "type": "object",
  "required": ["plan", "isAgent"],
  "properties": {
    "plan": { "type": ["string", "null"] },
    "isAgent": { "type": "boolean" },
    "filePath": { "type": "string" },
    "hasTaskTool": { "type": "boolean" },
    "awaitingLeaderApproval": { "type": "boolean" },
    "requestId": { "type": "string" }
  }
}
```
citeturn42view0  

**Example**
```json
{
  "tool": "ExitPlanMode",
  "input": {
    "allowedPrompts": [
      { "tool": "Bash", "prompt": "run tests" },
      { "tool": "Bash", "prompt": "install dependencies" }
    ]
  }
}
```

```json
{
  "plan": "1) Install deps 2) Run tests 3) Fix failures",
  "isAgent": true,
  "awaitingLeaderApproval": false
}
```

**特殊行為 / 限制**：`allowedPrompts` 是「類別化權限需求」而非具體命令 allowlist，適合企業治理與人審流程。citeturn37view0turn42view0  

**權限 / 可用性**：planning mode 本身屬「不執行工具」治理策略；permissions 文件明示 `plan` 模式「No tool execution」。citeturn41view1turn18view0  

**官方來源**：citeturn37view0turn42view0turn18view0  

### Config

**工具名稱**：`Config`citeturn42view0turn17view0  

**用途簡述**：取得或設定一個 configuration 值（key-value）。citeturn42view0turn17view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ConfigInput",
  "type": "object",
  "required": ["setting"],
  "properties": {
    "setting": { "type": "string" },
    "value": { "type": ["string", "boolean", "number"], "description": "若省略 value 則為 get；提供 value 則為 set（語意見 output.operation）" }
  }
}
```
citeturn42view0turn17view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ConfigOutput",
  "type": "object",
  "required": ["success"],
  "properties": {
    "success": { "type": "boolean" },
    "operation": { "type": "string", "enum": ["get", "set"] },
    "setting": { "type": "string" },
    "value": {},
    "previousValue": {},
    "newValue": {},
    "error": { "type": "string" }
  }
}
```
citeturn17view0  

**Example**
```json
{ "tool": "Config", "input": { "setting": "permissionMode", "value": "dontAsk" } }
```

```json
{ "success": true, "operation": "set", "setting": "permissionMode", "previousValue": "default", "newValue": "dontAsk" }
```

**特殊行為 / 限制**：Config 的 value 是 `unknown` 型別（回傳面）；因此企業側應自行做 schema/型別收斂。citeturn17view0turn42view0  

**權限 / 可用性**：屬治理/設定工具，若要避免模型自行改變控制平面，建議默認 deny 或 `tools` 移除。citeturn41view3turn18view0  

**官方來源**：citeturn42view0turn17view0  

### EnterWorktree

**工具名稱**：`EnterWorktree`citeturn42view0turn17view0  

**用途簡述**：建立並進入暫存 git worktree，以隔離方式工作；回傳 worktree 路徑與訊息。citeturn42view0turn17view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EnterWorktreeInput",
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "可選 worktree 名稱" }
  }
}
```
citeturn42view0turn17view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EnterWorktreeOutput",
  "type": "object",
  "required": ["worktreePath", "message"],
  "properties": {
    "worktreePath": { "type": "string" },
    "worktreeBranch": { "type": "string" },
    "message": { "type": "string" }
  }
}
```
citeturn17view0  

**Example**
```json
{ "tool": "EnterWorktree", "input": { "name": "fix-auth-bug" } }
```

```json
{ "worktreePath": "/tmp/worktrees/fix-auth-bug", "worktreeBranch": "fix-auth-bug", "message": "Entered worktree" }
```

**特殊行為 / 限制**：適合把高風險的寫入/命令操作限制在隔離副本，降低「誤傷主分支」機率（仍需配合權限策略才算真正內控）。citeturn17view0turn18view0  

**權限 / 可用性**：若要大規模自動化修改 repo，建議將 `EnterWorktree` 與 `acceptEdits` 組合為預設策略之一。citeturn41view0turn17view0  

**官方來源**：citeturn42view0turn17view0  

### ExitWorktree

**工具名稱**：`ExitWorktree`citeturn30view0  

**用途簡述**：退出/清理 worktree（存在於官方 `sdk-tools.d.ts` 的 tool union 中）。citeturn30view0  

**Input JSON Schema（unspecified）**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExitWorktreeInput",
  "description": "此 tool 在官方 sdk-tools union 中可見，但本次可取得之官方參考頁面/片段未揭示其 Input 欄位；故標註 unspecified。",
  "type": "object",
  "additionalProperties": true
}
```
citeturn30view0  

**Output JSON Schema（unspecified）**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExitWorktreeOutput",
  "description": "同上：可見於 tool union，但缺少可核對之 output schema 來源片段，故標註 unspecified。",
  "type": ["object", "string", "null"],
  "additionalProperties": true
}
```
citeturn30view0  

**Example**
```json
{ "tool": "ExitWorktree", "input": {} }
```

```json
{ "unspecified": true }
```

**特殊行為 / 限制**：建議在自動化流程末端清理隔離環境，避免 worktree 堆積造成磁碟與 session 混亂（但具體參數未公開，故不推測）。citeturn30view0turn18view0  

**權限 / 可用性**：屬環境控制類工具；建議由 host 應用層或 hooks 做治理。citeturn18view0  

**官方來源**：citeturn30view0  

### ListMcpResources

**工具名稱**：`ListMcpResources`citeturn42view0turn13view4turn17view0  

**用途簡述**：列出已連接 MCP server 所提供的資源（resources）。citeturn42view0turn17view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ListMcpResourcesInput",
  "type": "object",
  "properties": {
    "server": { "type": "string", "description": "可選：指定 server 過濾" }
  }
}
```
citeturn42view0turn13view4  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ListMcpResourcesOutput",
  "type": "array",
  "items": {
    "type": "object",
    "required": ["uri", "name", "server"],
    "properties": {
      "uri": { "type": "string" },
      "name": { "type": "string" },
      "mimeType": { "type": "string" },
      "description": { "type": "string" },
      "server": { "type": "string" }
    }
  }
}
```
citeturn17view0turn42view0  

**Example**
```json
{ "tool": "ListMcpResources", "input": { "server": "enterprise-tools" } }
```

```json
[
  { "uri": "resource://docs/123", "name": "Spec", "mimeType": "text/markdown", "server": "enterprise-tools" }
]
```

**特殊行為 / 限制**：這是 MCP resource 面，不等同 MCP tools（工具呼叫）。citeturn17view0turn41view3  

**權限 / 可用性**：可用 `allowedTools`/`disallowedTools` 控制其是否自動核准；也可用 `tools` 移除內建工具但 MCP 工具不受 `tools` 影響。citeturn41view3turn18view0  

**官方來源**：citeturn13view4turn17view0turn42view0  

### ReadMcpResource

**工具名稱**：`ReadMcpResource`citeturn42view0turn17view0turn13view4  

**用途簡述**：讀取某 MCP resource 的內容。citeturn17view0turn42view0  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ReadMcpResourceInput",
  "type": "object",
  "required": ["server", "uri"],
  "properties": {
    "server": { "type": "string" },
    "uri": { "type": "string" }
  }
}
```
citeturn42view0turn37view1  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ReadMcpResourceOutput",
  "type": "object",
  "required": ["contents"],
  "properties": {
    "contents": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["uri"],
        "properties": {
          "uri": { "type": "string" },
          "mimeType": { "type": "string" },
          "text": { "type": "string" }
        }
      }
    }
  }
}
```
citeturn17view0  

**Example**
```json
{ "tool": "ReadMcpResource", "input": { "server": "enterprise-tools", "uri": "resource://docs/123" } }
```

```json
{ "contents": [{ "uri": "resource://docs/123", "mimeType": "text/markdown", "text": "# Spec\n..." }] }
```

**特殊行為 / 限制**：回傳 contents 可含 `text`，也可能僅有 metadata（取決於 resource）。citeturn17view0  

**權限 / 可用性**：同 MCP resource 類工具應依資料敏感度訂 allow/deny。citeturn18view0turn41view2  

**官方來源**：citeturn13view4turn17view0turn42view0  

### Mcp

**工具名稱**：`Mcp`citeturn30view0turn37view1  

**用途簡述**：在官方 `sdk-tools.d.ts` 的 tool union 中存在 `McpInput/McpOutput`，顯示 SDK/CLI 對「MCP 工具呼叫」存在一個泛型承接層；由於 MCP tool schema 是動態（依 server/tool 而定），此工具的 input schema 以 `additionalProperties` 的方式表示。citeturn30view0turn41view3turn37view1  

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "McpInput",
  "type": "object",
  "description": "Dynamic MCP tool call payload; schema depends on the selected MCP tool.",
  "additionalProperties": true
}
```
citeturn37view1turn30view0  

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "McpOutput",
  "type": "string",
  "description": "官方型別：MCP tool execution result = string"
}
```
citeturn30view0turn34view0  

**Example（示意：實際 MCP tool schema 依 server/tool 變動）**
```json
{
  "tool": "Mcp",
  "input": {
    "mcp__weather__get_temperature": { "latitude": 37.77, "longitude": -122.42 }
  }
}
```

```json
"Temperature: 65°F"
```

**特殊行為 / 限制**：企業實務上，MCP tools 的命名格式是 `mcp__{server_name}__{tool_name}`；可針對 server 使用 wildcard `mcp__server__*` 做批次允許。citeturn41view3turn19view0  

**權限 / 可用性**：`tools` 選項只影響「內建工具是否出現在上下文」，**不影響 MCP tools**；若要封鎖 MCP 需用 allow/deny 或 MCP server 層設定。citeturn41view3turn18view0  

**官方來源**：citeturn30view0turn37view1turn41view3  

### Skill

**工具名稱**：`Skill`citeturn43view1turn43view0  

**用途簡述**：啟用並讓模型能在需要時自動調用 Skills。SDK 對 Skills 的設計是「檔案系統資產」：需透過 `settingSources/setting_sources` 載入 `.claude/skills/` 或 `~/.claude/skills/`，且必須把 `"Skill"` 加入 `allowedTools/allowed_tools` 才會生效；SDK 不提供程式化註冊 Skills 的 API。citeturn43view1turn43view0  

**Input JSON Schema（unspecified）**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SkillInput",
  "description": "官方文件僅明示需在 allowedTools 中啟用 Skill tool，未公開其 tool-call 層的 input schema；故標註 unspecified。",
  "type": "object",
  "additionalProperties": true
}
```
citeturn43view1turn43view0  

**Output JSON Schema（unspecified）**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SkillOutput",
  "description": "官方文件未公開 Skill tool 的 tool-call 層 output schema；故標註 unspecified。",
  "type": ["object", "string", "array", "null"],
  "additionalProperties": true
}
```
citeturn43view1turn43view0  

**Example（概念層示意）**
```json
{ "tool": "Skill", "input": { "unspecified": true } }
```

```json
{ "unspecified": true }
```

**特殊行為 / 限制**：若 Skills 未生效，官方排查建議首先確認 `"Skill"` 是否在 `allowedTools`，以及是否設定 `settingSources`/`setting_sources`。citeturn43view1turn43view0  

**權限 / 可用性**：Skills 的工具限制（SKILL.md frontmatter `allowed-tools`）僅適用 Claude Code CLI，不適用 SDK；SDK 需在主查詢設定用 `allowedTools` 管控。citeturn43view2  

**官方來源**：citeturn43view1turn43view0turn43view2  

## MCP、自訂工具與「裸模式」注意事項

### MCP 工具命名、作用域與核准策略

官方定義 MCP 工具暴露給模型的命名格式為 `mcp__{server_name}__{tool_name}`；可以用 wildcard（例如 `mcp__weather__*`）在 `allowedTools` 內批次預核准整個 server。citeturn41view3turn19view0  

### `tools` 與 allow/deny 是兩個不同層

官方明確指出：

- `tools: ["Read","Grep"]` 會讓模型上下文中只保留這些內建工具（其它內建工具被移除）；MCP tools 不受影響。  
- `tools: []` 會移除所有內建工具，模型只能用 MCP tools（可視為接近「bare mode」的工具面）。citeturn41view3  

`allowedTools/disallowedTools` 則只影響「模型嘗試呼叫工具後，是否被核准/拒絕」。若你要降低回合浪費，應偏好 `tools` 做可見性控制。citeturn41view3turn41view2  

## 命名差異、別名與版本漂移

### 明示的官方別名與相容面

- `Agent` 工具：官方明示先前叫 `Task`，仍接受作別名。citeturn42view0  
- `TaskStop`：輸入型別包含 `shell_id` 並註明 deprecated（改用 `task_id`），顯示舊版以 shell_id 為識別的相容層仍存在。citeturn37view1turn13view4  

### Claude Code 的歷史命名調整

Claude Code release notes 中提到曾做工具命名一致性調整（例如 `View -> Read`、`LSTool -> LS`），這代表你在舊 wrapper/舊 transcript 可能仍會看到歷史命名。citeturn15search0  

### 「同名不同 schema」風險與治理建議

跨版本最常見的風險不是「工具消失」，而是「同一工具在不同版本新增欄位/改預設值」。例如：

- `ExitPlanModeInput` 在不同版本可能承載更多控制資訊（在某些型別檔可見額外欄位），而 TS 參考文件側以 `allowedPrompts` 為主。citeturn24view8turn42view0turn37view0  
- `sdk-tools.d.ts`（由 JSON schema 產生）常含關鍵限制註解，例如 PDF `pages` 單次最多 20 頁、Bash timeout 上限等；若你只看高層指南而略過型別檔，容易錯過硬限制。citeturn37view0turn13view4  

企業落地建議（務實版）：

1. 在 CI 內把「允許的 tool 名單」與「版本」鎖定（含 CLI/SDK 版本），把 schema 漂移變成可預測的變更管理，而不是線上事故。citeturn33search3turn15search0  
2. 對高風險工具（Bash/Write/Edit/Web*）同時用 `tools`（可見性）與 deny rules（硬拒絕）做雙層保護；權限這件事不能只靠「希望模型很乖」。citeturn41view3turn41view2turn18view0