# Sandbox Policy

Quicksave does not provide a shell sandbox MCP. The former `SandboxBash` tool
and its `sandbox-exec` / `bwrap` implementation were removed because provider
permission systems now handle command review directly.

The shared Quicksave MCP server is named `quicksave-tools`. It exposes session
status, artifact, and provider-integration utilities only; it must not expose a
general-purpose shell execution tool.

## Provider behavior

- **Codex** is the only provider that currently consumes the persisted
  `sandboxed` field. Quicksave maps it to Codex app-server's native
  `sandboxPolicy`: `true` selects `workspaceWrite`, while `false` allows
  `dangerFullAccess` where the selected permission preset permits it.
- **Claude Code** relies on Claude's permission modes and review flow. The
  `sandboxed` field does not add a tool or install a permission hook.
- **OpenCode** relies on its permission rules and Guardian auto-review flow.
- **Pi** has no Quicksave-provided sandbox layer.

The PWA does not show a Sandbox setting for providers that do not implement a
native sandbox. Existing `sandboxed` values remain in the wire and registry
types for Codex and backward compatibility.

## Quicksave tools MCP

Implementation files:

- `apps/agent/src/ai/quicksaveToolsMcp.ts` — canonical server/tool names and
  subprocess configuration.
- `apps/agent/src/ai/quicksaveToolsMcpStdio.ts` — stdio MCP implementation.

The canonical prefix is `mcp__quicksave-tools__`. Rename changes must update
Claude, Codex, OpenCode, the PWA tool registry, tests, and architecture docs
together.

## Maintenance rule

Update this document when changing the `sandboxed` mapping, adding native
sandbox support to another provider, changing the `quicksave-tools` name, or
adding any command-execution capability to the shared MCP server.
