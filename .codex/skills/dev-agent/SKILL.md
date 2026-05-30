---
name: dev-agent
description: Restart the quicksave daemon from source in dev mode.
---

Follow the workflow in `.claude/commands/dev-agent.md`.

For this repository, restart through `bash scripts/dev-daemon-delayed.sh <delay>`
from the repository root. The delayed restart is forced by default: daemon-owned
Claude / Codex sessions will be killed when the daemon exits. Pick a delay long
enough to return a final response before the restart fires.
