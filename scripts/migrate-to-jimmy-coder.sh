#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'

HOST="jimmy-coder"
REMOTE_HOME="/home/jimmy"
REMOTE_PROJECT_DIR="/home/jimmy/workspace/quicksave"
DRY_RUN=0
INCLUDE_CREDENTIALS=0
DELETE_PROJECT=0
DELETE_CLAUDE=0

usage() {
  cat <<'EOF'
Usage: scripts/migrate-to-jimmy-coder.sh [options]

Sync this repo plus selected Claude Code state to a remote host.

Defaults:
  host                 jimmy-coder
  remote project dir   /home/jimmy/workspace/quicksave
  remote Claude dir    /home/jimmy/.claude

Options:
  --host HOST                 SSH host or alias to sync to
  --remote-home PATH          Remote home directory
  --remote-project-dir PATH   Remote project directory
  --dry-run                   Show what would be transferred
  --include-credentials       Also copy ~/.claude/.credentials.json
  --delete-project            Delete remote files not present locally in the project dir
  --delete-claude             Delete remote files not present locally in the selected ~/.claude subset
  -h, --help                  Show this help text

Notes:
  - Project sync preserves .git history and repo-local .claude files.
  - Global Claude Code state is synced selectively: settings, memory, history, sessions, projects, todos, hooks, commands, plugins, skills, and backups.
  - Login credentials are excluded by default.
EOF
}

while (($# > 0)); do
  case "$1" in
    --host)
      HOST="${2:?missing value for --host}"
      shift 2
      ;;
    --remote-home)
      REMOTE_HOME="${2:?missing value for --remote-home}"
      shift 2
      ;;
    --remote-project-dir)
      REMOTE_PROJECT_DIR="${2:?missing value for --remote-project-dir}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --include-credentials)
      INCLUDE_CREDENTIALS=1
      shift
      ;;
    --delete-project)
      DELETE_PROJECT=1
      shift
      ;;
    --delete-claude)
      DELETE_CLAUDE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCAL_CLAUDE_DIR="${HOME}/.claude"
REMOTE_CLAUDE_DIR="${REMOTE_HOME}/.claude"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd ssh
require_cmd rsync

if [[ ! -d "${PROJECT_ROOT}/.git" ]]; then
  echo "Expected a git repo at ${PROJECT_ROOT}" >&2
  exit 1
fi

PROJECT_EXCLUDES=(
  --exclude '.DS_Store'
  --exclude 'node_modules/'
  --exclude '.pnpm-store/'
  --exclude '.turbo/'
  --exclude 'coverage/'
  --exclude '.coverage/'
  --exclude 'dist/'
  --exclude 'apps/agent/dist/'
  --exclude 'apps/pwa/dist/'
  --exclude 'apps/relay/dist/'
  --exclude 'tmp/'
)

CLAUDE_ITEMS=(
  ".claude/CLAUDE.md"
  ".claude/settings.json"
  ".claude/backups"
  ".claude/commands"
  ".claude/file-history"
  ".claude/history.jsonl"
  ".claude/hooks"
  ".claude/ide"
  ".claude/memory"
  ".claude/plans"
  ".claude/plugins"
  ".claude/projects"
  ".claude/sessions"
  ".claude/skills"
  ".claude/todos"
)

if (( INCLUDE_CREDENTIALS )); then
  CLAUDE_ITEMS+=(".claude/.credentials.json")
fi

EXISTING_CLAUDE_ITEMS=()
for item in "${CLAUDE_ITEMS[@]}"; do
  if [[ -e "${HOME}/${item}" ]]; then
    EXISTING_CLAUDE_ITEMS+=("${item}")
  fi
done

PROJECT_RSYNC_OPTS=(
  --archive
  --compress
  --human-readable
  --partial
  --progress
)

CLAUDE_RSYNC_OPTS=(
  --archive
  --compress
  --human-readable
  --partial
  --progress
  --relative
)

if (( DRY_RUN )); then
  PROJECT_RSYNC_OPTS+=(--dry-run --itemize-changes)
  CLAUDE_RSYNC_OPTS+=(--dry-run --itemize-changes)
fi

if (( DELETE_PROJECT )); then
  PROJECT_RSYNC_OPTS+=(--delete)
fi

if (( DELETE_CLAUDE )); then
  CLAUDE_RSYNC_OPTS+=(--delete)
fi

echo "Remote host:         ${HOST}"
echo "Remote project dir:  ${REMOTE_PROJECT_DIR}"
echo "Remote Claude dir:   ${REMOTE_CLAUDE_DIR}"
echo "Project root:        ${PROJECT_ROOT}"
echo "Dry run:             ${DRY_RUN}"
echo "Include credentials: ${INCLUDE_CREDENTIALS}"
echo

echo "Claude items selected for sync:"
if ((${#EXISTING_CLAUDE_ITEMS[@]} == 0)); then
  echo "  (none found under ${LOCAL_CLAUDE_DIR})"
else
  for item in "${EXISTING_CLAUDE_ITEMS[@]}"; do
    echo "  - ~/${item}"
  done
fi
echo

echo "Ensuring remote directories exist..."
ssh "${HOST}" "mkdir -p '${REMOTE_PROJECT_DIR}' '${REMOTE_CLAUDE_DIR}'"

echo
echo "Syncing project to ${HOST}:${REMOTE_PROJECT_DIR}/ ..."
rsync \
  "${PROJECT_RSYNC_OPTS[@]}" \
  "${PROJECT_EXCLUDES[@]}" \
  "${PROJECT_ROOT}/" \
  "${HOST}:${REMOTE_PROJECT_DIR}/"

if ((${#EXISTING_CLAUDE_ITEMS[@]} > 0)); then
  echo
  echo "Syncing selected Claude Code state to ${HOST}:${REMOTE_CLAUDE_DIR}/ ..."
  (
    cd "${HOME}"
    rsync \
      "${CLAUDE_RSYNC_OPTS[@]}" \
      "${EXISTING_CLAUDE_ITEMS[@]}" \
      "${HOST}:${REMOTE_HOME}/"
  )
fi

echo
if (( DRY_RUN )); then
  echo "Dry run complete."
else
  echo "Migration sync complete."
fi
