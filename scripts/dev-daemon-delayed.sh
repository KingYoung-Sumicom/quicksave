#!/usr/bin/env bash
# Schedule a delayed daemon restart, fully detached from the caller.
# If invoked from INSIDE the daemon's own process tree (e.g. a Codex or
# Claude session spawned by the daemon), the restart waits until that
# session process exits before stopping the daemon. Restarting the daemon
# while it owns the current agent session would kill that session.
#
# Usage:
#   ./scripts/dev-daemon-delayed.sh [--force] [delay_seconds]
#
#   --force    Skip the guard-pid wait. The restart proceeds after the
#              delay regardless of whether the caller is the daemon's own
#              agent session. Use this when you accept that the calling
#              Claude / Codex conversation will be killed (e.g. you want
#              the new provider available immediately and will restart
#              the conversation yourself).
#
# Default delay: 30s. The actual restart happens via dev-daemon.sh after
# the current agent session has exited, when applicable.
# Logs to $HOME/.quicksave/run/dev-daemon-delayed.log so you can tail
# progress while waiting.
#
# Why `setsid`: detaches the spawned shell into a new session. This only
# protects the restart worker process itself; the active agent session is
# protected by waiting for its daemon-child guard PID to exit naturally.
set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi

DELAY="${1:-30}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$HOME/.quicksave/run"
LOG_FILE="$RUN_DIR/dev-daemon-delayed.log"
LOCK_FILE="$RUN_DIR/service.lock"

mkdir -p "$RUN_DIR"

find_daemon_child_guard() {
  local daemon_pid="$1"
  local pid="$$"
  local ppid=""

  while [ -n "$pid" ] && [ "$pid" != "1" ]; do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ -z "$ppid" ]; then
      return 1
    fi
    if [ "$ppid" = "$daemon_pid" ]; then
      printf '%s\n' "$pid"
      return 0
    fi
    pid="$ppid"
  done

  return 1
}

GUARD_PID=""
if [ "$FORCE" = "0" ]; then
  OLD_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    GUARD_PID="$(find_daemon_child_guard "$OLD_PID" || true)"
  fi
fi

if [ -n "$GUARD_PID" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scheduling dev-daemon restart after guard pid $GUARD_PID exits, then ${DELAY}s delay (caller pid=$$)" >> "$LOG_FILE"
elif [ "$FORCE" = "1" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scheduling forced dev-daemon restart in ${DELAY}s — caller agent session will be killed (caller pid=$$)" >> "$LOG_FILE"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scheduling dev-daemon restart in ${DELAY}s (caller pid=$$)" >> "$LOG_FILE"
fi

# setsid: new session, new pgroup — survives the old daemon's death.
# nohup: ignore SIGHUP (belt-and-suspenders; setsid usually enough).
# Redirects are essential — any lingering stdio tied to the daemon
# would keep us in its death chain.
setsid nohup bash -c "
  if [ -n '$GUARD_PID' ]; then
    echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] Waiting for guard pid $GUARD_PID before restart\" >> '$LOG_FILE'
    while kill -0 '$GUARD_PID' 2>/dev/null; do
      sleep 2
    done
    echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] Guard pid $GUARD_PID exited\" >> '$LOG_FILE'
  fi
  sleep $DELAY
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] Firing restart (our pid=\$\$)\" >> '$LOG_FILE'
  bash '$SCRIPT_DIR/dev-daemon.sh' >> '$LOG_FILE' 2>&1
  echo \"[\$(date '+%Y-%m-%d %H:%M:%S')] Restart done (exit=\$?)\" >> '$LOG_FILE'
" < /dev/null >> "$LOG_FILE" 2>&1 &

disown || true

if [ -n "$GUARD_PID" ]; then
  echo "Scheduled restart after guard pid $GUARD_PID exits, then ${DELAY}s. Tail: tail -f $LOG_FILE"
elif [ "$FORCE" = "1" ]; then
  echo "Scheduled forced restart in ${DELAY}s — caller agent session WILL BE KILLED. Tail: tail -f $LOG_FILE"
else
  echo "Scheduled restart in ${DELAY}s. Tail: tail -f $LOG_FILE"
fi
