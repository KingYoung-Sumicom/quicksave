#!/bin/bash
#
# Deploy script - runs on the server
# Downloads latest artifacts from GitHub and restarts services
#
# This file is copied to /opt/quicksave/scripts/deploy.sh during setup
# Environment variables:
#   GITHUB_REPO - GitHub repo (default: KingYoung-Sumicom/quicksave)
#   DEPLOY_ENV  - Environment to deploy (staging|production, passed via webhook header)
#   RUN_ID      - GitHub Actions run ID (passed via webhook header, skips API lookup)
#
set -e

REPO="${GITHUB_REPO:-KingYoung-Sumicom/quicksave}"
ENV="${DEPLOY_ENV:-staging}"
LOG="/var/log/quicksave-deploy.log"

# Validate environment
if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
    echo "$(date): ERROR - Invalid environment: $ENV" >> "$LOG"
    exit 1
fi

DEPLOY_DIR="/opt/quicksave/${ENV}"
SERVICE_NAME="quicksave-signaling"
[[ "$ENV" == "staging" ]] && SERVICE_NAME="quicksave-signaling-staging"

# Determine which branch to pull from
BRANCH="stable"
[[ "$ENV" == "staging" ]] && BRANCH="staging"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$ENV]: $1" | tee -a "$LOG"
}

log "Deploy triggered"

# Use run ID from webhook header if provided, otherwise find latest successful run
if [ -z "$RUN_ID" ]; then
    RUN_ID=$(gh run list --repo "$REPO" --workflow deploy.yml --branch "$BRANCH" --status success --limit 1 --json databaseId -q '.[0].databaseId')
fi

if [ -z "$RUN_ID" ]; then
    log "ERROR - No successful workflow runs found for branch $BRANCH"
    exit 1
fi

log "Downloading artifacts from run $RUN_ID (branch: $BRANCH)"

# Download and extract artifact
rm -rf /tmp/quicksave-deploy
gh run download "$RUN_ID" --repo "$REPO" --name "dist-${ENV}" --dir /tmp/quicksave-deploy

# Verify download
if [ ! -d "/tmp/quicksave-deploy/pwa/dist" ]; then
    log "ERROR - PWA dist not found in artifacts"
    exit 1
fi

if [ ! -d "/tmp/quicksave-deploy/relay/dist" ]; then
    log "ERROR - Relay dist not found in artifacts"
    exit 1
fi

# Copy to environment directory
log "Syncing files to $DEPLOY_DIR..."
rsync -av --delete /tmp/quicksave-deploy/pwa/dist/ "${DEPLOY_DIR}/apps/pwa/dist/"
rsync -av --delete /tmp/quicksave-deploy/relay/dist/ "${DEPLOY_DIR}/apps/relay/dist/"

# Cleanup
rm -rf /tmp/quicksave-deploy

# Restart signaling server
log "Restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"

log "Deploy complete (run $RUN_ID)"
