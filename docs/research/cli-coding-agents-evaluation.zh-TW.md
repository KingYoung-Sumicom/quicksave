# CLI Coding Agent 接入評估報告

> 更新日期：2026-04-10（新增 Pi）

## 總覽

評估哪些 CLI coding agent 適合接入 quicksave web UI 架構。評估標準：headless/non-interactive 支援、接入機制（MCP/SDK/IPC）、streaming event 品質、社群活躍度。

---

## 比較表

| Agent | Headless | Streaming | MCP | SDK | 社群 | 評分 |
|---|---|---|---|---|---|---|
| **Amp** | 優秀 | 優秀（官方 SDK） | Client | 官方 TS+Python | Preview | 4.5 |
| **Gemini CLI** | 優秀 | NDJSON stream | Client | 討論中 | Google 官方 | 4.5 |
| **Goose** | 優秀 | SSE + stream-json | 深度整合 | REST API | 27K~40K stars | 4.0 |
| **OpenCode** | 優秀 | NDJSON (ACP) | Client | 官方 TS | 112K stars | 4.0 |
| **Pi** | 優秀 | JSON event stream | 無（刻意） | TS SDK + RPC | MIT, indie | 3.5 |
| **Aider** | 良好 | 純文字 stdout | 第三方 | Python API | 42K stars | 3.5 |
| **SWE-agent** | 良好 | 無 real-time | 無 | Python | 研究用途 | 2.5 |
| **Plandex** | 部分 | 不明確 | 無 | 無 | **已停服** | 1.0 |
| **Cursor/Windsurf** | 不支援 | 不支援 | 無 | 無 | GUI only | 1.0 |

---

## 各 Agent 詳細評估

### 1. Amp（Sourcegraph）⭐ 4.5/5

**簡介：** Sourcegraph 出品的 agentic coding tool，目前是 research preview 階段，主打 deep codebase understanding + agentic 執行。

**接入機制：**
- 官方 TypeScript SDK：`npm install @sourcegraph/amp-sdk`，有 Python SDK
- CLI `amp --execute "..." --stream-json`：官方支援的 programmatic 使用方式
- 支援 `--stream-json-input`（stdin 輸入 JSON）
- 支援 MCP server 設定

**Headless 支援：** 優秀，官方文件完整。

**Streaming：** 優秀，SDK 的 `execute()` 用 async generator 回傳 streaming messages，type-safe，設計最接近 Claude Agent SDK 的接入方式。

**社群狀況：** Sourcegraph 商業背景穩定，但 preview 階段，公開社群規模較小。

**備註：** 接入機制是評估中最完善的（官方 SDK + streaming JSON + MCP）。長期支援和授權模式仍待觀察。**建議優先接入。**

---

### 2. Gemini CLI（google-gemini/gemini-cli）⭐ 4.5/5

**簡介：** Google 官方出品，深度整合 Gemini 系列模型，支援 1M token context window。

**接入機制：**
- Headless/non-interactive mode：非 TTY 環境自動觸發，或 `gemini -p "..."` 執行
- 輸出格式：純文字 stdout streaming、JSON（完成後一次）、**NDJSON stream**（每行一個 event）
- 有討論中的官方 "Headless Coder SDK"（[Discussion #12794](https://github.com/google-gemini/gemini-cli/discussions/12794)）
- 支援 MCP server 作為 client

**Headless 支援：** 優秀，官方文件完整（headless mode reference）。

**Streaming：** 優秀，NDJSON stream 是程式整合的理想格式。

**社群狀況：** 非常活躍，Google 官方維護，版本迭代快速。

**備註：** 限定 Gemini 系列模型，適合接 Google 生態用戶。NDJSON streaming 對 quicksave 架構非常友好。

---

### 3. Goose（block/goose → Linux Foundation AAIF）⭐ 4.0/5

**簡介：** Block（Square 母公司）出品，現移交 Linux Foundation AAIF 維護。通用 AI agent，支援任意 LLM，MCP 最早採用者之一，有 70+ 官方 extensions。

**接入機制：**
- CLI headless mode：`goose run --headless`，支援 `-t "text"` / `-i file` / stdin 輸入
- 輸出格式：`text`、`json`、`stream-json`
- 後端有 `goosed` REST+SSE HTTP server（103 個 endpoints），desktop app 用此架構
- 有 ACP (Agent Client Protocol) server，支援 Zed/JetBrains 整合
- 深度 MCP ecosystem 整合

**Headless 支援：** 優秀，官方設計考慮了 CI/CD 和自動化場景。

**Streaming：** 良好，`stream-json` 輸出格式 + SSE（透過 goosed server）。

**社群狀況：** 非常活躍，27K~40K GitHub stars，373+ contributors，已入 Linux Foundation。

**備註：** `goosed` REST+SSE API 架構和 quicksave 現有的 daemon process + IPC 設計最接近，接入方式可以很自然。主要風險是移交 Linux Foundation 後維護節奏是否改變。

---

### 4. OpenCode（anomalyco/opencode）⭐ 4.0/5

**簡介：** SST 團隊出品（現改名 Anomaly），Go + TypeScript 架構，支援 75+ AI providers，TUI + server 雙模式。2026/01 爆紅，112K GitHub stars。

**接入機制：**
- `opencode serve` 啟動 headless HTTP server，有 OpenAPI spec（`/doc`）
- 官方 JS/TS SDK：`@opencode-ai/sdk`
- ACP server 模式（stdin/stdout NDJSON）
- 支援 MCP client（可接各種 MCP tools）
- 有社群 MCP server 讓其他 agent 反向控制 OpenCode

**Headless 支援：** 優秀，`opencode serve` 是設計重點。

**Streaming：** 良好，HTTP server + ACP NDJSON。

**社群狀況：** 112K stars，爆炸性成長，仍非常活躍。

**備註：** 架構上和 quicksave 的想法最接近（headless HTTP server + SDK），且 model-agnostic 是大優點。注意：Anthropic 曾封鎖透過 Claude Max subscription 路由的方式，用 Anthropic API key 則沒問題。

---

### 5. Pi（@mariozechner/pi-coding-agent）⭐ 3.5/5

**簡介：** 個人開發者 @mariozechner 出品的 minimal terminal coding harness，哲學是「primitives, not features」。MIT 授權，aggressively extensible，支援 15+ AI providers。

**接入機制：**
- **RPC mode**：JSON protocol over stdin/stdout，專為非 Node 系統程式控制設計，協定詳見 repo 內 `docs/rpc.md`
- **SDK mode**：可直接 embed 進應用程式（TypeScript），有 OpenClaw 作為實際案例
- **Print/JSON mode**：`pi -p "query" --mode json` 輸出 JSON event stream
- 安裝：`npm install -g @mariozechner/pi-coding-agent`

**Headless 支援：** 優秀，RPC mode 和 Print/JSON mode 都是官方設計的 programmatic 使用方式。

**Streaming：** 良好，`--mode json` 輸出 JSON event stream，有結構化格式。

**MCP：** 刻意不內建，哲學上不採用 MCP。可透過 TypeScript extension 自行加入，但不是 first-class feature。

**社群狀況：** Indie 開發者，MIT 授權，社群規模不明，無大公司背書。GitHub：`badlogic/pi-mono`。

**備註：** 架構最輕量，RPC stdin/stdout 接入方式和你的 daemon IPC 設計相容。缺乏 MCP 和大公司支撐是風險點。50+ 官方 extension 範例涵蓋 sub-agents、sandboxing、SSH execution，可借鑒設計思路。

---

### 6. Aider（aider-chat/aider）⭐ 3.5/5

**簡介：** 最老牌的 terminal AI pair programming 工具，以 git 整合和多檔案編輯著稱。Python 撰寫，支援幾乎所有 LLM。

**接入機制：**
- CLI `--message` 單次執行、`--yes-always` 自動確認、stdin pipe
- 有官方 scripting 文件，可用 Python 直接 import `aider` 套件
- 原生不內建 MCP server，第三方有 [aider-mcp-server](https://github.com/disler/aider-mcp-server)（WebSocket）
- GitHub issue #4506 要求官方 `--mcp-server` 模式，尚未合入

**Headless 支援：** 良好，`aider --message "..." --yes-always --no-git` 可完全 non-interactive 執行。

**Streaming：** 弱，有 stdout streaming 但無結構化 JSON event，只有純文字。

**社群狀況：** 非常活躍，~42,000 GitHub stars，快速 release，Aider 本身已能寫自身 72% 的程式碼更新。

**備註：** 最容易用 subprocess 包起來，但缺乏結構化 event 難以做細緻的 UI 整合（例如顯示哪個 tool call 正在執行）。MCP server 目前依賴第三方，穩定性存疑。**優先度較低，可後期補接。**

---

### 6. SWE-agent（SWE-agent/SWE-agent）⭐ 2.5/5

**簡介：** Princeton + Stanford 研究團隊出品，專為 SWE-bench 任務設計（自動修 GitHub issue、CTF、競程）。SWE-bench 上 SoTA 之一。

**接入機制：**
- Python 套件，可 `from sweagent import ...` 程式呼叫
- CLI `sweagent run`，支援 `--output-dir` 輸出 structured JSON trajectories
- 有 `mini-swe-agent`（100 行 Python，PyPI）：更容易 embed
- 無 MCP server，無 streaming event

**Headless 支援：** 良好，全程 non-interactive，適合批次/自動化。

**Streaming：** 弱，主要是批次執行後輸出 JSON trajectory，無 real-time event stream。

**社群狀況：** 研究導向，活躍但非 production tooling 生態。NeurIPS 2024 論文。

**備註：** 適合「送一個 GitHub issue URL，等它修完」的 batch 場景，不適合 real-time 互動 UI。

---

### 7. Plandex（plandex-ai/plandex）⭐ 1.0/5

**已停止服務（2025/10/03）。不建議接入。**

---

### 8. Cursor / Windsurf ⭐ 1.0/5

GUI IDE，無官方 CLI 或 headless mode，無法程式控制。Windsurf 已被 Cognition（Devin）以 $250M 收購（2026/02）。**不適合接入。**

---

## 建議接入優先順序

1. **Amp** — SDK 設計最接近現有 Claude Code 整合，streaming JSON event model 類似
2. **Gemini CLI** — NDJSON streaming 最規整，官方文件完整
3. **Goose 或 OpenCode** — 兩者都有 HTTP server 模式，Goose 的 daemon 架構更像 quicksave，OpenCode model-agnostic 優點更大
4. **Pi 或 Goose/OpenCode** — Pi 輕量且 RPC 接入乾淨，但缺乏社群支撐；Goose/OpenCode 較成熟
5. **Aider** — 可用 subprocess + Python API 包，但缺乏結構化 event，優先度較低

---

## 參考資料

- [Aider Scripting Docs](https://aider.chat/docs/scripting.html)
- [aider-mcp-server (disler)](https://github.com/disler/aider-mcp-server)
- [Gemini CLI Headless Mode](https://geminicli.com/docs/cli/headless/)
- [Gemini CLI Headless SDK Discussion](https://github.com/google-gemini/gemini-cli/discussions/12794)
- [Amp SDK Manual](https://ampcode.com/manual/sdk)
- [Amp Python SDK](https://ampcode.com/news/python-sdk)
- [Goose headless mode (DeepWiki)](https://deepwiki.com/block/goose/3.2-command-line-interface)
- [SWE-agent GitHub](https://github.com/SWE-agent/SWE-agent)
- [mini-swe-agent GitHub](https://github.com/SWE-agent/mini-swe-agent/)
- [OpenCode CLI docs](https://opencode.ai/docs/cli/)
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)
- [Pi Coding Agent](https://shittycodingagent.ai/) / [GitHub](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
