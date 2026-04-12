#!/usr/bin/env bash
# Restart quicksave daemon from source (dev mode).
# Usage: ./scripts/dev-daemon.sh
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "$0")/../apps/agent" && pwd)"
RUN_DIR="$HOME/.quicksave/run"
LOG_FILE="$RUN_DIR/daemon.log"
LOCK_FILE="$RUN_DIR/service.lock"
SOCK_FILE="$RUN_DIR/service.sock"

# 1. Kill existing daemon
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing daemon (pid: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    for i in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Force killing..."
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  rm -f "$LOCK_FILE" "$SOCK_FILE"
fi

# 2. Start dev daemon
echo "Starting dev daemon from $AGENT_DIR..."
cd "$AGENT_DIR"
nohup node --import tsx src/index.ts service run >> "$LOG_FILE" 2>&1 &
DEV_PID=$!
echo "Spawned pid: $DEV_PID"

# 3. Wait for ready
for i in $(seq 1 30); do
  sleep 0.3
  if [ -f "$HOME/.quicksave/state/service.json" ]; then
    STATE_PID=$(python3 -c "import json; print(json.load(open('$HOME/.quicksave/state/service.json'))['pid'])" 2>/dev/null || true)
    if [ -n "$STATE_PID" ] && kill -0 "$STATE_PID" 2>/dev/null; then
      VERSION=$(python3 -c "import json; d=json.load(open('$HOME/.quicksave/state/service.json')); print(f'v{d[\"version\"]} ({d[\"buildId\"]})')" 2>/dev/null || echo "?")
      echo "Dev daemon ready: pid=$STATE_PID $VERSION"
      exit 0
    fi
  fi
done

echo "Timeout waiting for daemon. Check: tail $LOG_FILE"
exit 1
