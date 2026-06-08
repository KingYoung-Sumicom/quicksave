#!/bin/bash
#
# Deploy script - runs on the server
# Downloads GitHub Actions artifacts and switches the live release atomically.
#
# This file is copied to /opt/quicksave/scripts/deploy.sh during setup.
# Environment variables:
#   GITHUB_REPO - GitHub repo (default: KingYoung-Sumicom/quicksave)
#   DEPLOY_ENV  - Environment to deploy (staging|production, passed by webhook)
#   RUN_ID      - GitHub Actions run ID (passed by webhook, preferred)
#
set -euo pipefail

REPO="${GITHUB_REPO:-KingYoung-Sumicom/quicksave}"
ENV="${DEPLOY_ENV:-staging}"
RUN_ID="${RUN_ID:-}"
LOG="/var/log/quicksave-deploy.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$ENV]: $1" | tee -a "$LOG"
}

if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
    log "ERROR - Invalid environment: $ENV"
    exit 1
fi

DEPLOY_DIR="/opt/quicksave/${ENV}"
RELEASES_DIR="${DEPLOY_DIR}/releases"
APPS_LINK="${DEPLOY_DIR}/apps"
LOCK_FILE="/var/lock/quicksave-deploy-${ENV}.lock"
SERVICE_NAME="quicksave-signaling"
HEALTH_URL="http://127.0.0.1:8080/health"
BRANCH="stable"
if [[ "$ENV" == "staging" ]]; then
    SERVICE_NAME="quicksave-signaling-staging"
    HEALTH_URL="http://127.0.0.1:8081/health"
    BRANCH="staging"
fi

TMP_DIR=""
PREVIOUS_TARGET=""
ROLLED_BACK=0

cleanup() {
    if [[ -n "$TMP_DIR" ]]; then
        rm -rf "$TMP_DIR"
    fi
}
trap cleanup EXIT

switch_apps_link() {
    local target="$1"
    local tmp_link="${APPS_LINK}.next"
    ln -sfn "$target" "$tmp_link"
    mv -Tf "$tmp_link" "$APPS_LINK"
}

rollback() {
    local reason="$1"
    if [[ "$ROLLED_BACK" == "1" ]]; then
        return
    fi
    ROLLED_BACK=1
    if [[ -z "$PREVIOUS_TARGET" || ! -d "$PREVIOUS_TARGET" ]]; then
        log "ERROR - $reason; no previous release available for rollback"
        return
    fi
    log "Rolling back to $PREVIOUS_TARGET ($reason)"
    switch_apps_link "$PREVIOUS_TARGET"
    if ! systemctl restart "$SERVICE_NAME"; then
        log "ERROR - Rollback restart failed for $SERVICE_NAME"
        return
    fi
    if wait_for_health "$HEALTH_URL"; then
        log "Rollback health check passed"
    else
        log "ERROR - Rollback health check failed"
    fi
}

wait_for_health() {
    local url="$1"
    for _ in $(seq 1 20); do
        if curl -fsS --max-time 2 "$url" >/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "ERROR - Another deploy is already running for $ENV"
    exit 1
fi

log "Deploy triggered"

if [[ -z "$RUN_ID" ]]; then
    log "RUN_ID not provided; falling back to latest successful $BRANCH deploy.yml run"
    RUN_ID="$(gh run list --repo "$REPO" --workflow deploy.yml --branch "$BRANCH" --status success --limit 1 --json databaseId -q '.[0].databaseId')"
fi

if [[ -z "$RUN_ID" ]]; then
    log "ERROR - No successful workflow runs found for branch $BRANCH"
    exit 1
fi

mkdir -p "$RELEASES_DIR"
TMP_DIR="$(mktemp -d "/tmp/quicksave-deploy-${ENV}-${RUN_ID}.XXXXXX")"
NEW_RELEASE="${RELEASES_DIR}/${RUN_ID}"

if [[ -e "$NEW_RELEASE" ]]; then
    log "Removing existing incomplete release $NEW_RELEASE"
    rm -rf "$NEW_RELEASE"
fi

log "Downloading dist-${ENV} artifact from run $RUN_ID"
gh run download "$RUN_ID" --repo "$REPO" --name "dist-${ENV}" --dir "$TMP_DIR"

if [[ ! -d "${TMP_DIR}/apps/pwa/dist" ]]; then
    log "ERROR - PWA dist not found in artifact"
    exit 1
fi

if [[ ! -d "${TMP_DIR}/apps/relay/dist" ]]; then
    log "ERROR - Relay dist not found in artifact"
    exit 1
fi

mkdir -p "${NEW_RELEASE}/apps/pwa" "${NEW_RELEASE}/apps/relay"
log "Syncing artifact into release $NEW_RELEASE"
rsync -a --delete "${TMP_DIR}/apps/pwa/dist/" "${NEW_RELEASE}/apps/pwa/dist/"
rsync -a --delete "${TMP_DIR}/apps/relay/dist/" "${NEW_RELEASE}/apps/relay/dist/"

if [[ ! -f "${NEW_RELEASE}/apps/pwa/dist/index.html" ]]; then
    log "ERROR - Release is missing PWA index.html"
    exit 1
fi

if [[ ! -f "${NEW_RELEASE}/apps/relay/dist/bundle.cjs" ]]; then
    log "ERROR - Release is missing relay bundle.cjs"
    exit 1
fi

if [[ -L "$APPS_LINK" ]]; then
    PREVIOUS_TARGET="$(readlink -f "$APPS_LINK")"
elif [[ -d "$APPS_LINK" ]]; then
    LEGACY_RELEASE="${RELEASES_DIR}/legacy-$(date +%Y%m%d%H%M%S)"
    log "Converting existing apps directory into legacy release $LEGACY_RELEASE"
    mkdir -p "$LEGACY_RELEASE"
    mv "$APPS_LINK" "${LEGACY_RELEASE}/apps"
    PREVIOUS_TARGET="${LEGACY_RELEASE}/apps"
else
    PREVIOUS_TARGET=""
fi

log "Switching live apps symlink to $NEW_RELEASE"
switch_apps_link "${NEW_RELEASE}/apps"

log "Restarting $SERVICE_NAME"
if ! systemctl restart "$SERVICE_NAME"; then
    rollback "systemctl restart failed"
    exit 1
fi

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    rollback "service is not active after restart"
    exit 1
fi

log "Checking health at $HEALTH_URL"
if ! wait_for_health "$HEALTH_URL"; then
    rollback "health check failed"
    exit 1
fi

log "Deploy complete (run $RUN_ID, release $NEW_RELEASE)"
