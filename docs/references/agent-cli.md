# Agent CLI reference

Complete reference for the `quicksave` command, the daemon it manages,
and the on-disk state layout.

## Subcommands

| Command                          | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `quicksave`                      | Start / ensure daemon; print pairing URL + QR                |
| `quicksave status`               | Show agent pairing state (`unpaired` \| `paired` \| `closed`) |
| `quicksave pair`                 | Reset the `closed` lock (after tombstone) and rotate the agent identity, then show the connection URL |
| `quicksave rotate-keys`          | Generate a new keypair (invalidates paired PWAs)             |
| `quicksave service start`        | Start daemon in the background                               |
| `quicksave service stop`         | Stop the running daemon                                      |
| `quicksave service status`       | Live status (pid, version, uptime, peers, active sessions, managed repos) |
| `quicksave service info`         | Static status from `service.json` (no IPC required)          |
| `quicksave service run`          | Run daemon in foreground (not normally invoked directly)     |

### Flags accepted by `quicksave`

```bash
quicksave                                  # cd into a git repo first
quicksave -r /path/to/repo                 # explicit repo path (repeatable)
quicksave --repo /path/to/repo             # long form
quicksave -c /path/for/coding              # coding-only path (non-git ok, repeatable)
quicksave -s wss://your-relay.example.com  # custom signaling server
quicksave --no-qr                          # suppress QR code
quicksave --restart                        # shut down existing daemon and start fresh
```

`quicksave pair` also accepts `--no-qr`.

## Debug commands

Available only when `QUICKSAVE_DEBUG=1` is set (auto-enabled in dev mode):

```bash
QUICKSAVE_DEBUG=1 quicksave service debug                 # peers, subscriptions, pending inputs, active sessions
QUICKSAVE_DEBUG=1 quicksave service sessions [--cwd <p>]  # list sessions (SDK + live state)
QUICKSAVE_DEBUG=1 quicksave service cards <id> \
    [--cwd <p>] [--limit <n>]                             # card history for a session (default limit 30)
QUICKSAVE_DEBUG=1 quicksave service resolve <id> [--deny] # force-resolve stuck permission (allow by default)
```

When debug mode is enabled the daemon also exposes a local-only HTTP
inspector — see "Debug HTTP server" below.

For the full IPC method reference (debug HTTP server + debug CLI bridge),
see [`quicksave-architecture.en.md`](./quicksave-architecture.en.md) §七.

## What the daemon does

- Maintains the WebSocket connection to the relay, does NaCl handshake
  with each paired PWA, and decrypts/dispatches every message.
- Executes git operations against managed repos (`status`, `diff`, stage,
  unstage, commit, branch, log, `.gitignore` edits, etc.).
- Manages coding-agent CLI sessions: spawns the agent CLI with stream-json
  I/O, parses the output into `Card` events, handles `control_request`
  permission prompts, forwards them to the PWA for approval, and streams
  card updates back.
- Generates commit messages either via Anthropic API (user-supplied key)
  or via an agentic `claude -p` loop that uses the user's local Claude
  subscription.
- Hosts a pool of PTY-backed interactive shells
  (`src/terminal/terminalManager.ts`, via `node-pty`) that the PWA can
  drive remotely. Each terminal keeps a bounded scrollback buffer so a
  reconnecting PWA can redraw the current screen without the shell having
  to repaint.
- Serves an IPC (Unix socket) JSON-RPC API for the CLI to query state
  and issue debug commands.
- Triggers Web Push notifications through the relay when a permission
  prompt arrives and no PWA peer is currently subscribed.

## Debug HTTP server

When `QUICKSAVE_DEBUG=1` (or dev mode) is active, the daemon also starts
a local-only HTTP inspector bound to `127.0.0.1:7927` (next free port if
`7927` is taken). Endpoints:

| Endpoint                          | Returns                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `GET /`                           | HTML overview, auto-refreshes every 2s                      |
| `GET /sessions`                   | JSON list of active sessions + card counts                  |
| `GET /sessions/:id/cards`         | Live card-builder cards for a session                       |
| `GET /sessions/:id/state`         | Full session + card-builder internal state                  |
| `GET /debug`                      | Same daemon snapshot as the `service debug` IPC method      |

## Environment variables

| Variable                              | Effect                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `QUICKSAVE_DEBUG=1`                   | Enable debug CLI commands, the debug HTTP server, and per-session JSONL debug logs (auto-on in dev). Set to `0` to force-disable in dev. |
| `QUICKSAVE_HOME`                      | Override the base directory (default `~/.quicksave`)              |
| `QUICKSAVE_MAX_DIFF_SIZE_KB`          | Cap on git diff size returned to the PWA (default `100`)          |
| `QUICKSAVE_PROVIDER=sdk`              | Force the Claude Agent SDK provider (instead of CLI)              |
| `QUICKSAVE_CLAUDE_TRANSPORT`          | Override the Claude Code transport selection                      |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW`     | Read on every turn — switches the Claude CLI auto-compact window without respawn |
| `OPENAI_API_KEY`                      | Treated as a Codex login (`method: 'api-key'`)                    |

## Data location

All paths derive from the base directory, which defaults to
`~/.quicksave` and can be overridden with `QUICKSAVE_HOME`.

| Path                                | Contents                                              |
| ----------------------------------- | ----------------------------------------------------- |
| `~/.quicksave/agent.json`           | Agent ID, NaCl + Ed25519 keypairs, TOFU-pinned PWA, `closed` flag, license, signaling URL, managed repos / coding paths |
| `~/.quicksave/run/service.sock`     | IPC Unix domain socket (mode `0600`)                  |
| `~/.quicksave/run/service.lock`     | Singleton lock (PID file)                             |
| `~/.quicksave/run/daemon.log`       | Log file used by the self-restart launcher            |
| `~/.quicksave/state/service.json`   | Live daemon state (pid, socket path, build id, heartbeat, peer count) |
| `~/.quicksave/state/sessions/`      | Per-session JSONL history (`<sessionId>/messages.jsonl`) |
| `~/.quicksave/state/session-registry/` | Session registry entries per project (`archived/` holds tombstoned entries) |
| `~/.quicksave/state/card-history/`  | Per-session card snapshots (`<sessionId>.json`)       |
| `~/.quicksave/state/quicksave.db`   | SQLite event store (turn ends, permissions, cache touches) |
| `~/.quicksave/logs/`                | Reserved log directory                                |
| `~/.quicksave/debug/`               | Per-session JSONL debug logs (only when debug mode is on): `<short>-raw.jsonl`, `<short>-cards.jsonl`, `<short>-snapshots.jsonl` |
