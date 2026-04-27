# Codex `app-server` — protocol overview

> **Source(s):** https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (§ Protocol, § Message Schema, § Core Primitives, § Lifecycle Overview, § Experimental API Opt-in); https://developers.openai.com/codex/app-server; https://developers.openai.com/codex/cli/reference; locally-generated `codex app-server generate-ts --out` output (CLI 0.125.0).
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

## What it is

`codex app-server` is the **bidirectional JSON-RPC 2.0** interface that drives every "rich client" Codex integration (VS Code extension, web app, macOS desktop, Codex Web). The CLI subcommand spawns a long-lived process and exchanges JSON-RPC messages with the client over a chosen transport. From the upstream README:

> Similar to [MCP](https://modelcontextprotocol.io/), `codex app-server` supports bidirectional communication using JSON-RPC 2.0 messages (with the `"jsonrpc":"2.0"` header omitted on the wire).
>
> — `codex-rs/app-server/README.md` § Protocol

The omission of the `"jsonrpc"` envelope key is non-standard but consistent across requests, responses and notifications. Frames carry only `method` / `params` / `id` (request), `id` + `result` or `error` (response), or `method` / `params` (notification, no `id`).

### Backpressure

Both ingress and outbound writes use bounded queues. When ingress is saturated, the server returns JSON-RPC error code **`-32001`** with message *"Server overloaded; retry later."* Clients should retry with exponential backoff and jitter. (Source: README § Protocol.)

## Transports

Selected via `--listen <URL>` on `codex app-server`:

| Transport | Flag | Status | Notes |
|-----------|------|--------|-------|
| **stdio** (default) | `--listen stdio://` | Stable | Newline-delimited JSON (JSONL). One JSON-RPC message per line on stdin/stdout. This is what we will use for Quicksave. |
| **Unix socket** | `--listen unix://` or `--listen unix://PATH` | Stable | WebSocket frames over `$CODEX_HOME/app-server-control/app-server-control.sock` (or a custom path) using a standard HTTP Upgrade handshake. Intended for "local app-server control-plane clients." `codex app-server proxy` opens a single raw stream connection and shuffles bytes between the socket and stdin/stdout. |
| **WebSocket** | `--listen ws://IP:PORT` | **Experimental / unsupported** | One JSON-RPC message per WebSocket text frame. README explicitly says: *"Websocket transport is currently experimental and unsupported. Do not rely on it for production workloads."* |
| **Off** | `--listen off` | — | Disable any local transport. |

When a `ws://` listener is running, the same listener exposes basic HTTP health probes:

- `GET /readyz` → `200 OK` once the listener accepts new connections.
- `GET /healthz` → `200 OK` *only* when no `Origin` header is present.
- Any request carrying an `Origin` header is rejected with `403 Forbidden`.

### WebSocket auth modes (experimental)

Briefly, since stdio is what we plan to use:

```
--ws-auth capability-token --ws-token-file /absolute/path
--ws-auth capability-token --ws-token-sha256 HEX
--ws-auth signed-bearer-token --ws-shared-secret-file /absolute/path
   [--ws-issuer ISS] [--ws-audience AUD] [--ws-max-clock-skew-seconds N]
```

Clients present the credential as `Authorization: Bearer <token>` during the WebSocket handshake. Auth is enforced **before** JSON-RPC `initialize`. The README cautions:

- Loopback listeners (`ws://127.0.0.1:PORT`) are appropriate for localhost / SSH port-forwarding.
- Non-loopback listeners *currently* allow unauthenticated connections by default during rollout — explicitly configure auth if you expose remotely.
- Prefer `--ws-token-file` over passing tokens on the command line.
- `--ws-token-sha256` is for clients that keep the raw token in a separate secret store; the hash alone is not sufficient to authenticate.

## Conversation primitives

The README's § Core Primitives spells out the three nested objects that structure every conversation:

> The API exposes three top level primitives representing an interaction between a user and Codex:
>
> - **Thread**: A conversation between a user and the Codex agent. Each thread contains multiple turns.
> - **Turn**: One turn of the conversation, typically starting with a user message and finishing with an agent message. Each turn contains multiple items.
> - **Item**: Represents user inputs and agent outputs as part of the turn, persisted and used as the context for future conversations. Example items include user message, agent reasoning, agent message, shell command, file edit, etc.

In other words:

- **Thread** owns durable state: rollout file on disk, persisted token usage, sticky `model`/`reasoningEffort`/`personality`/`approvalPolicy`/`sandboxPolicy`, sticky `environments` (experimental), git metadata, `gitInfo`. Lifecycle methods: `thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/rollback`, `thread/list`, `thread/read`, `thread/turns/list`, `thread/name/set`. See [`lifecycle.md`](./lifecycle.md).
- **Turn** is one user-input → agent-completion cycle on a thread. Started by `turn/start`, can be redirected by `turn/steer`, cancelled by `turn/interrupt`. Its lifecycle event is the canonical signal `turn/started` → (deltas) → `turn/completed` (with `status: "completed" | "interrupted" | "failed"`). See [`turns.md`](./turns.md).
- **Item** is one atomic unit inside a turn: `userMessage`, `agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `plan`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`, etc. Each item follows `item/started` → zero-or-more typed deltas → `item/completed`. The full item tagged-union is documented in [`event-catalog.md`](./event-catalog.md).

Items are streamed as JSON-RPC notifications (server → client, no response expected) — never as part of an RPC response. The README is explicit:

> Today both notifications carry an empty `items` array even when item events were streamed; rely on `item/*` notifications for the canonical item list until this is fixed.
>
> — `codex-rs/app-server/README.md` § Turn events

So the canonical "what happened in this turn" stream is the sequence of `item/started` and `item/completed` notifications between `turn/started` and `turn/completed`. Do not try to read item state out of `turn.items` on the response.

## Versioning

There is no semver-ed wire schema. Each Codex CLI version emits its own schema, and the README is direct about what that means:

> Currently, you can dump a TypeScript version of the schema using `codex app-server generate-ts`, or a JSON Schema bundle via `codex app-server generate-json-schema`. Each output is specific to the version of Codex you used to run the command, so the generated artifacts are guaranteed to match that version.
>
> — `codex-rs/app-server/README.md` § Message Schema

Two generators:

```
codex app-server generate-ts --out DIR
codex app-server generate-json-schema --out DIR
```

Both default to the **stable** surface (experimental fields and methods filtered out). To include the experimental surface, append `--experimental`:

```
codex app-server generate-ts --out DIR --experimental
codex app-server generate-json-schema --out DIR --experimental
```

We have run both locally on CLI 0.125.0; the output directory layout is:

```
DIR/
├── *.ts                  # top-level shared types
│   ├── ClientInfo.ts
│   ├── InitializeParams.ts / InitializeResponse.ts / InitializeCapabilities.ts
│   ├── ServerNotification.ts   # union of every server-emitted notification
│   ├── ServerRequest.ts        # union of every server-initiated RPC
│   ├── ClientRequest.ts / ClientNotification.ts
│   └── …
├── v2/*.ts               # v2 method/notification payload types
│   ├── ThreadStartParams.ts / ThreadResumeParams.ts / TurnStartParams.ts
│   ├── AskForApproval.ts / SandboxPolicy.ts / PermissionProfile.ts
│   ├── CommandExecutionRequestApprovalParams.ts / FileChangeRequestApprovalParams.ts
│   ├── *Notification.ts        # one file per notification payload
│   └── …
└── serde_json/JsonValue.ts
```

`DIR/ServerNotification.ts` and `DIR/ServerRequest.ts` are the authoritative method-name catalogs — anything not in those unions is not on the wire.

## Experimental API opt-in

Some methods, fields and enum variants are gated. They will return a JSON-RPC error of the form *`<descriptor> requires experimentalApi capability`* unless the client opted in during `initialize`:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": { "name": "my_client", "title": "My Client", "version": "0.1.0" },
    "capabilities": { "experimentalApi": true }
  }
}
```

The setting is negotiated **once** at initialization time for the connection lifetime; re-`initialize` is rejected with *"Already initialized"*. README § Experimental API Opt-in lists the gating granularities:

- Method-level: e.g. `mock/experimentalMethod`.
- Field-level: e.g. `thread/start.mockExperimentalField`.
- Enum-variant: e.g. `askForApproval.granular`.

A summary of which surfaces are experimental is in [`README.md`'s "Stability notes"](./README.md#stability-notes).

## Tracing / logs

- `RUST_LOG` controls log filtering / verbosity.
- `LOG_FORMAT=json` makes the app-server emit tracing logs to **stderr** as JSON, one event per line. (Source: README § Protocol.)

This matters for our daemon: the JSON-RPC stream is on stdout; logs are on stderr. Don't mix them.

## CLI flags relevant to the app-server

From https://developers.openai.com/codex/cli/reference and the same README:

| Flag | Description |
|------|-------------|
| `--listen <URL>` | Transport selector (see § Transports above). |
| `--ws-auth capability-token \| signed-bearer-token` | WebSocket auth mode (only meaningful with `--listen ws://`). |
| `--ws-token-file PATH` | File containing the shared capability token. |
| `--ws-token-sha256 HEX` | SHA-256 verifier for the capability token. |
| `--ws-shared-secret-file PATH` | HMAC shared secret for signed JWT/JWS bearer tokens. |
| `--ws-issuer STR` / `--ws-audience STR` | Expected `iss` / `aud` claims for signed bearer tokens. |
| `--ws-max-clock-skew-seconds N` | Clock skew allowance for signed bearer tokens. |
| `--config, -c key=value` | Override a single config TOML key. |
| `--cd, -C PATH` | Set working directory before processing. |
| `--profile, -p STR` | Select a configuration profile. |
| `--model, -m STR` | Override the configured model. |
| `--sandbox, -s read-only \| workspace-write \| danger-full-access` | Sandbox policy. |
| `--ask-for-approval, -a untrusted \| on-request \| never` | Approval policy. |
| `--oss` | Use the local open-source provider. |

(`--image` and `--profile` from the global flag set are also accepted but rarely used with `app-server`.)

The `codex app-server` subcommand itself is documented in the upstream CLI reference as: *"Launch the Codex app server for local development or debugging."* It is currently surfaced as **experimental**, even though the stdio transport is stable.

## Cross-references

- Connection lifecycle and thread methods → [`lifecycle.md`](./lifecycle.md).
- Turn semantics, `turn/start` overrides, `turn/steer`, `turn/interrupt` → [`turns.md`](./turns.md).
- Approvals, `SandboxPolicy`, `PermissionProfile`, guardian review → [`approvals.md`](./approvals.md).
- Full event method catalog → [`event-catalog.md`](./event-catalog.md).
- SDK-vs-app-server positioning and migration plan → [`sdk-vs-appserver.md`](./sdk-vs-appserver.md).
