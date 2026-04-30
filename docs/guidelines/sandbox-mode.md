# Sandbox Mode

Sandbox mode is **not** a process-level confinement. The coding-agent
process itself runs unsandboxed and can use `Bash`, `Edit`, `Write`,
etc. with no kernel restrictions. What "sandbox mode" really means is
that an extra **MCP tool** — `SandboxBash` — is registered with the
agent. Calls to that one tool run inside a kernel-level sandbox, which
is the only reason it can be safely auto-approved.

The agent is steered (via the system prompt) to prefer `SandboxBash`
for project-scoped commands so the user isn't bothered by a permission
prompt for every shell call. Anything that genuinely needs to escape
the sandbox (writes outside `cwd`, network-mutating ops, etc.) goes
through the regular `Bash` tool and triggers the normal permission
flow.

## Default behavior

- `DEFAULT_SANDBOXED = true` in `packages/shared/src/defaults.ts`.
- Every new task the PWA starts inherits that default; the per-session
  toggle (stored on `SessionRegistryEntry.sandboxed`) survives daemon
  restarts.
- Mid-task, the user can flip the toggle from the status bar
  (`SessionStatusBar.tsx`).
- Toggling sandbox ON/OFF only changes whether the `SandboxBash` MCP
  server is registered for that session and whether its tool calls are
  auto-approved. It does not change how the agent process or any other
  tool runs.

## What `SandboxBash` actually does

When the agent calls `SandboxBash`:

1. The MCP server (`sandboxMcpStdio.ts`) detects the runtime
   (`sandbox-exec` on macOS, `bwrap` on Linux) and wraps the command
   in a sandboxed shell.
2. Filesystem writes inside that wrapped shell are restricted to the
   project `cwd` (excluding `.git/`). Writes outside it fail at the
   kernel level.
3. Reads anywhere on the system are allowed.
4. Because writes can't escape `cwd`, the Quicksave permission layer
   auto-approves `SandboxBash` invocations (no per-command prompt).

Calls to plain `Bash` are **not** wrapped. They still go through the
session's normal permission flow (driven by `permissionMode`), which
prompts the user when needed.

## Runtimes

| Platform | Backend                       | Notes                                                  |
|----------|-------------------------------|--------------------------------------------------------|
| macOS    | `sandbox-exec` (SBPL profile) | Pre-installed on every supported macOS version.        |
| Linux    | `bwrap` (`bubblewrap`)        | Install via the distro package manager (`bubblewrap`). |
| Other    | none                          | `SandboxBash` returns an error. The agent falls back to plain `Bash` (with permission prompts). |

The macOS profile lives in `apps/agent/src/ai/profiles/project-sandbox.sb`.
The stdio MCP server that exposes `SandboxBash` lives in
`apps/agent/src/ai/sandboxMcpStdio.ts`.

## When to turn sandbox mode OFF

Turning it OFF removes `SandboxBash` from the toolset entirely; the
agent then has to use plain `Bash` (with prompts) for everything. Do
this only when a task needs many shell calls that would fail inside
the sandbox, e.g.:

- Editing sibling repos not listed as `availableRepos`.
- Touching dotfiles in `$HOME` (shell config, git global config).
- Running tools that shell out to paths outside the project.

With sandbox OFF:

- Every shell command goes through the regular `Bash` tool, which
  prompts the user for permission (subject to `permissionMode`).
- The agent loses its auto-approved fast path; throughput drops.
- The agent process's other tools (`Edit`, `Write`, …) behave the same
  as before — sandbox mode never gated those.

## Trade-offs at a glance

| Aspect                             | Sandbox ON                        | Sandbox OFF                          |
|------------------------------------|-----------------------------------|--------------------------------------|
| `SandboxBash` available?           | Yes, auto-approved                | No                                   |
| Per-command prompt for shell calls | Skipped (when using `SandboxBash`)| Prompted for every `Bash` call       |
| Throughput                         | High (no prompt churn)            | Lower (human-in-the-loop churn)      |
| Cross-repo edits                   | Need to escape via plain `Bash`   | Just use `Bash` directly             |
| Agent-process confinement          | None — sandbox mode does not confine the agent process | None |

## What sandbox mode is **not**

- It is **not** a kernel-level confinement of the agent process.
- It does **not** prevent `Edit`, `Write`, or plain `Bash` from
  touching paths outside the project. Those tools never go through
  the sandbox.
- It does **not** replace the permission system. The permission system
  is still what gates non-`SandboxBash` tool calls; the sandbox just
  lets us auto-approve `SandboxBash` because the kernel already keeps
  it inside the project.

## Implementation pointers

- Default: `packages/shared/src/defaults.ts` (`DEFAULT_SANDBOXED`).
- Persistence: `apps/agent/src/ai/sessionManager.ts` stores `sandboxed`
  on `SessionRegistryEntry` and reads it back on resume.
- MCP registration: `apps/agent/src/ai/claudeSdkProvider.ts` registers
  the sandbox MCP server (`buildSandboxMcpServerConfig`) and short-
  circuits `canUseTool` to allow `SandboxBash` when `sandboxed` is on.
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
