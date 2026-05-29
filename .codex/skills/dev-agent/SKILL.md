---
name: dev-agent
description: Restart the quicksave daemon from source in dev mode.
---

Follow the workflow in `.claude/commands/dev-agent.md`, but adapt any
machine-specific absolute paths to the current workspace.

For this repository, prefer running the daemon from `apps/agent` relative to
the repository root instead of using a hard-coded `/Users/...` or
`/home/...` path.
