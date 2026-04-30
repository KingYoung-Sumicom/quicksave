# Complete Type Specification of Built-in Tools in Claude Code and the Claude Agent SDK

This report consolidates **every built-in tool type** in **Claude Code / Claude Agent SDK** (collectively "the SDK") that can be identified from the official documentation and the officially published type definitions, and provides a directly usable specification for each tool (purpose, input/output JSON Schema, examples, limits, permission considerations, and official sources). At a high level, the SDK's built-in tool surface can be grouped into eight categories: **Agent (sub-agent)**, **Shell (command execution)**, **File IO (file/Notebook/PDF)**, **Search (Grep/Glob/WebSearch)**, **Web (WebFetch/WebSearch)**, **Workflow (Todo/Plan/Config/AskUserQuestion)**, **MCP (resources and custom tools)**, and **Other (Skills)**. citeturn33search12turn42view0turn37view0turn41view3turn43view1

On the governance (permissions) side, treat tools as "not forbidden, but subject to internal controls first." The SDK's permission evaluation pipeline is clearly layered: **hooks → deny rules → permission mode → allow rules → canUseTool callback**; and `allowed_tools`/`disallowed_tools` only govern "auto-approve/auto-reject," **not** "whether a tool exists or appears in the model's context." If you want to "fundamentally hide certain built-in tools from the model," use the `tools` option to remove them — do not rely solely on deny rules. citeturn18view0turn41view3turn41view2

## Table of Contents

- [Coverage and Sources](#coverage-and-sources)
- [Tool Category Reference Table](#tool-category-reference-table)
- [Agent Loop and Permission Model](#agent-loop-and-permission-model)
- [Per-Tool Specifications](#per-tool-specifications)
- [MCP, Custom Tools, and "Bare Mode" Considerations](#mcp-custom-tools-and-bare-mode-considerations)
- [Naming Differences, Aliases, and Version Drift](#naming-differences-aliases-and-version-drift)

## Coverage and Sources

This report is based on two classes of "first-party sources":

- The official **TypeScript Agent SDK reference documentation** (including Tool Input/Output types and semantic descriptions). citeturn42view0turn13view4turn17view0
- The `sdk-tools.d.ts` file shipped inside the official package (available from the **Claude Code** package version page), which is explicitly annotated as generated from JSON Schema and contains numerous **constraints/comments** (e.g. Bash timeout upper bound, PDF pages capped at 20 per call, AskUserQuestion question/option counts, etc.). citeturn29view0turn37view0turn37view1turn38view0

The following official guides are used as supplementary normative references for "permissions/availability/Skills" and "custom tools": citeturn18view0turn41view3turn43view1turn43view0

> Important principle: when the official documentation does not explicitly specify a tool's input/output schema, this report marks it as **unspecified** (and does not invent fields). citeturn42view0turn43view1

## Tool Category Reference Table

The table below organizes built-in tools (those identifiable from official documentation and type definitions) from a "governance/risk" perspective. Tool names follow the **tool name as invoked**. citeturn42view0turn37view0turn30view0turn43view1

| Category | Tool (tool name) | Primary side-effect surface | Common limits/characteristics (excerpt) |
|---|---|---|---|
| Agent | `Agent` | Spawns/orchestrates sub-agents (can run in background) | `run_in_background` returns the output file path; `Agent` has a `Task` alias (still accepted) citeturn42view0 |
| Shell | `Bash`, `TaskOutput`, `TaskStop` | Run commands, stop background tasks | Bash timeout (ms) capped at 600000; background commands return a `backgroundTaskId`; `TaskStop` accepts `shell_id` but it is marked deprecated citeturn42view0turn37view0turn37view1 |
| File IO | `Read`, `Write`, `Edit` | Read/write/modify files | `Read.pages` applies to PDFs, max 20 pages per call; `Edit` performs exact string replacement; `Write` overwrites citeturn37view0turn42view0 |
| Repo/isolation | `EnterWorktree`, `ExitWorktree` | Create/exit a git worktree | `EnterWorktree` has input/output documented in the TS reference; `ExitWorktree` is visible in `sdk-tools.d.ts` but its schema is not exposed in the docs available for this pass (so marked unspecified) citeturn42view0turn30view0 |
| Local search | `Glob`, `Grep` | Read codebase structure/content | `Grep` is built on ripgrep and supports `output_mode`, context, `head_limit`, `multiline`, etc. citeturn37view1turn42view0 |
| Notebook | `NotebookEdit` | Modify `.ipynb` cells | Supports `replace/insert/delete`; returns original/updated file content citeturn37view1turn42view0 |
| Web | `WebSearch`, `WebFetch` | External network access | `WebSearch` supports domain allow/block; `WebFetch` returns HTTP code/bytes/duration citeturn37view1turn42view0 |
| Workflow | `TodoWrite`, `ExitPlanMode`, `AskUserQuestion`, `Config` | Task governance/interaction/configuration | `AskUserQuestion` requires 1–4 questions, 2–4 options, header ≤12 chars; `ExitPlanMode` may carry `allowedPrompts` citeturn37view1turn38view0turn42view0 |
| MCP | `ListMcpResources`, `ReadMcpResource`, `Mcp` | Connect external tools/resources | MCP tool name format is `mcp__{server}__{tool}`; `Mcp` is present in `sdk-tools.d.ts` but the schema is generic (dynamic) citeturn41view3turn37view1turn30view0turn17view0 |
| Other | `Skill` | Activate and invoke Skills (loaded from the filesystem) | You must put `"Skill"` in `allowedTools` and enable `settingSources`/`setting_sources` for Skills to load; the SDK does not provide a "programmatic Skill registration" API citeturn43view1turn43view0 |

## Agent Loop and Permission Model

### Lifecycle of a Tool Call inside the Agent Loop

The high-level flow of the SDK is: the model issues a tool request → the SDK evaluates permissions → if approved, the tool runs and a tool_result is returned → the next round begins, until completion or interruption. citeturn18view0turn41view3turn33search12

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

### Permission Evaluation Order and Internal-Control Notes

The SDK evaluates permissions in this order: **Hooks → Deny rules → Permission mode → Allow rules → canUseTool callback**. Deny rules (`disallowed_tools` or settings.json deny entries) can short-circuit the pipeline early, and they remain in effect even under `bypassPermissions` (deny takes precedence). citeturn18view0turn41view2

A few rules that frequently trip people up in practice:

- `allowed_tools` / `allowedTools` only adds entries to the allow rules; it **does not imply that other tools do not exist**. Tools that are not listed may still be attempted by the model and only then fall through to permission mode / `canUseTool`. citeturn41view2turn18view0
- If you want the model to "not even see" certain built-in tools, use `tools: [...]` to constrain the available set of built-in tools. `disallowedTools` only means "visible but always denied," which wastes turns. citeturn41view3turn18view0
- `acceptEdits` auto-approves file operations and a subset of filesystem commands (e.g. `mkdir/touch/rm/mv/cp`), but non-filesystem Bash still goes through the normal permission flow. citeturn41view0turn41view1

## Per-Tool Specifications

Each tool in this section provides:

- **Tool name**: canonical and aliases (when officially specified)
- **Purpose summary**
- **Input JSON Schema**: expressed as JSON Schema (draft 2020-12 style)
- **Output JSON Schema**
- **Example**: example input/output JSON (not equivalent to a full Messages API envelope; focused on the tool layer only)
- **Special behavior / limits**
- **Permissions / availability**
- **Official sources**: provided as citations

### Agent

**Tool name**: `Agent` (alias: `Task` is still accepted) citeturn42view0

**Purpose summary**: Launches a sub-agent to run a task. It can run in the background and track output via a file; the output distinguishes lifecycle states via `status` (completed, background-launched, or entered an interactive sub-agent). citeturn42view0turn37view0

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
      "description": "Short task description (official annotation: 3-5 words/tokens)"
    },
    "prompt": { "type": "string", "description": "The task content for the sub-agent to execute" },
    "subagent_type": { "type": "string", "description": "Sub-agent type/specialty" },
    "model": {
      "type": "string",
      "enum": ["sonnet", "opus", "haiku"],
      "description": "Optional model override; inherits from the parent if omitted"
    },
    "resume": { "type": "string", "description": "Resume an existing agentId (if supported)" },
    "run_in_background": { "type": "boolean", "description": "Run in background" },
    "max_turns": { "type": "number", "description": "Maximum number of agentic turns (annotated as internal use)" },
    "name": { "type": "string", "description": "Sub-agent name" },
    "team_name": { "type": "string", "description": "Team name (if team context is supported)" },
    "mode": {
      "type": "string",
      "enum": ["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan"],
      "description": "Sub-agent permission mode"
    },
    "isolation": {
      "type": "string",
      "enum": ["worktree"],
      "description": "Isolation mode: worktree (work inside an isolated copy)"
    }
  }
}
```
> Note: required/optional fields can vary slightly across versions; the schema above is based primarily on the official TS reference, with fields visible in `sdk-tools.d.ts` (e.g. `isolation: worktree`) folded in. citeturn42view0turn37view0

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
        "usage": { "type": "object", "description": "Token and server-tool-use statistics (fields per the official type)" },
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
citeturn42view0

**Example (input / output)**
```json
{
  "tool": "Agent",
  "input": {
    "description": "Fix login bug",
    "prompt": "Find and fix the bug in auth.py, and add tests.",
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
  "description": "Fix login bug",
  "prompt": "Find and fix the bug in auth.py, and add tests.",
  "outputFile": "/tmp/claude/agents/agent_123.out",
  "canReadOutputFile": true
}
```

**Special behavior / limits**: Background mode provides an `outputFile` for subsequent reads; the output's `status` distinguishes the lifecycle stage. citeturn42view0

**Permissions / availability**: `Agent` itself is also subject to the permission flow. If the parent agent uses `bypassPermissions`, the sub-agent inherits it without override — a risk that needs special governance. citeturn41view1turn18view0

**Official sources**: citeturn42view0turn37view0

### AskUserQuestion

**Tool name**: `AskUserQuestion` citeturn42view0turn37view1

**Purpose summary**: Mid-execution, asks the user 1–4 structured questions (each with 2–4 options, single- or multi-select) to clarify requirements or obtain approval. The output returns the questions along with the answers. citeturn42view0turn37view1turn38view0

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
          "question": { "type": "string", "description": "Full question sentence (official annotation: clear, specific, ending with ?)" },
          "header": { "type": "string", "maxLength": 12, "description": "Very short label (≤12 characters)" },
          "options": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "object",
              "required": ["label", "description"],
              "properties": {
                "label": { "type": "string", "description": "Option display text (official annotation: 1–5 words)" },
                "description": { "type": "string" },
                "preview": { "type": "string", "description": "Optional: preview content shown when focused (format per the official description)" }
              }
            }
          },
          "multiSelect": { "type": "boolean", "description": "If true, multiple selections are allowed" }
        }
      }
    }
  }
}
```
citeturn37view1turn38view0turn38view1turn42view0

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
      "description": "Answers returned as key-value pairs (value is a string). The concatenation format for multiSelect answers is not specified in this type fragment in the official docs, so we do not speculate."
    }
  }
}
```
citeturn42view0turn37view1turn38view0

**Example**
```json
{
  "tool": "AskUserQuestion",
  "input": {
    "questions": [
      {
        "question": "Which authentication method should we use?",
        "header": "Auth",
        "options": [
          { "label": "JWT", "description": "Stateless, suitable for APIs" },
          { "label": "Session", "description": "Server-side session, easier to revoke" }
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
      "question": "Which authentication method should we use?",
      "header": "Auth",
      "options": [
        { "label": "JWT", "description": "Stateless, suitable for APIs" },
        { "label": "Session", "description": "Server-side session, easier to revoke" }
      ],
      "multiSelect": false
    }
  ],
  "answers": {
    "Auth": "JWT"
  }
}
```

**Special behavior / limits**: 1–4 questions, 2–4 options, header ≤12 characters; a `preview` may be provided to aid comparison. citeturn37view1turn38view0

**Permissions / availability**: AskUserQuestion is a classic "blocking interaction point." Under `dontAsk` mode, if it is not approved by an allow rule, it may be denied outright without reaching `canUseTool` (depending on the overall permission configuration). citeturn18view0turn41view1

**Official sources**: citeturn42view0turn37view1turn38view0

### Bash

**Tool name**: `Bash` citeturn42view0turn13view4turn37view0

**Purpose summary**: Runs commands inside a persistent shell session, with support for timeout, background execution, and (high-risk) sandbox disabling. citeturn13view4turn37view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BashInput",
  "type": "object",
  "required": ["command"],
  "properties": {
    "command": { "type": "string", "description": "The command to run" },
    "timeout": { "type": "number", "maximum": 600000, "description": "Milliseconds; cap of 600000" },
    "description": { "type": "string", "description": "Brief description of the command's purpose (the official docs include extensive guidance on phrasing)" },
    "run_in_background": { "type": "boolean", "description": "If true, runs in background; the output can be fetched later via TaskOutput" },
    "dangerouslyDisableSandbox": { "type": "boolean", "description": "If true, dangerously disables the sandbox (high risk)" }
  }
}
```
citeturn37view0turn13view4

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
    "structuredContent": { "type": "array", "items": {}, "description": "unknown[] (official type)" },
    "persistedOutputPath": { "type": "string" },
    "persistedOutputSize": { "type": "number" }
  }
}
```
citeturn42view0

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

**Special behavior / limits**: timeout cap of 600000ms; background commands return a `backgroundTaskId`. citeturn37view0turn42view0

**Permissions / availability**: Bash is typically one of the highest-risk tools. You can hard-disable it with `disallowed_tools=["Bash"]`; deny takes precedence in the flow and is effective across modes. citeturn41view2turn18view0

**Official sources**: citeturn37view0turn42view0

### TaskOutput

**Tool name**: `TaskOutput` (older versions or cross-document references may show `BashOutput` as the name of the "fetch output" tool; this report uses `TaskOutput` per the current TS reference) citeturn13view4turn37view0

**Purpose summary**: Fetches the output of a background task (e.g. background Bash) while it is still running or after it has completed. citeturn13view4turn37view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskOutputInput",
  "type": "object",
  "required": ["task_id", "block", "timeout"],
  "properties": {
    "task_id": { "type": "string", "description": "Background task ID" },
    "block": { "type": "boolean", "description": "Whether to wait until completion" },
    "timeout": { "type": "number", "description": "Wait cap (ms)" }
  }
}
```
citeturn37view0turn13view4

**Output JSON Schema** (unspecified)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskOutputOutput",
  "description": "TaskOutputInput is visible in the official TS reference, but the available ToolOutputSchemas fragment does not specify TaskOutput's return type; to avoid speculation, this is marked unspecified.",
  "type": ["object", "string", "array", "null"],
  "additionalProperties": true
}
```
citeturn13view4turn42view0

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

**Special behavior / limits**: Used in conjunction with `Bash.run_in_background`; `block` and `timeout` control the wait strategy. citeturn37view0turn13view4

**Permissions / availability**: Low side effect (reading output) but still a tool call; can be governed via allow/deny rules. citeturn41view2turn18view0

**Official sources**: citeturn13view4turn37view0turn42view0

### TaskStop

**Tool name**: `TaskStop` (the input type contains `shell_id` annotated as deprecated, indicating a back-compat surface for the older shell_id-based naming/parameters) citeturn13view4turn37view1

**Purpose summary**: Stops a background task (or a legacy shell). citeturn13view4turn42view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "TaskStopInput",
  "type": "object",
  "properties": {
    "task_id": { "type": "string", "description": "Background task ID" },
    "shell_id": { "type": "string", "description": "Deprecated: use task_id instead" }
  }
}
```
citeturn37view1turn13view4

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
citeturn42view0

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

**Special behavior / limits**: `shell_id` may still appear in the compatibility layer, but the official type marks it as deprecated. citeturn37view1turn13view4

**Permissions / availability**: Terminating a background process is a "control-class" operation; we recommend gating it via allow rules rather than letting the model terminate at will. citeturn41view2turn18view0

**Official sources**: citeturn13view4turn37view1turn42view0

### Edit

**Tool name**: `Edit` citeturn13view4turn42view0

**Purpose summary**: Performs an "exact string replacement" on a file, with an optional `replace_all`; returns a structured patch and (optionally) git diff information. citeturn13view4turn42view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileEditInput",
  "type": "object",
  "required": ["file_path", "old_string", "new_string"],
  "properties": {
    "file_path": { "type": "string", "description": "File path (official annotation: absolute path)" },
    "old_string": { "type": "string" },
    "new_string": { "type": "string", "description": "Must differ from old_string (official annotation)" },
    "replace_all": { "type": "boolean", "description": "Whether to replace all matches (default false)" }
  }
}
```
citeturn37view0turn13view4

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
citeturn42view0

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

**Special behavior / limits**: Edit is "exact string replacement," highly context-sensitive; the usual pattern is `Read` first, then `Edit`. citeturn13view4turn42view0

**Permissions / availability**: Under `acceptEdits` mode, file operations such as Edit/Write are auto-approved. citeturn41view0turn41view1

**Official sources**: citeturn13view4turn42view0turn41view0

### Read

**Tool name**: `Read` citeturn13view4turn42view0

**Purpose summary**: Reads a file (text, image, PDF, Notebook, etc.); the output's `type` distinguishes the kind. For PDFs, you can specify a page range with `pages`, capped at 20 pages per call. citeturn42view0turn13view4turn37view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileReadInput",
  "type": "object",
  "required": ["file_path"],
  "properties": {
    "file_path": { "type": "string", "description": "File path (official annotation: absolute path)" },
    "offset": { "type": "number", "description": "Starting line (only provide when the file is too large)" },
    "limit": { "type": "number", "description": "Number of lines to read (only provide when the file is too large)" },
    "pages": {
      "type": "string",
      "description": "PDF page range (e.g. \"1-5\", \"3\", \"10-20\"); max 20 pages per call (official annotation)"
    }
  }
}
```
citeturn13view4turn37view0

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
            "dimensions": { "type": "object", "description": "Optional dimensions info (official type)" }
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
citeturn42view0

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

**Special behavior / limits**: PDF `pages` is capped at 20 pages per call. citeturn37view0

**Permissions / availability**: Read is generally a low-risk tool and is commonly placed in `allowedTools`, but it still goes through the permission flow. citeturn41view2turn18view0

**Official sources**: citeturn42view0turn37view0turn13view4

### Write

**Tool name**: `Write` citeturn13view4turn42view0

**Purpose summary**: Writes a file (overwrites if it exists); returns create/update plus a structured patch. citeturn13view4turn42view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FileWriteInput",
  "type": "object",
  "required": ["file_path", "content"],
  "properties": {
    "file_path": { "type": "string", "description": "File path (official annotation: must be absolute)" },
    "content": { "type": "string" }
  }
}
```
citeturn37view0turn13view4

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
citeturn42view0

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

**Special behavior / limits**: Overwrite-style write; typically paired with `acceptEdits` or an explicit allow rule. citeturn41view0turn42view0

**Permissions / availability**: `acceptEdits` auto-approves Write. citeturn41view0turn41view1

**Official sources**: citeturn37view0turn42view0

### Glob

**Tool name**: `Glob` citeturn13view4turn42view0

**Purpose summary**: Lists file paths quickly using a glob pattern, with an optional search root; returns filenames, count, duration, and a truncation flag. citeturn13view4turn42view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "GlobInput",
  "type": "object",
  "required": ["pattern"],
  "properties": {
    "pattern": { "type": "string" },
    "path": { "type": "string", "description": "Optional search directory; official annotation: omit to use the default directory, do not pass the strings null/undefined" }
  }
}
```
citeturn37view0turn13view4

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
citeturn42view0

**Example**
```json
{ "tool": "Glob", "input": { "pattern": "**/*.py", "path": "/repo" } }
```

```json
{ "durationMs": 12, "numFiles": 3, "filenames": ["/repo/a.py", "/repo/b.py", "/repo/c.py"], "truncated": false }
```

**Special behavior / limits**: Suitable for file matching across large codebases; the TS reference notes that results are sorted by modification time. citeturn42view0

**Permissions / availability**: Generally low risk (read-only). citeturn18view0turn41view2

**Official sources**: citeturn37view0turn42view0

### Grep

**Tool name**: `Grep` citeturn13view4turn37view1turn42view0

**Purpose summary**: A powerful ripgrep-based search tool, supporting regex, multiple output modes (content/files/count), context, line numbers, case sensitivity, file types, multiline, and more. citeturn37view1turn42view0

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
    "-n": { "type": "boolean", "description": "Only effective in content mode; official annotation: defaults to true" },
    "-i": { "type": "boolean" },
    "head_limit": { "type": "number", "description": "Official annotation: defaults to 250; 0 means unlimited (use sparingly)" },
    "offset": { "type": "number", "description": "Skip the first N entries before applying head_limit; official annotation: defaults to 0" },
    "multiline": { "type": "boolean", "description": "Official annotation: defaults to false; corresponds to rg -U --multiline-dotall" }
  }
}
```
citeturn37view1turn42view0

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
citeturn42view0

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

**Special behavior / limits**: `head_limit=0` means unlimited but will quickly chew through the context window; treat it as a "high-cost query." citeturn37view1turn16view0

**Permissions / availability**: Generally low risk; we recommend allowing it by default (especially in `dontAsk` headless scenarios). citeturn41view2turn18view0

**Official sources**: citeturn37view1turn42view0

### NotebookEdit

**Tool name**: `NotebookEdit` citeturn37view1turn42view0

**Purpose summary**: Edits a Jupyter notebook cell (replace/insert/delete), with optional cell_id and cell_type; returns the update result along with the original/new file contents. citeturn37view1turn42view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "NotebookEditInput",
  "type": "object",
  "required": ["notebook_path", "new_source"],
  "properties": {
    "notebook_path": { "type": "string", "description": "Notebook path (official annotation: absolute)" },
    "cell_id": { "type": "string", "description": "ID of the cell to edit, or the insertion location" },
    "new_source": { "type": "string" },
    "cell_type": { "type": "string", "enum": ["code", "markdown"] },
    "edit_mode": { "type": "string", "enum": ["replace", "insert", "delete"] }
  }
}
```
citeturn37view1

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
citeturn42view0

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

**Special behavior / limits**: For insert mode, the official annotation states that cell_type is required if not specified. citeturn37view1

**Permissions / availability**: A write-class tool; recommended to put under `acceptEdits` or an explicit allow rule. citeturn41view0turn18view0

**Official sources**: citeturn37view1turn42view0

### WebFetch

**Tool name**: `WebFetch` citeturn13view4turn42view0

**Purpose summary**: Fetches the content of a given URL and returns the result along with HTTP metadata. citeturn42view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WebFetchInput",
  "type": "object",
  "required": ["url", "prompt"],
  "properties": {
    "url": { "type": "string" },
    "prompt": { "type": "string", "description": "The processing/summarization instruction to apply to the fetched content" }
  }
}
```
citeturn37view1turn13view4

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
citeturn42view0

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

**Special behavior / limits**: This is a server-side / outbound-access tool, and is typically tracked via additional usage statistics (see AgentOutput.usage.server_tool_use). citeturn42view0

**Permissions / availability**: Use allow/deny and `tools` to control whether the model can see/call WebFetch. citeturn41view3turn18view0

**Official sources**: citeturn13view4turn42view0

### WebSearch

**Tool name**: `WebSearch` citeturn13view4turn42view0

**Purpose summary**: Performs a web search and returns formatted results, with support for domain allow/block. citeturn42view0turn37view1

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
citeturn37view1turn13view4

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
citeturn42view0

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

**Special behavior / limits**: Domain allow/block can be used for enterprise internal control; deny rules are also available at the permission layer. citeturn37view1turn18view0

**Permissions / availability**: To "fully disable network capability," in addition to deny rules we recommend removing WebSearch/WebFetch directly via `tools`, so the model does not waste turns trying. citeturn41view3

**Official sources**: citeturn37view1turn42view0

### TodoWrite

**Tool name**: `TodoWrite` citeturn13view4turn42view0

**Purpose summary**: Creates/updates a structured todo list and returns both the prior and updated lists (helpful for observability and progress tracking). citeturn42view0turn37view1

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
citeturn37view1turn42view0

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
citeturn42view0

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

**Special behavior / limits**: A workflow tool — its value lies in consistency and traceability (very friendly for enterprise integration: enables auditing/reporting). citeturn42view0turn33search12

**Permissions / availability**: Low risk, but allow/deny can still be used to control whether the model is permitted to maintain todos automatically. citeturn18view0turn41view2

**Official sources**: citeturn37view1turn42view0

### ExitPlanMode

**Tool name**: `ExitPlanMode` citeturn42view0turn37view0

**Purpose summary**: Exits planning mode; can optionally include `allowedPrompts` (a prompt-based representation of the permissions required to execute the plan). citeturn42view0turn37view0

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
          "prompt": { "type": "string", "description": "Semantic description of actions (e.g. run tests, install dependencies)" }
        }
      }
    }
  },
  "additionalProperties": true
}
```
citeturn37view0turn42view0

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
citeturn42view0

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

**Special behavior / limits**: `allowedPrompts` represents "categorized permission requests" rather than a concrete-command allowlist, which fits enterprise governance and human review workflows. citeturn37view0turn42view0

**Permissions / availability**: Planning mode itself is a "do-not-execute-tools" governance posture; the permissions docs explicitly say `plan` mode means "No tool execution." citeturn41view1turn18view0

**Official sources**: citeturn37view0turn42view0turn18view0

### Config

**Tool name**: `Config` citeturn42view0turn17view0

**Purpose summary**: Gets or sets a configuration value (key-value). citeturn42view0turn17view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ConfigInput",
  "type": "object",
  "required": ["setting"],
  "properties": {
    "setting": { "type": "string" },
    "value": { "type": ["string", "boolean", "number"], "description": "Omitting value means get; supplying value means set (the semantics are reflected in output.operation)" }
  }
}
```
citeturn42view0turn17view0

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
citeturn17view0

**Example**
```json
{ "tool": "Config", "input": { "setting": "permissionMode", "value": "dontAsk" } }
```

```json
{ "success": true, "operation": "set", "setting": "permissionMode", "previousValue": "default", "newValue": "dontAsk" }
```

**Special behavior / limits**: Config's value is `unknown` on the return side; enterprises should narrow the schema/types themselves. citeturn17view0turn42view0

**Permissions / availability**: A governance/configuration tool — to prevent the model from changing its own control plane, default to deny or remove it via `tools`. citeturn41view3turn18view0

**Official sources**: citeturn42view0turn17view0

### EnterWorktree

**Tool name**: `EnterWorktree` citeturn42view0turn17view0

**Purpose summary**: Creates and enters a temporary git worktree to work in isolation; returns the worktree path and a message. citeturn42view0turn17view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EnterWorktreeInput",
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "Optional worktree name" }
  }
}
```
citeturn42view0turn17view0

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
citeturn17view0

**Example**
```json
{ "tool": "EnterWorktree", "input": { "name": "fix-auth-bug" } }
```

```json
{ "worktreePath": "/tmp/worktrees/fix-auth-bug", "worktreeBranch": "fix-auth-bug", "message": "Entered worktree" }
```

**Special behavior / limits**: A good fit for confining high-risk write/command operations to an isolated copy, lowering the chance of "collateral damage to the main branch" (this still must be paired with a permission policy to count as real internal control). citeturn17view0turn18view0

**Permissions / availability**: For large-scale automated repo modifications, consider combining `EnterWorktree` with `acceptEdits` as one of your default policies. citeturn41view0turn17view0

**Official sources**: citeturn42view0turn17view0

### ExitWorktree

**Tool name**: `ExitWorktree` citeturn30view0

**Purpose summary**: Exits/cleans up a worktree (present in the official `sdk-tools.d.ts` tool union). citeturn30view0

**Input JSON Schema (unspecified)**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExitWorktreeInput",
  "description": "This tool is visible in the official sdk-tools union, but the official reference pages/fragments available for this pass do not expose its Input fields, so it is marked unspecified.",
  "type": "object",
  "additionalProperties": true
}
```
citeturn30view0

**Output JSON Schema (unspecified)**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ExitWorktreeOutput",
  "description": "Same as above: visible in the tool union but missing a verifiable output-schema source fragment, so marked unspecified.",
  "type": ["object", "string", "null"],
  "additionalProperties": true
}
```
citeturn30view0

**Example**
```json
{ "tool": "ExitWorktree", "input": {} }
```

```json
{ "unspecified": true }
```

**Special behavior / limits**: Recommended for cleaning up the isolated environment at the end of an automated flow, to avoid worktree pile-up causing disk/session clutter (but the concrete parameters are not public, so we do not speculate). citeturn30view0turn18view0

**Permissions / availability**: An environment-control tool; governance is best handled at the host application layer or via hooks. citeturn18view0

**Official sources**: citeturn30view0

### ListMcpResources

**Tool name**: `ListMcpResources` citeturn42view0turn13view4turn17view0

**Purpose summary**: Lists the resources provided by connected MCP servers. citeturn42view0turn17view0

**Input JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ListMcpResourcesInput",
  "type": "object",
  "properties": {
    "server": { "type": "string", "description": "Optional: filter by a specific server" }
  }
}
```
citeturn42view0turn13view4

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
citeturn17view0turn42view0

**Example**
```json
{ "tool": "ListMcpResources", "input": { "server": "enterprise-tools" } }
```

```json
[
  { "uri": "resource://docs/123", "name": "Spec", "mimeType": "text/markdown", "server": "enterprise-tools" }
]
```

**Special behavior / limits**: This is the MCP resource surface, which is not the same as MCP tools (tool calls). citeturn17view0turn41view3

**Permissions / availability**: Use `allowedTools`/`disallowedTools` to govern whether it is auto-approved; you can also use `tools` to remove built-in tools — but MCP tools are not affected by `tools`. citeturn41view3turn18view0

**Official sources**: citeturn13view4turn17view0turn42view0

### ReadMcpResource

**Tool name**: `ReadMcpResource` citeturn42view0turn17view0turn13view4

**Purpose summary**: Reads the content of a given MCP resource. citeturn17view0turn42view0

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
citeturn42view0turn37view1

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
citeturn17view0

**Example**
```json
{ "tool": "ReadMcpResource", "input": { "server": "enterprise-tools", "uri": "resource://docs/123" } }
```

```json
{ "contents": [{ "uri": "resource://docs/123", "mimeType": "text/markdown", "text": "# Spec\n..." }] }
```

**Special behavior / limits**: The returned `contents` may include `text`, or only metadata (depending on the resource). citeturn17view0

**Permissions / availability**: As with other MCP resource tools, allow/deny should be set based on the data sensitivity. citeturn18view0turn41view2

**Official sources**: citeturn13view4turn17view0turn42view0

### Mcp

**Tool name**: `Mcp` citeturn30view0turn37view1

**Purpose summary**: The official `sdk-tools.d.ts` tool union contains `McpInput/McpOutput`, which shows that the SDK/CLI has a generic adapter layer for "MCP tool calls." Because the schema for an MCP tool is dynamic (it depends on the server/tool), this tool's input schema is expressed via `additionalProperties`. citeturn30view0turn41view3turn37view1

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
citeturn37view1turn30view0

**Output JSON Schema**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "McpOutput",
  "type": "string",
  "description": "Official type: MCP tool execution result = string"
}
```
citeturn30view0turn34view0

**Example (illustrative — actual MCP tool schema varies by server/tool)**
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

**Special behavior / limits**: In enterprise practice, MCP tools follow the naming format `mcp__{server_name}__{tool_name}`; for batch-allowing an entire server, use the wildcard `mcp__server__*`. citeturn41view3turn19view0

**Permissions / availability**: The `tools` option only affects "whether built-in tools appear in context" — it **does not affect MCP tools**. To block MCP tools, use allow/deny rules or configure the MCP server itself. citeturn41view3turn18view0

**Official sources**: citeturn30view0turn37view1turn41view3

### Skill

**Tool name**: `Skill` citeturn43view1turn43view0

**Purpose summary**: Activates Skills so the model can invoke them automatically when needed. The SDK treats Skills as "filesystem assets": they must be loaded via `settingSources/setting_sources` from `.claude/skills/` or `~/.claude/skills/`, and `"Skill"` must be added to `allowedTools/allowed_tools` for it to take effect. The SDK does not provide a programmatic API for registering Skills. citeturn43view1turn43view0

**Input JSON Schema (unspecified)**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SkillInput",
  "description": "The official documentation only states that the Skill tool must be enabled in allowedTools; it does not publish the input schema at the tool-call layer, so this is marked unspecified.",
  "type": "object",
  "additionalProperties": true
}
```
citeturn43view1turn43view0

**Output JSON Schema (unspecified)**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SkillOutput",
  "description": "The official documentation does not publish the output schema for the Skill tool at the tool-call layer; marked unspecified.",
  "type": ["object", "string", "array", "null"],
  "additionalProperties": true
}
```
citeturn43view1turn43view0

**Example (conceptual illustration)**
```json
{ "tool": "Skill", "input": { "unspecified": true } }
```

```json
{ "unspecified": true }
```

**Special behavior / limits**: If Skills do not take effect, the official troubleshooting suggestion is to first verify that `"Skill"` is in `allowedTools` and that `settingSources`/`setting_sources` is configured. citeturn43view1turn43view0

**Permissions / availability**: The tool restrictions inside a Skill (the SKILL.md frontmatter `allowed-tools`) only apply to the Claude Code CLI, not to the SDK. In the SDK you must control them via `allowedTools` on the main query. citeturn43view2

**Official sources**: citeturn43view1turn43view0turn43view2

## MCP, Custom Tools, and "Bare Mode" Considerations

### MCP Tool Naming, Scope, and Approval Strategy

The official naming format that exposes MCP tools to the model is `mcp__{server_name}__{tool_name}`; you can use a wildcard (e.g. `mcp__weather__*`) inside `allowedTools` to bulk pre-approve an entire server. citeturn41view3turn19view0

### `tools` and allow/deny Are Two Different Layers

The official documentation makes this explicit:

- `tools: ["Read","Grep"]` retains only those built-in tools in the model's context (others are removed); MCP tools are not affected.
- `tools: []` removes all built-in tools, leaving the model with only MCP tools (close to "bare mode" on the tool surface). citeturn41view3

`allowedTools/disallowedTools`, by contrast, only affects "whether the model's tool call attempt is approved or denied." To minimize wasted turns, prefer `tools` for visibility control. citeturn41view3turn41view2

## Naming Differences, Aliases, and Version Drift

### Officially Documented Aliases and Compatibility Surfaces

- `Agent` tool: officially documented as previously named `Task`, which is still accepted as an alias. citeturn42view0
- `TaskStop`: the input type contains `shell_id` annotated as deprecated (use `task_id` instead), showing that the legacy compatibility layer that identified shells via shell_id still exists. citeturn37view1turn13view4

### Historical Naming Adjustments in Claude Code

The Claude Code release notes mention prior tool-name normalization passes (e.g. `View -> Read`, `LSTool -> LS`), which means you may still see legacy names in older wrappers/transcripts. citeturn15search0

### "Same Name, Different Schema" Risks and Governance Recommendations

The most common cross-version risk is not "tools disappearing" but "the same tool gaining fields or changing defaults across versions." Examples:

- `ExitPlanModeInput` may carry additional control information across versions (some type files expose extra fields), while the TS reference primarily exposes `allowedPrompts`. citeturn24view8turn42view0turn37view0
- `sdk-tools.d.ts` (generated from JSON Schema) often contains critical limit annotations such as PDF `pages` capped at 20 per call or the Bash timeout cap; if you only read the high-level guides and skip the type files, you are likely to miss hard limits. citeturn37view0turn13view4

Practical enterprise rollout recommendations:

1. In CI, lock down both the "allowed tool list" and the "version" (including CLI/SDK version), turning schema drift into predictable change management rather than production incidents. citeturn33search3turn15search0
2. For high-risk tools (Bash/Write/Edit/Web*), apply both `tools` (visibility) and deny rules (hard refusal) as a two-layer defense; permissions cannot rely on "hoping the model behaves." citeturn41view3turn41view2turn18view0
