# @sumicom/quicksave — desktop agent

Background daemon that runs on your development machine and connects your
Quicksave PWA (phone or browser) to the local git working tree and Claude
Code CLI sessions. All communication is end-to-end encrypted; the relay
server never sees plaintext.

## Install

```bash
npm install -g @sumicom/quicksave
```

## Usage

```bash
# cd into a git repo, then:
quicksave

# or point at an explicit repo:
quicksave --repo /path/to/repo

# custom signaling server:
quicksave -s wss://your-relay.example.com
```

On first run this prints a pairing URL and QR code. Scan it from the
[Quicksave PWA](https://quicksave.dev) to connect.

The CLI auto-launches a background daemon (`quicksave service run`) and
then exits. The daemon keeps running; future `quicksave` invocations just
attach to it to add repos or re-read pairing info.

## Subcommands

| Command                          | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `quicksave`                      | Start / ensure daemon; print pairing URL + QR                |
| `quicksave rotate-keys`          | Generate a new keypair (invalidates paired PWAs)             |
| `quicksave service start`        | Start daemon in the background                               |
| `quicksave service stop`         | Stop the running daemon                                      |
| `quicksave service status`       | Live status (pid, peers, active sessions, managed repos)     |
| `quicksave service info`         | Static status from `service.json` (no IPC)                   |
| `quicksave service run`          | Run daemon in foreground (not normally invoked directly)     |

### Debug commands

Available only when `QUICKSAVE_DEBUG=1` is set (auto-enabled in dev mode):

```bash
QUICKSAVE_DEBUG=1 quicksave service debug          # full state snapshot
QUICKSAVE_DEBUG=1 quicksave service sessions       # list all Claude sessions
QUICKSAVE_DEBUG=1 quicksave service cards <id>     # card history for a session
QUICKSAVE_DEBUG=1 quicksave service resolve <id>   # force-resolve stuck permission
```

## What the daemon does

- Maintains the WebSocket connection to the relay, does NaCl handshake with
  each paired PWA, and decrypts/dispatches every message.
- Executes git operations against managed repos (`status`, `diff`, stage,
  unstage, commit, branch, log, `.gitignore` edits, etc.).
- Manages Claude Code CLI sessions: spawns `claude` with stream-json I/O,
  parses the output into `Card` events, handles `control_request`
  permission prompts, forwards them to the PWA for approval, and streams
  card updates back.
- Generates commit messages either via Anthropic API (user-supplied key)
  or via an agentic `claude -p` loop that uses the user's local Claude
  subscription.
- Hosts a pool of PTY-backed interactive shells (`src/terminal/terminalManager.ts`,
  via `node-pty`) that the PWA can drive remotely. Each terminal keeps a
  bounded scrollback buffer so a reconnecting PWA can redraw the current
  screen without the shell having to repaint.
- Serves an IPC (Unix socket) JSON-RPC API for the CLI to query state and
  issue debug commands.
- Triggers Web Push notifications through the relay when a permission
  prompt arrives and no PWA peer is currently subscribed.

## Architecture

See [`docs/references/quicksave-architecture.md`](../../docs/references/quicksave-architecture.md)
for the full design — session lifecycle, MessageBus wiring, permission
flow, commit-summary pipeline, IPC protocol.

## Data location

| Path                            | Contents                                          |
| ------------------------------- | ------------------------------------------------- |
| `~/.quicksave/config.json`      | Agent ID, NaCl keypairs, managed repo list        |
| `~/.quicksave/run/service.json` | Live daemon state (pid, socket path, heartbeat)   |
| `~/.quicksave/run/*.sock`       | IPC socket                                        |
| `~/.quicksave/sessions/`        | Per-session JSONL history (Claude Code CLI)       |

## Development

```bash
# from monorepo root
pnpm --filter @sumicom/quicksave dev              # tsx watch
pnpm --filter @sumicom/quicksave test             # vitest
pnpm --filter @sumicom/quicksave build            # tsc
```

Fast restart-from-source during active development:

```bash
./scripts/dev-daemon.sh                           # kill + spawn
./scripts/dev-daemon-delayed.sh 30                # delayed variant — safe
                                                  # when called from inside a
                                                  # daemon-spawned Claude CLI
```

## License

MIT
