# CLI Coding Agent Integration Evaluation

> Last updated: 2026-04-10 (added Pi)

## Overview

Evaluation of which CLI coding agents are suitable for integrating into the quicksave web UI architecture. Evaluation criteria: headless/non-interactive support, integration mechanism (MCP/SDK/IPC), streaming event quality, and community activity.

---

## Comparison Table

| Agent | Headless | Streaming | MCP | SDK | Community | Score |
|---|---|---|---|---|---|---|
| **Amp** | Excellent | Excellent (official SDK) | Client | Official TS+Python | Preview | 4.5 |
| **Gemini CLI** | Excellent | NDJSON stream | Client | Under discussion | Official Google | 4.5 |
| **Goose** | Excellent | SSE + stream-json | Deep integration | REST API | 27K~40K stars | 4.0 |
| **OpenCode** | Excellent | NDJSON (ACP) | Client | Official TS | 112K stars | 4.0 |
| **Pi** | Excellent | JSON event stream | None (intentional) | TS SDK + RPC | MIT, indie | 3.5 |
| **Aider** | Good | Plain-text stdout | Third-party | Python API | 42K stars | 3.5 |
| **SWE-agent** | Good | No real-time | None | Python | Research-oriented | 2.5 |
| **Plandex** | Partial | Unclear | None | None | **Service shut down** | 1.0 |
| **Cursor/Windsurf** | Not supported | Not supported | None | None | GUI only | 1.0 |

---

## Detailed Per-Agent Evaluation

### 1. Amp (Sourcegraph) ⭐ 4.5/5

**Overview:** An agentic coding tool from Sourcegraph, currently in research preview. Its main selling points are deep codebase understanding plus agentic execution.

**Integration mechanism:**
- Official TypeScript SDK: `npm install @sourcegraph/amp-sdk`, with a Python SDK as well
- CLI `amp --execute "..." --stream-json`: officially supported programmatic usage
- Supports `--stream-json-input` (JSON input via stdin)
- Supports MCP server configuration

**Headless support:** Excellent, with thorough official documentation.

**Streaming:** Excellent. The SDK's `execute()` returns streaming messages via an async generator, type-safe, and is the closest in design to Claude Agent SDK's integration model.

**Community:** Sourcegraph provides a stable commercial backing, but it's still in preview and the public community is relatively small.

**Notes:** Among the agents evaluated, this has the most polished integration mechanism (official SDK + streaming JSON + MCP). Long-term support and licensing terms remain to be observed. **Recommended as a top integration priority.**

---

### 2. Gemini CLI (google-gemini/gemini-cli) ⭐ 4.5/5

**Overview:** Google's official offering, deeply integrated with the Gemini model family, with support for a 1M token context window.

**Integration mechanism:**
- Headless/non-interactive mode: triggered automatically in non-TTY environments, or invoked via `gemini -p "..."`
- Output formats: plain-text stdout streaming, JSON (delivered all at once on completion), **NDJSON stream** (one event per line)
- An official "Headless Coder SDK" is under discussion ([Discussion #12794](https://github.com/google-gemini/gemini-cli/discussions/12794))
- Supports MCP servers as a client

**Headless support:** Excellent, with thorough official documentation (headless mode reference).

**Streaming:** Excellent. The NDJSON stream is an ideal format for programmatic integration.

**Community:** Very active, officially maintained by Google, with a fast release cadence.

**Notes:** Limited to the Gemini model family, suitable for users in the Google ecosystem. The NDJSON streaming is very friendly to the quicksave architecture.

---

### 3. Goose (block/goose → Linux Foundation AAIF) ⭐ 4.0/5

**Overview:** From Block (Square's parent company), now handed over to the Linux Foundation AAIF for maintenance. A general-purpose AI agent that supports any LLM, one of the earliest MCP adopters, with 70+ official extensions.

**Integration mechanism:**
- CLI headless mode: `goose run --headless`, supporting `-t "text"` / `-i file` / stdin input
- Output formats: `text`, `json`, `stream-json`
- The backend has a `goosed` REST+SSE HTTP server (103 endpoints), which the desktop app uses
- Has an ACP (Agent Client Protocol) server, supporting Zed/JetBrains integration
- Deep MCP ecosystem integration

**Headless support:** Excellent. The official design accounted for CI/CD and automation scenarios.

**Streaming:** Good. `stream-json` output format plus SSE (via the goosed server).

**Community:** Very active, 27K~40K GitHub stars, 373+ contributors, now part of the Linux Foundation.

**Notes:** The `goosed` REST+SSE API architecture is the closest match to quicksave's existing daemon-process + IPC design, so integration can be very natural. The main risk is whether the maintenance cadence will change after the Linux Foundation handover.

---

### 4. OpenCode (anomalyco/opencode) ⭐ 4.0/5

**Overview:** From the SST team (now renamed Anomaly). Go + TypeScript architecture, supports 75+ AI providers, with both TUI and server modes. Went viral in 2026/01 with 112K GitHub stars.

**Integration mechanism:**
- `opencode serve` launches a headless HTTP server, with an OpenAPI spec at `/doc`
- Official JS/TS SDK: `@opencode-ai/sdk`
- ACP server mode (stdin/stdout NDJSON)
- Supports MCP client (can connect to various MCP tools)
- A community MCP server lets other agents control OpenCode in reverse

**Headless support:** Excellent. `opencode serve` is a design focus.

**Streaming:** Good. HTTP server + ACP NDJSON.

**Community:** 112K stars, explosive growth, still very active.

**Notes:** Architecturally the closest to quicksave's vision (headless HTTP server + SDK), and being model-agnostic is a major plus. Note: Anthropic has previously blocked routing through Claude Max subscriptions; using an Anthropic API key works fine.

---

### 5. Pi (@mariozechner/pi-coding-agent) ⭐ 3.5/5

**Overview:** A minimal terminal coding harness from indie developer @mariozechner, with the philosophy "primitives, not features". MIT licensed, aggressively extensible, supports 15+ AI providers.

**Integration mechanism:**
- **RPC mode**: JSON protocol over stdin/stdout, designed for non-Node systems to control programmatically; protocol details in the repo's `docs/rpc.md`
- **SDK mode**: can be embedded directly into applications (TypeScript), with OpenClaw as a real-world example
- **Print/JSON mode**: `pi -p "query" --mode json` outputs a JSON event stream
- Install: `npm install -g @mariozechner/pi-coding-agent`

**Headless support:** Excellent. RPC mode and Print/JSON mode are both officially designed programmatic usage paths.

**Streaming:** Good. `--mode json` outputs a JSON event stream with a structured format.

**MCP:** Intentionally not built in; philosophically does not adopt MCP. Can be added via TypeScript extensions, but it's not a first-class feature.

**Community:** Indie developer, MIT licensed, community size unclear, no big-company backing. GitHub: `badlogic/pi-mono`.

**Notes:** The lightest architecture; the RPC stdin/stdout integration model is compatible with your daemon IPC design. Lack of MCP and big-company backing are risk factors. The 50+ official extension samples cover sub-agents, sandboxing, and SSH execution, providing useful design references.

---

### 6. Aider (aider-chat/aider) ⭐ 3.5/5

**Overview:** The longest-standing terminal AI pair-programming tool, known for its git integration and multi-file editing. Written in Python, supports nearly every LLM.

**Integration mechanism:**
- CLI `--message` for one-shot execution, `--yes-always` for auto-confirm, stdin pipe support
- Has official scripting docs; you can `import aider` directly from Python
- No native MCP server; a third-party [aider-mcp-server](https://github.com/disler/aider-mcp-server) exists (WebSocket)
- GitHub issue #4506 requests an official `--mcp-server` mode, not yet merged

**Headless support:** Good. `aider --message "..." --yes-always --no-git` runs fully non-interactively.

**Streaming:** Weak. There is stdout streaming but no structured JSON events — only plain text.

**Community:** Very active, ~42,000 GitHub stars, fast release cadence; Aider already writes 72% of its own code updates.

**Notes:** The easiest to wrap as a subprocess, but the lack of structured events makes fine-grained UI integration difficult (e.g. showing which tool call is currently executing). The MCP server currently depends on a third party, with questionable stability. **Lower priority; can be integrated later.**

---

### 6. SWE-agent (SWE-agent/SWE-agent) ⭐ 2.5/5

**Overview:** From a Princeton + Stanford research team, designed specifically for SWE-bench tasks (auto-fix GitHub issues, CTF, competitive programming). One of the SoTA results on SWE-bench.

**Integration mechanism:**
- Python package, callable programmatically via `from sweagent import ...`
- CLI `sweagent run`, supports `--output-dir` to emit structured JSON trajectories
- A `mini-swe-agent` exists (100 lines of Python, on PyPI): easier to embed
- No MCP server, no streaming events

**Headless support:** Good. Fully non-interactive end-to-end, suitable for batch/automation.

**Streaming:** Weak. Primarily emits a JSON trajectory after batch execution, with no real-time event stream.

**Community:** Research-oriented, active but not part of a production tooling ecosystem. NeurIPS 2024 paper.

**Notes:** Suitable for "send a GitHub issue URL and wait until it's fixed" batch scenarios; not suitable for real-time interactive UIs.

---

### 7. Plandex (plandex-ai/plandex) ⭐ 1.0/5

**Service shut down (2025/10/03). Not recommended for integration.**

---

### 8. Cursor / Windsurf ⭐ 1.0/5

GUI IDEs, with no official CLI or headless mode and no programmatic control. Windsurf was acquired by Cognition (Devin) for $250M (2026/02). **Not suitable for integration.**

---

## Suggested Integration Priority

1. **Amp** — SDK design is the closest to the existing Claude Code integration; the streaming JSON event model is similar
2. **Gemini CLI** — Cleanest NDJSON streaming, with thorough official documentation
3. **Goose or OpenCode** — Both have HTTP server modes; Goose's daemon architecture is more like quicksave, while OpenCode's model-agnostic nature is a bigger advantage
4. **Pi or Goose/OpenCode** — Pi is lightweight with a clean RPC integration, but lacks community support; Goose/OpenCode are more mature
5. **Aider** — Can be wrapped via subprocess + Python API, but lack of structured events keeps it lower priority

---

## References

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
