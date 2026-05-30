#!/usr/bin/env bash
# Schedule a delayed daemon restart, fully detached from the caller.
# If invoked from INSIDE the daemon's own process tree (e.g. a Codex or
# Claude session spawned by the daemon), the restart will kill that session
# when the old daemon stops. Use a delay long enough for the current tool call
# to return before the restart fires.
#
# Usage:
#   ./scripts/dev-daemon-delayed.sh [--force] [delay_seconds]
#
#   --force    Accepted for backwards compatibility. Restarts are forced by
#              default because daemon-owned provider sessions are children of
#              the daemon and cannot survive this restart path.
#
# Default delay: 30s. The actual restart happens via dev-daemon.sh after
# the delay.
# Logs to $HOME/.quicksave/run/dev-daemon-delayed.log so you can tail
# progress while waiting.
#
# Why `setsid`: detaches the spawned shell into a new session. This only
# protects the restart worker process itself; active daemon-owned agent
# sessions are killed when the daemon exits.
set -euo pipefail

if [ "${1:-}" = "--force" ]; then
  shift
fi

DELAY="${1:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$HOME/.quicksave/run"
LOG_FILE="$RUN_DIR/dev-daemon-delayed.log"

mkdir -p "$RUN_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scheduling forced dev-daemon restart in ${DELAY}s — caller agent session will be killed if daemon-owned (caller pid=$$)" >> "$LOG_FILE"

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

echo "Scheduled forced restart in ${DELAY}s — daemon-owned agent sessions WILL BE KILLED. Tail: tail -f $LOG_FILE"
