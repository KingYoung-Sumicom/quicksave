# Codex `app-server` — approvals, sandbox & permission model

> **Source(s):** https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (§ Approvals → § Command execution approvals, § File change approvals, § request_user_input, § MCP server elicitations, § Permission requests, § Dynamic tool calls, § Turn events → § Items → auto-approval review block); locally-generated `v2/AskForApproval.ts`, `v2/SandboxPolicy.ts`, `v2/SandboxMode.ts`, `v2/PermissionProfile.ts`, `v2/PermissionProfileFileSystemPermissions.ts`, `v2/PermissionProfileNetworkPermissions.ts`, `v2/CommandExecutionApprovalDecision.ts`, `v2/FileChangeApprovalDecision.ts`, `v2/CommandExecutionRequestApprovalParams.ts`, `v2/FileChangeRequestApprovalParams.ts`, `v2/PermissionsRequestApprovalParams.ts`, `v2/PermissionsRequestApprovalResponse.ts`, `v2/ApprovalsReviewer.ts`, `v2/GuardianApprovalReview.ts`, `v2/GuardianApprovalReviewAction.ts`, `ServerRequest.ts` (CLI 0.125.0).
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

The app-server gives us actual approval primitives — server→client JSON-RPC requests with typed payloads — instead of the SDK's "pass a callback that returns a boolean." This file covers the static policy types, the runtime approval round-trips, and the auto-review (guardian) surface.

For where these types are set on a turn see [`turns.md`](./turns.md). For the full notification catalog see [`event-catalog.md`](./event-catalog.md).

## Static policy types

There are three knobs that decide whether a command/edit/network call needs a runtime approval prompt:

1. **`AskForApproval`** — the policy that says *when* to prompt.
2. Either **`SandboxPolicy`** *or* **`PermissionProfile`** — the policy that says *what is allowed without prompting*. Mutually exclusive.

All three are sticky on the thread once set via `thread/start` or `turn/start` (see [`turns.md`](./turns.md) § The sticky-override rule). They can be set at thread level (`thread/start.approvalPolicy` / `.sandbox` / `.permissionProfile`) or per-turn (`turn/start.approvalPolicy` / `.sandboxPolicy` / `.permissionProfile`).

### `AskForApproval`

Verbatim from `v2/AskForApproval.ts`:

```ts
export type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | { "granular": {
      sandbox_approval: boolean,
      rules: boolean,
      skill_approval: boolean,
      request_permissions: boolean,
      mcp_elicitations: boolean,
    } }
  | "never";
```

Variant meanings (synthesized from the README + protocol):

- `"untrusted"` — prompt for any command not on the trusted list.
- `"on-failure"` — auto-approve, but escalate to a prompt when an action fails sandbox/policy.
- `"on-request"` — auto-approve except where the agent itself asks for elevated permissions.
- `"never"` — no approvals; the sandbox decides everything synchronously.
- `{ granular: { ... } }` — per-category control. **Experimental** — gated behind `askForApproval.granular requires experimentalApi capability` (see README § Experimental API Opt-in). Each boolean independently enables prompting for that category:
  - `sandbox_approval` — escalate sandbox-blocked actions.
  - `rules` — prompt when an exec-policy rule needs amendment.
  - `skill_approval` — prompt before a skill runs.
  - `request_permissions` — let the `request_permissions` tool send `item/permissions/requestApproval` (see below).
  - `mcp_elicitations` — let MCP servers elicit structured input via `mcpServer/elicitation/request`.

Note the README also references the older string variant `"unlessTrusted"` in some examples (`turn/start` README sample). The TS schema export in CLI 0.125.0 lists `"untrusted"` instead — they appear to be aliases on the wire (the legacy name is still accepted). Use `"untrusted"` going forward.

The README also notes (§ Permission requests):

> If the session approval policy uses `Granular` with `request_permissions: false`, standalone `request_permissions` tool calls are auto-denied and no `item/permissions/requestApproval` prompt is sent. Inline `with_additional_permissions` command requests remain controlled by `sandbox_approval`, and any previously granted permissions remain sticky for later shell-like calls in the same turn.

### `SandboxMode` (string shorthand)

`v2/SandboxMode.ts`:

```ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
```

This is the **shorthand** form accepted on `thread/start.sandbox`. It maps to a default `SandboxPolicy` shape server-side. **Cannot be combined with `permissionProfile`.**

### `SandboxPolicy` (full form)

`v2/SandboxPolicy.ts`:

```ts
export type SandboxPolicy =
  | { "type": "dangerFullAccess" }
  | { "type": "readOnly", access: ReadOnlyAccess, networkAccess: boolean }
  | { "type": "externalSandbox", networkAccess: NetworkAccess }
  | { "type": "workspaceWrite",
      writableRoots: Array<AbsolutePathBuf>,
      readOnlyAccess: ReadOnlyAccess,
      networkAccess: boolean,
      excludeTmpdirEnvVar: boolean,
      excludeSlashTmp: boolean,
    };
```

Variant meanings:

- `dangerFullAccess` — unrestricted filesystem and network. Same effect as `--sandbox danger-full-access`.
- `readOnly` — read-only filesystem; `networkAccess` is a separate boolean.
- `externalSandbox` — host app is sandboxing the agent; Codex skips its own enforcement and tells the model it has full filesystem access. `networkAccess` is `NetworkAccess` (which has `restricted | enabled` variants per the README's `command/exec` section).
- `workspaceWrite` — the common one. `writableRoots` lists absolute paths the agent can write to; everything else falls under `readOnlyAccess`. `networkAccess` is a boolean. `excludeTmpdirEnvVar` and `excludeSlashTmp` let you opt out of the default `$TMPDIR` and `/tmp` write windows.

This is the **legacy** override field on `turn/start.sandboxPolicy`. The README says:

> Prefer `permissionProfile` for command permission overrides. The legacy `sandboxPolicy` field accepts the same shape used by `turn/start` (e.g., `dangerFullAccess`, `readOnly`, `workspaceWrite` with flags, `externalSandbox` with `networkAccess` `restricted|enabled`), but cannot be combined with `permissionProfile`.
>
> — `codex-rs/app-server/README.md` § Example: One-off command execution

### `PermissionProfile` (preferred, full-control form)

`v2/PermissionProfile.ts`:

```ts
export type PermissionProfile =
  | { "type": "managed",
      network: PermissionProfileNetworkPermissions,
      fileSystem: PermissionProfileFileSystemPermissions }
  | { "type": "disabled" }
  | { "type": "external",
      network: PermissionProfileNetworkPermissions };
```

- `managed` — Codex enforces both filesystem and network permissions explicitly. `fileSystem` and `network` carry the granular allow/deny lists.
- `disabled` — equivalent to "no enforcement at this layer."
- `external` — host sandboxes the filesystem; Codex still enforces (or trusts) network rules per `network`.

The README example for `command/exec` shows the `managed` shape in action:

```json
"permissionProfile": {
    "type": "managed",
    "fileSystem": { "type": "restricted", "entries": [
        { "path": { "type": "special", "value": { "kind": "root" } }, "access": "read" },
        { "path": { "type": "special", "value": { "kind": "current_working_directory" } }, "access": "write" }
    ] },
    "network": { "enabled": false }
}
```

This is the future-proof override field. **Mutually exclusive with `sandboxPolicy` / `sandbox`.**

### `ApprovalsReviewer` — who reviews approvals

`v2/ApprovalsReviewer.ts`:

```ts
/**
 * Configures who approval requests are routed to for review. Examples
 * include sandbox escapes, blocked network access, MCP approval prompts, and
 * ARC escalations. Defaults to `user`. `auto_review` uses a carefully
 * prompted subagent to gather relevant context and apply a risk-based
 * decision framework before approving or denying the request.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
```

- `"user"` (default) — server-initiated approval requests come straight to the client; we surface a UI dialog.
- `"auto_review"` — routes prompts to a subagent that gathers context and applies a risk-based decision framework. The README describes this surface as `[UNSTABLE]` in the auto-review notification block. Pair with the `item/autoApprovalReview/*` notifications described below.
- `"guardian_subagent"` — legacy name for `"auto_review"`; still accepted for compatibility.

## Approval round-trips (server-initiated requests)

When an action requires explicit approval, the server sends a JSON-RPC **request** to the client (note: a request, not a notification — it carries an `id` and expects a `result`). The client must respond with a `decision` payload, then receives a `serverRequest/resolved` notification confirming the resolution.

The full server-request union (verbatim from top-level `ServerRequest.ts`):

```ts
export type ServerRequest =
  | { "method": "item/commandExecution/requestApproval", id: RequestId, params: CommandExecutionRequestApprovalParams }
  | { "method": "item/fileChange/requestApproval",       id: RequestId, params: FileChangeRequestApprovalParams }
  | { "method": "item/tool/requestUserInput",            id: RequestId, params: ToolRequestUserInputParams }
  | { "method": "mcpServer/elicitation/request",         id: RequestId, params: McpServerElicitationRequestParams }
  | { "method": "item/permissions/requestApproval",      id: RequestId, params: PermissionsRequestApprovalParams }
  | { "method": "item/tool/call",                        id: RequestId, params: DynamicToolCallParams }
  | { "method": "account/chatgptAuthTokens/refresh",     id: RequestId, params: ChatgptAuthTokensRefreshParams }
  | { "method": "applyPatchApproval",                    id: RequestId, params: ApplyPatchApprovalParams }
  | { "method": "execCommandApproval",                   id: RequestId, params: ExecCommandApprovalParams };
```

`applyPatchApproval` and `execCommandApproval` are legacy v1-shaped requests; the v2 surface uses `item/fileChange/requestApproval` and `item/commandExecution/requestApproval`. New code should target the v2 ones.

### Common rule for every approval request

After the client responds, the server emits **`serverRequest/resolved`** with `{ threadId, requestId }` to confirm. The README:

> `serverRequest/resolved` — `{ threadId, requestId }` confirms the pending request has been resolved or cleared, including lifecycle cleanup on turn start/complete/interrupt.

So if a turn is interrupted while an approval is pending, the client still gets a `serverRequest/resolved` for that requestId — that's how you know to dismiss the dialog.

### 1. `item/commandExecution/requestApproval`

Sent for shell / unified-exec commands, network-only approvals, and zsh-exec-bridge subcommand callbacks.

**Order of messages (verbatim from § Command execution approvals):**

1. `item/started` — pending `commandExecution` item with `command`, `cwd`, etc.
2. `item/commandExecution/requestApproval` (server-initiated request).
3. Client response with `{ decision }`.
4. `serverRequest/resolved` notification.
5. `item/completed` — final `commandExecution` item with `status: "completed" | "failed" | "declined"`.

Request params (`v2/CommandExecutionRequestApprovalParams.ts`):

```ts
export type CommandExecutionRequestApprovalParams = {
  threadId: string,
  turnId: string,
  itemId: string,
  /** Unique identifier for this specific approval callback. For regular shell/unified_exec
   *  approvals, this is null. For zsh-exec-bridge subcommand approvals, multiple callbacks
   *  can belong to one parent `itemId`, so `approvalId` is a distinct opaque callback id
   *  (a UUID) used to disambiguate routing. */
  approvalId?: string | null,
  /** Optional explanatory reason (e.g. request for network access). */
  reason?: string | null,
  /** Optional context for a managed-network approval prompt. */
  networkApprovalContext?: NetworkApprovalContext | null,
  /** The command to be executed. */
  command?: string | null,
  /** The command's working directory. */
  cwd?: AbsolutePathBuf | null,
  /** Best-effort parsed command actions for friendly display. */
  commandActions?: Array<CommandAction> | null,
  /** Optional additional permissions requested for this command. */
  additionalPermissions?: AdditionalPermissionProfile | null,
  /** Optional proposed execpolicy amendment to allow similar commands without prompting. */
  proposedExecpolicyAmendment?: ExecPolicyAmendment | null,
  /** Optional proposed network policy amendments (allow/deny host) for future requests. */
  proposedNetworkPolicyAmendments?: Array<NetworkPolicyAmendment> | null,
  /** Ordered list of decisions the client may present for this prompt. */
  availableDecisions?: Array<CommandExecutionApprovalDecision> | null,
};
```

When `experimentalApi = true`, `additionalPermissions` may also appear with **absolute** filesystem paths and `additionalPermissions.network.enabled` for network-access state. For pure network-only approvals, `command`/`cwd`/`commandActions` may be omitted and `networkApprovalContext` is provided instead.

The README hints at UI strategy:

> Clients can prefer `availableDecisions` when present to render the exact set of choices the server wants to expose, while still falling back to the older heuristics if it is omitted.

Decision response (`v2/CommandExecutionApprovalDecision.ts`):

```ts
export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { "acceptWithExecpolicyAmendment": { execpolicy_amendment: ExecPolicyAmendment } }
  | { "applyNetworkPolicyAmendment":   { network_policy_amendment: NetworkPolicyAmendment } }
  | "decline"
  | "cancel";
```

Wire shape: `{ "decision": "accept" }`, `{ "decision": "acceptForSession" }`, `{ "decision": { "acceptWithExecpolicyAmendment": { "execpolicy_amendment": [...] } } }`, etc.

- `accept` — let this command run.
- `acceptForSession` — let this run AND auto-approve identical-class actions for the rest of the session.
- `acceptWithExecpolicyAmendment` — accept and persist an exec-policy rule so similar future commands won't prompt.
- `applyNetworkPolicyAmendment` — for network-only approvals: accept and persist an `allow`/`deny` network rule.
- `decline` — refuse this single action; turn continues.
- `cancel` — refuse and request that the agent abandon the turn.

### 2. `item/fileChange/requestApproval`

Sent before `apply_patch`-style file edits.

**Order of messages (verbatim from § File change approvals):**

1. `item/started` — `fileChange` item with `changes` (diff-chunk summaries) and `status: "inProgress"`.
2. `item/fileChange/requestApproval` (server-initiated request).
3. Client response with `{ decision }`.
4. `serverRequest/resolved` notification.
5. `item/completed` — same `fileChange` item with `status: "completed" | "failed" | "declined"`.

Request params (`v2/FileChangeRequestApprovalParams.ts`):

```ts
export type FileChangeRequestApprovalParams = {
  threadId: string,
  turnId: string,
  itemId: string,
  /** Optional explanatory reason (e.g. request for extra write access). */
  reason?: string | null,
  /** [UNSTABLE] When set, the agent is asking the user to allow writes under this root
   *  for the remainder of the session (unclear if this is honored today). */
  grantRoot?: string | null,
};
```

Decision response (`v2/FileChangeApprovalDecision.ts`) — simpler than command approvals:

```ts
export type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";
```

UI guidance from the README:

> Surface an approval dialog as soon as the request arrives. The turn will proceed after the server receives a response to the approval request. The terminal `item/completed` notification will be sent with the appropriate status.

### 3. `item/permissions/requestApproval`

Sent by the built-in `request_permissions` tool. This is the v2 payload — it mirrors the command-execution `additionalPermissions` shape.

Request params (`v2/PermissionsRequestApprovalParams.ts`):

```ts
export type PermissionsRequestApprovalParams = {
  threadId: string,
  turnId: string,
  itemId: string,
  cwd: AbsolutePathBuf,                       // resolves cwd-relative paths like :cwd, :project_roots
  reason: string | null,
  permissions: RequestPermissionProfile,
};
```

Wire example from the README:

```json
{
  "method": "item/permissions/requestApproval",
  "id": 61,
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_123",
    "itemId": "call_123",
    "cwd": "/Users/me/project",
    "reason": "Select a workspace root",
    "permissions": {
      "fileSystem": { "write": ["/Users/me/project", "/Users/me/shared"] }
    }
  }
}
```

Response (`v2/PermissionsRequestApprovalResponse.ts`):

```ts
export type PermissionsRequestApprovalResponse = {
  permissions: GrantedPermissionProfile,
  scope: PermissionGrantScope,                // "turn" | "session"
  /** Review every subsequent command in this turn before normal sandboxed execution. */
  strictAutoReview?: boolean,
};
```

Wire example:

```json
{
  "id": 61,
  "result": {
    "scope": "session",
    "permissions": {
      "fileSystem": { "write": ["/Users/me/project"] }
    }
  }
}
```

Important rules from the README:

> Only the granted subset matters on the wire. Any permissions omitted from `result.permissions` are treated as denied. Any permissions not present in the original request are ignored by the server.
>
> Within the same turn, granted permissions are sticky: later shell-like tool calls can automatically reuse the granted subset without reissuing a separate permission request.

### 4. `item/tool/requestUserInput`

The agent prompts the user with 1–3 short questions for a tool call (experimental).

When the client responds, the server emits `serverRequest/resolved`. If the pending request is cleared by `turn/started`, `turn/completed`, or `turn/interrupted` before the client answers, the server emits the same notification for cleanup. (Source: README § request_user_input.)

### 5. `mcpServer/elicitation/request`

MCP servers can interrupt a turn and ask the client for structured input.

Order of messages (verbatim from § MCP server elicitations):

1. `mcpServer/elicitation/request` (request) — includes `threadId`, nullable `turnId`, `serverName`, and either:
   - a form request: `{ "mode": "form", "message": "...", "requestedSchema": { ... } }`
   - a URL request: `{ "mode": "url", "message": "...", "url": "...", "elicitationId": "..." }`
2. Client response — `{ "action": "accept", "content": ... }`, `{ "action": "decline", "content": null }`, or `{ "action": "cancel", "content": null }`.
3. `serverRequest/resolved` notification.

`turnId` is best-effort. For MCP tool-approval elicitations, form `meta` includes `codex_approval_kind: "mcp_tool_call"` and may include `persist: "session"`, `persist: "always"`, or `persist: ["session", "always"]` to advertise whether the client can offer session-scoped and/or persistent approval choices.

### 6. `item/tool/call` (dynamic tools, experimental)

When `dynamicTools` are configured on `thread/start` (requires `experimentalApi`), the server sends `item/tool/call` requests for each invocation:

```json
{ "method": "item/tool/call", "id": 60, "params": {
    "threadId": "thr_123",
    "turnId": "turn_123",
    "callId": "call_123",
    "tool": "lookup_ticket",
    "arguments": { "id": "ABC-123" }
} }
```

Lifecycle:

1. `item/started` with `item.type = "dynamicToolCall"`, `status: "inProgress"`.
2. `item/tool/call` request.
3. Client response with `contentItems` (`inputText` / `inputImage`) and `success`.
4. `item/completed` with final `dynamicToolCall` state.

Response shape:

```json
{ "id": 60, "result": {
    "contentItems": [
      { "type": "inputText", "text": "Ticket ABC-123 is open." },
      { "type": "inputImage", "imageUrl": "data:image/png;base64,AAA" }
    ],
    "success": true
} }
```

## Auto-approval / guardian review notifications (UNSTABLE)

When `approvalsReviewer` is `"auto_review"` (or legacy `"guardian_subagent"`), the auto-review subagent decides whether to approve actions on the user's behalf. Two notifications fire around the reviewed item:

- **`item/autoApprovalReview/started`** — `{ threadId, turnId, reviewId, targetItemId, review, action }`
- **`item/autoApprovalReview/completed`** — `{ threadId, turnId, reviewId, targetItemId, decisionSource, review, action }`

Both are tagged `[UNSTABLE]` in the README and in the generated TS bindings. The README:

> These notifications are separate from the target item's own `item/completed` lifecycle and are intentionally temporary while the auto-review app protocol is still being designed.

`review` is `GuardianApprovalReview` (`v2/GuardianApprovalReview.ts`):

```ts
export type GuardianApprovalReview = {
  status: GuardianApprovalReviewStatus,         // "inProgress" | "approved" | "denied" | "aborted"
  riskLevel: GuardianRiskLevel | null,          // "low" | "medium" | "high" | "critical"
  userAuthorization: GuardianUserAuthorization | null,  // "unknown" | "low" | "medium" | "high"
  rationale: string | null,
};
```

`action` is `GuardianApprovalReviewAction` (`v2/GuardianApprovalReviewAction.ts`) — a tagged union covering every kind of action the reviewer can decide on:

```ts
export type GuardianApprovalReviewAction =
  | { "type": "command", source: GuardianCommandSource, command: string, cwd: AbsolutePathBuf }
  | { "type": "execve", source: GuardianCommandSource, program: string, argv: Array<string>, cwd: AbsolutePathBuf }
  | { "type": "applyPatch", cwd: AbsolutePathBuf, files: Array<AbsolutePathBuf> }
  | { "type": "networkAccess", target: string, host: string, protocol: NetworkApprovalProtocol, port: number }
  | { "type": "mcpToolCall", server: string, toolName: string, connectorId: string | null, connectorName: string | null, toolTitle: string | null }
  | { "type": "requestPermissions", reason: string | null, permissions: RequestPermissionProfile };
```

`source: GuardianCommandSource` is `"shell" | "unifiedExec"`. `targetItemId` is `null` for `networkAccess` (the review is about the network call, not the parent `commandExecution` item) and for `execve` reviews where one parent command may contain multiple execve calls.

`decisionSource: AutoReviewDecisionSource` (on the completed notification only) reports whether the decision came from the subagent, a cached rule, or a fall-through path.

There is **also** a `guardianWarning` notification (top-level) emitted when the guardian system flags non-blocking concerns. See [`event-catalog.md`](./event-catalog.md).

## Approval-policy interaction matrix (worth memorizing)

| `approvalPolicy` | What it means at runtime |
|------------------|--------------------------|
| `"untrusted"` | Prompt for any command not on the trusted list. Default for new threads. |
| `"on-failure"` | Auto-approve; prompt only when a sandbox or policy check fails. |
| `"on-request"` | Auto-approve; prompt only when the agent itself asks for elevated permissions (i.e. fires `request_permissions`). |
| `"never"` | No prompts ever. Sandbox decides everything synchronously — failures appear as failed items, not approval prompts. |
| `{ granular: { … } }` | Per-category control, **experimental**. See bullets above. |

Combine with `permissionProfile` for what's allowed *without* prompting and `approvalsReviewer` for *who* sees the prompt.

## What this changes for Quicksave

(Pointers, not commitments — for the migration plan.)

- We get **typed, per-action approval payloads** with `command`, `cwd`, `commandActions`, `additionalPermissions`, `availableDecisions`. The current SDK `can_use_tool`-style boolean callback is replaced with a real UI surface.
- `acceptForSession` is now a first-class wire decision — we don't need to track session-stickiness ourselves.
- `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` let users *teach* Codex about their environment rather than just accepting/denying one prompt at a time.
- File-change approvals carry full diffs at `item/started` time; we can render the proposed diff before the user commits.
- Auto-review (`approvalsReviewer: "auto_review"`) is opt-in and unstable — keep behind a flag until the protocol stabilizes, but the surface is there for low-trust automation runs.
- `serverRequest/resolved` is the single notification we listen for to dismiss approval UI cleanly when a turn ends mid-prompt.
- We need a "permissions sticky" mental model: granted permissions auto-reuse for the rest of the same turn, so a single approval can cover many commands.
