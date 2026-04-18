#!/usr/bin/env bash
# Schedule a delayed daemon restart, fully detached from the caller.
# Intended to be run from INSIDE the daemon's own process tree (e.g. a
# Claude CLI session spawned by the daemon) so the restart doesn't
# terminate the caller mid-stream.
#
# Usage:
#   ./scripts/dev-daemon-delayed.sh [delay_seconds]
#
# Default delay: 30s. The actual restart happens via dev-daemon.sh.
# Logs to $HOME/.quicksave/run/dev-daemon-delayed.log so you can tail
# progress while waiting.
#
# Why `setsid`: detaches the spawned shell into a new session, so when
# dev-daemon.sh SIGTERM's the old daemon, signal propagation to the
# daemon's process group doesn't reach this delayed-restart shell.
set -euo pipefail

DELAY="${1:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$HOME/.quicksave/run"
LOG_FILE="$RUN_DIR/dev-daemon-delayed.log"

mkdir -p "$RUN_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scheduling dev-daemon restart in ${DELAY}s (caller pid=$$)" >> "$LOG_FILE"

# setsid: new session, new pgroup — survives the old daemon's death.
# nohup: ignore SIGHUP (belt-and-suspenders; setsid usually enough).
# Redirects are essential — any lingering stdio tied to the daemon
# would keep us in its death chain.
setsid nohup bash -c "
  sleep $DELAY
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] Firing restart (our pid=\$\$)\" >> '$LOG_FILE'
  bash '$SCRIPT_DIR/dev-daemon.sh' >> '$LOG_FILE' 2>&1
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] Restart done (exit=\$?)\" >> '$LOG_FILE'
" < /dev/null >> "$LOG_FILE" 2>&1 &

disown || true

echo "Scheduled restart in ${DELAY}s. Tail: tail -f $LOG_FILE"
