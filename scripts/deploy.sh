#!/bin/bash
#
# Deploy script - runs on the server
# Downloads latest artifacts from GitHub and restarts services
#
# This file is copied to /opt/quicksave/scripts/deploy.sh during setup
# Environment variables:
#   GITHUB_REPO - GitHub repo (default: KingYoung-Sumicom/quicksave)
#   DEPLOY_ENV  - Environment to deploy (staging|production, passed via webhook header)
#
set -e

REPO="${GITHUB_REPO:-KingYoung-Sumicom/quicksave}"
ENV="${DEPLOY_ENV:-staging}"
LOG="/var/log/quicksave-deploy.log"
API="https://api.github.com/repos/${REPO}"

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

# Auth header (optional — public repos work without it, but token avoids rate limits)
AUTH_HEADER=""
if [ -n "$GH_TOKEN" ]; then
    AUTH_HEADER="Authorization: Bearer $GH_TOKEN"
fi

curl_gh() {
    if [ -n "$AUTH_HEADER" ]; then
        curl -sL -H "$AUTH_HEADER" "$@"
    else
        curl -sL "$@"
    fi
}

# Get latest successful run for the branch
RUN_ID=$(curl_gh "${API}/actions/workflows/deploy.yml/runs?branch=${BRANCH}&status=success&per_page=1" \
    | python3 -c "import sys,json; runs=json.load(sys.stdin).get('workflow_runs',[]); print(runs[0]['id'] if runs else '')")

if [ -z "$RUN_ID" ]; then
    log "ERROR - No successful workflow runs found for branch $BRANCH"
    exit 1
fi

log "Downloading artifacts from run $RUN_ID (branch: $BRANCH)"

# Get artifact download URL
ARTIFACT_URL=$(curl_gh "${API}/actions/runs/${RUN_ID}/artifacts" \
    | python3 -c "import sys,json; arts=json.load(sys.stdin).get('artifacts',[]); matches=[a for a in arts if a['name']=='dist-${ENV}']; print(matches[0]['archive_download_url'] if matches else '')")

if [ -z "$ARTIFACT_URL" ]; then
    log "ERROR - Artifact dist-${ENV} not found in run $RUN_ID"
    exit 1
fi

# Download and extract artifact
rm -rf /tmp/quicksave-deploy
mkdir -p /tmp/quicksave-deploy
curl_gh "$ARTIFACT_URL" -o /tmp/quicksave-deploy/artifact.zip
unzip -q /tmp/quicksave-deploy/artifact.zip -d /tmp/quicksave-deploy
rm -f /tmp/quicksave-deploy/artifact.zip

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
