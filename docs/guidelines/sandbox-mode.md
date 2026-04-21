# Sandbox Mode

Quicksave runs coding-agent sessions inside a kernel-level sandbox by
default. This document captures what the sandbox does, when to turn it
off, and how the pieces fit together.

## Default behavior

- `DEFAULT_SANDBOXED = true` in `packages/shared/src/defaults.ts`.
- Every new task the PWA starts inherits that default; the per-session
  toggle (stored on `SessionRegistryEntry.sandboxed`) survives daemon
  restarts.
- Mid-task, the user can flip the toggle from the status bar
  (`SessionStatusBar.tsx`).

## What the sandbox enforces

When sandbox mode is ON, the agent process is confined along two axes:

1. **Filesystem writes** are restricted to the session's project
   directory (`cwd`). Writes outside it fail at the kernel level — the
   agent cannot silently mutate your home directory or an unrelated
   repo.
2. **Shell commands** run through the `SandboxBash` MCP tool instead of
   the default Bash tool. `SandboxBash` is auto-approved (no
   per-command permission prompt), because every invocation is wrapped
   by the sandbox runtime.

The agent is explicitly instructed to prefer `SandboxBash` for
non-state-changing reads anywhere on the system and for all writes
inside the project; it only falls back to the standard Bash tool when
a command genuinely needs to escape the sandbox (rare, and it still
triggers the normal permission prompt).

## Runtimes

| Platform | Backend      | Notes                                                  |
|----------|--------------|--------------------------------------------------------|
| macOS    | `sandbox-exec` (SBPL profile) | Pre-installed on every supported macOS version. |
| Linux    | `bwrap` (`bubblewrap`) | Install via the distro package manager (`bubblewrap`). |
| Other    | none         | `SandboxBash` returns an error. Sandbox-off is the only option on these hosts. |

The profile lives in `apps/agent/src/ai/profiles/project-sandbox.sb`
(macOS). The stdio MCP server that exposes `SandboxBash` lives in
`apps/agent/src/ai/sandboxMcpStdio.ts`.

## When to turn sandbox mode OFF

Turn it off only when a task genuinely has to touch files outside the
project directory, e.g.:

- Editing sibling monorepo siblings not listed as `availableRepos` for
  the project.
- Touching dotfiles in `$HOME` (shell config, git global config).
- Running tools that shell out to paths outside the project.

With sandbox OFF:

- The agent uses the standard Bash tool, which prompts the user for
  permission on each invocation (subject to the session's
  `permissionMode`).
- File writes can land anywhere the agent process has filesystem
  access.

## Trade-offs at a glance

| Aspect                          | Sandbox ON              | Sandbox OFF                     |
|---------------------------------|-------------------------|---------------------------------|
| Blast radius of a bad write     | Project dir only        | Full FS access                  |
| Per-command permission prompts  | Skipped for `SandboxBash` | Prompted for every Bash call    |
| Throughput                      | High (no prompt churn)  | Lower (human-in-the-loop churn) |
| Cross-repo edits                | Not possible            | Possible                        |

## Implementation pointers

- Default: `packages/shared/src/defaults.ts` (`DEFAULT_SANDBOXED`).
- Persistence: `apps/agent/src/ai/sessionManager.ts` stores `sandboxed`
  on `SessionRegistryEntry` and reads it back on resume.
- Wiring into the Claude SDK run: `apps/agent/src/ai/claudeSdkProvider.ts`
  adds the sandbox MCP server and the auto-approval hook when
  `sandboxed === true`.
- Stdio MCP server: `apps/agent/src/ai/sandboxMcpStdio.ts` (exposes
  the `SandboxBash` tool; errors if no sandbox backend is available).
- PWA UI: New-task toggle in
  `apps/pwa/src/components/chat/NewSessionEmptyState.tsx`; in-session
  toggle in `apps/pwa/src/components/chat/SessionStatusBar.tsx`.

## Maintenance rule

Update this document when any of the following change:

- `DEFAULT_SANDBOXED` or its consumers.
- The set of supported sandbox backends (new OS, retired backend).
- The `SandboxBash` tool name, arguments, or auto-approval hook.
- The SBPL profile's policy (what paths are writable / readable).
- The PWA toggle surfaces (add a new location, remove an existing
  one).
