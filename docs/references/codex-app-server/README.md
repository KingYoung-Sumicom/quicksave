# Codex `app-server` reference pack

> **Source(s):** see individual files
> **Fetched:** 2026-04-26
> **Codex CLI version verified against:** 0.125.0

A locally-archived digest of OpenAI's `codex app-server` JSON-RPC v2 protocol, assembled to support the Quicksave migration away from the embedded `@openai/codex-sdk` (Thread API) toward the lower-level app-server.

The deepest single source is the upstream `codex-rs/app-server/README.md` in the OpenAI repo (101 KB, 1786 lines as of fetch). This pack restructures it for a quicksave engineer reading at 11pm: skim the README here, jump to the file you need.

## Files

| File | Covers |
|------|--------|
| [`protocol-overview.md`](./protocol-overview.md) | JSON-RPC 2.0 framing, transports (stdio / unix / ws), conversation primitives (Thread / Turn / Item), versioning, schema-generation commands, WebSocket auth modes. |
| [`lifecycle.md`](./lifecycle.md) | `initialize` handshake, `thread/start`, `thread/resume` (id / history / path resumption modes), `thread/fork`, `thread/archive`/`unarchive`, `thread/list`, `thread/read`, `thread/setName`, `thread/rollback`, plus the `thread/*` notification surface. Field-by-field listings of `ThreadStartParams` and `ThreadResumeParams`. |
| [`turns.md`](./turns.md) | **Critical for migration.** `turn/start` field reference including the per-turn-override sticky semantics, `turn/interrupt`, `turn/steer` (incl. `expectedTurnId`), the in-flight notification stream (`turn/started`, `turn/completed`, deltas, `turn/diff/updated`, `turn/plan/updated`), error event. |
| [`approvals.md`](./approvals.md) | `AskForApproval` enum, `SandboxPolicy` shape, `PermissionProfile`, server→client approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`), guardian / auto-review notifications, `serverRequest/resolved`. |
| [`event-catalog.md`](./event-catalog.md) | Exhaustive list of every `ServerNotification` method emitted by the v2 protocol with one-line descriptions. Grouped for fast lookup when mapping events into our card builder. |
| [`sdk-vs-appserver.md`](./sdk-vs-appserver.md) | Comparison and migration guidance: positioning quotes from OpenAI, what we gain by migrating, contract changes (callbacks → JSON-RPC notifications). |
| [`implementation-plan.md`](./implementation-plan.md) | The phased migration plan. Red lines, per-turn override pipeline, card-adapter dispatch table, risk-by-risk mitigation, files touched. Cross-references [`../card-builder-contract.md`](../card-builder-contract.md). |

## How to regenerate the local TS bindings

The schema for every `params` / `result` / notification type is generated per-CLI-version. To rebuild:

```bash
codex app-server generate-ts --out DIR             # stable surface only (default)
codex app-server generate-ts --out DIR --experimental
codex app-server generate-json-schema --out DIR
codex app-server generate-json-schema --out DIR --experimental
```

For CLI 0.125.0 these commands ran cleanly and produced:

- `DIR/*.ts` — top-level shared types (`ClientInfo`, `InitializeParams`, `InitializeResponse`, `InitializeCapabilities`, `ServerNotification`, `ServerRequest`, `ClientRequest`, `ClientNotification`, …).
- `DIR/v2/*.ts` — v2 method/notification payload types (`TurnStartParams`, `ThreadStartParams`, `AskForApproval`, `SandboxPolicy`, `PermissionProfile`, `CommandExecutionRequestApprovalParams`, every `*Notification`, …).

The unioned method tables in `ServerNotification.ts` and `ServerRequest.ts` are the authoritative wire-method catalogs — anything not in those unions is not emitted.

## Stability notes

The `codex-rs/app-server/README.md` is explicit about which features are not yet covered by stability guarantees. Treat the following as **experimental / unsupported** and gate them behind `initialize.params.capabilities.experimentalApi = true`:

- **WebSocket transport** (`--listen ws://IP:PORT`) — README says verbatim: *"Websocket transport is currently experimental and unsupported. Do not rely on it for production workloads."* Source: `codex-rs/app-server/README.md` § Protocol.
- **Realtime API** (`thread/realtime/*` methods + `thread/realtime/*` notifications) — every entry in this surface is annotated `(experimental)`.
- **Dynamic tools** (`dynamicTools` on `thread/start`, `item/tool/call`) — requires `experimentalApi`. README § Dynamic tool calls (experimental).
- **Auto-approval review** (`item/autoApprovalReview/started` / `…/completed`, `GuardianApprovalReview`, `GuardianApprovalReviewAction`) — README labels these `[UNSTABLE] Temporary … This shape is expected to change soon.`
- **Plugin / marketplace methods** (`plugin/list`, `plugin/install`, `plugin/uninstall`, `marketplace/*`) — README labels these `(under development; do not call from production clients yet)`.
- **`AskForApproval::granular`** — gated as `askForApproval.granular requires experimentalApi capability`.
- **`thread/start.persistExtendedHistory`**, **`turn/start.environments`**, **`thread/memoryMode/set`**, **`memory/reset`**, **`thread/backgroundTerminals/clean`**, **`thread/inject_items`** — all called out in the README as experimental.
- **`thread/resume.history`** and **`thread/resume.path`** — both annotated `[UNSTABLE]`. Prefer resuming by `threadId`. (Source: `v2/ThreadResumeParams.ts`.)
- **External `chatgptAuthTokens` auth mode** — README § Auth endpoints flags this as experimental.

Stable (as of CLI 0.125.0) and safe to depend on:

- stdio transport (default).
- `initialize` / `initialized` handshake.
- `thread/start`, `thread/resume` (by id), `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/list`, `thread/read`, `thread/turns/list`, `thread/name/set`, `thread/rollback`, `thread/compact/start`, `thread/unsubscribe`.
- `turn/start`, `turn/steer`, `turn/interrupt`.
- `command/exec` family, `fs/*` family, `model/list`, `account/*` (apiKey + chatgpt browser/device flows).
- All non-experimental notifications enumerated in [`event-catalog.md`](./event-catalog.md).

The CLI changelog (https://developers.openai.com/codex/changelog) shows the app-server surface evolving continuously through 0.122 → 0.125 rather than landing at a single "stable" milestone — schema regeneration is mandatory on every CLI bump.

## Where the upstream truth lives

- **App-server crate README**: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (also at https://developers.openai.com/codex/app-server/).
- **Protocol crate**: https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol — Rust source of truth (no separate README at fetch time).
- **CLI reference**: https://developers.openai.com/codex/cli/reference (`codex app-server` flags).
- **Changelog**: https://developers.openai.com/codex/changelog.
- **Architecture context**: https://openai.com/index/unlocking-the-codex-harness/ (was unreachable from our network at fetch time; cross-referenced via https://www.infoq.com/news/2026/02/opanai-codex-app-server/ — see [`sdk-vs-appserver.md`](./sdk-vs-appserver.md)).

When something doesn't match this pack, **the upstream README and the locally-generated TS bindings win**. Update this pack in the same change.
