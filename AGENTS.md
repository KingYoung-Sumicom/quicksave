# Quicksave Agent Instructions

@AGENTS_SHARED.md

## Codex Agent Notes

- Codex agents must follow their active runtime's own subagent/delegation rules.
- Do not assume Claude subagent names or delegation behavior.
- You are likely running inside a session that was started by the Quicksave agent.
- Restarting the Quicksave agent can kill your own active session. Do not keep
  restarting the agent, and do not restart it unless the user explicitly asks.
- When the user explicitly asks for an agent restart, use the provided restart
  script instead of calling service commands directly. Prefer
  `scripts/dev-daemon-delayed.sh` for development restarts.
