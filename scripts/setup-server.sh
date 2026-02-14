#!/bin/bash
#
# Initial server setup for quicksave.dev
# Supports both staging and production on the same server
#
# Usage: ssh root@your-server 'bash -s' < scripts/setup-server.sh
#
set -e

# Configuration - update these
DOMAIN="quicksave.dev"
GITHUB_REPO="KingYoung-Sumicom/quicksave"

# Derived domains
STAGING_DOMAIN="staging.${DOMAIN}"
SIGNAL_DOMAIN="signal.${DOMAIN}"
SIGNAL_STAGING_DOMAIN="signal-staging.${DOMAIN}"

# Generate deploy tokens
DEPLOY_TOKEN_PROD="$(openssl rand -hex 32)"
DEPLOY_TOKEN_STAGING="$(openssl rand -hex 32)"

echo "==> Installing dependencies..."
apt update
apt install -y curl gnupg rsync

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list
apt update && apt install -y gh

# Webhook
apt install -y webhook

echo "==> Creating directory structure..."
mkdir -p /opt/quicksave/{production,staging}/apps/{pwa,signaling}/dist
mkdir -p /opt/quicksave/scripts
mkdir -p /opt/webhook

echo "==> Setting up webhook..."
cat > /opt/webhook/hooks.json << EOF
[
  {
    "id": "deploy",
    "execute-command": "/opt/quicksave/scripts/deploy.sh",
    "command-working-directory": "/opt/quicksave",
    "pass-environment-to-command": [
      { "envname": "DEPLOY_ENV", "source": "header", "name": "X-Environment" }
    ],
    "trigger-rule": {
      "or": [
        {
          "match": {
            "type": "value",
            "value": "${DEPLOY_TOKEN_PROD}",
            "parameter": { "source": "header", "name": "X-Deploy-Token" }
          }
        },
        {
          "match": {
            "type": "value",
            "value": "${DEPLOY_TOKEN_STAGING}",
            "parameter": { "source": "header", "name": "X-Deploy-Token" }
          }
        }
      ]
    }
  }
]
EOF

cat > /etc/systemd/system/webhook.service << 'EOF'
[Unit]
Description=Webhook listener
After=network.target

[Service]
ExecStart=/usr/bin/webhook -hooks /opt/webhook/hooks.json -port 9000 -verbose
Restart=always

[Install]
WantedBy=multi-user.target
EOF

echo "==> Setting up signaling services..."

# Production signaling
cat > /etc/systemd/system/quicksave-signaling.service << 'EOF'
[Unit]
Description=Quicksave Signaling Server (Production)
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/quicksave/production
ExecStart=/usr/bin/node apps/signaling/dist/index.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

# Staging signaling
cat > /etc/systemd/system/quicksave-signaling-staging.service << 'EOF'
[Unit]
Description=Quicksave Signaling Server (Staging)
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/quicksave/staging
ExecStart=/usr/bin/node apps/signaling/dist/index.js
Restart=always
Environment=NODE_ENV=staging
Environment=PORT=8081

[Install]
WantedBy=multi-user.target
EOF

echo "==> Creating deploy script..."
cat > /opt/quicksave/scripts/deploy.sh << 'DEPLOY_SCRIPT'
#!/bin/bash
set -e

REPO="${GITHUB_REPO:-your-username/quicksave}"
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

# Determine which branch/workflow to pull from
BRANCH="main"
[[ "$ENV" == "staging" ]] && BRANCH="staging"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$ENV]: $1" | tee -a "$LOG"
}

log "Deploy triggered"

# Check gh is authenticated
if ! gh auth status &>/dev/null; then
    log "ERROR - GitHub CLI not authenticated. Run: gh auth login"
    exit 1
fi

# Get latest successful run for the branch
RUN_ID=$(gh run list --repo "$REPO" --workflow deploy.yml --branch "$BRANCH" --status success --limit 1 --json databaseId -q '.[0].databaseId')

if [ -z "$RUN_ID" ]; then
    log "ERROR - No successful workflow runs found for branch $BRANCH"
    exit 1
fi

log "Downloading artifacts from run $RUN_ID (branch: $BRANCH)"

# Download artifacts to temp directory
rm -rf /tmp/quicksave-deploy
gh run download "$RUN_ID" --repo "$REPO" --name dist --dir /tmp/quicksave-deploy

# Verify download
if [ ! -d "/tmp/quicksave-deploy/apps/pwa/dist" ]; then
    log "ERROR - PWA dist not found in artifacts"
    exit 1
fi

# Copy to environment directory
log "Syncing files to $DEPLOY_DIR..."
rsync -av --delete /tmp/quicksave-deploy/apps/pwa/dist/ "${DEPLOY_DIR}/apps/pwa/dist/"
rsync -av --delete /tmp/quicksave-deploy/apps/signaling/dist/ "${DEPLOY_DIR}/apps/signaling/dist/"

# Cleanup
rm -rf /tmp/quicksave-deploy

# Restart signaling server
log "Restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"

log "Deploy complete (run $RUN_ID)"
DEPLOY_SCRIPT

chmod +x /opt/quicksave/scripts/deploy.sh

echo "==> Enabling services..."
systemctl daemon-reload
systemctl enable webhook quicksave-signaling quicksave-signaling-staging
systemctl start webhook

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Server IP: $(curl -s ifconfig.me)"
echo ""
echo "==> DNS Records needed:"
echo "   A  ${DOMAIN}                -> $(curl -s ifconfig.me)"
echo "   A  ${STAGING_DOMAIN}        -> $(curl -s ifconfig.me)"
echo "   A  ${SIGNAL_DOMAIN}         -> $(curl -s ifconfig.me)"
echo "   A  ${SIGNAL_STAGING_DOMAIN} -> $(curl -s ifconfig.me)"
echo ""
echo "==> GitHub Environments to create:"
echo ""
echo "   Environment: production"
echo "     Variable: DEPLOY_URL = https://${SIGNAL_DOMAIN}/hooks/deploy"
echo "     Secret:   DEPLOY_TOKEN = ${DEPLOY_TOKEN_PROD}"
echo ""
echo "   Environment: staging"
echo "     Variable: DEPLOY_URL = https://${SIGNAL_STAGING_DOMAIN}/hooks/deploy"
echo "     Secret:   DEPLOY_TOKEN = ${DEPLOY_TOKEN_STAGING}"
echo ""
echo "==> Next steps:"
echo "   1. Point DNS records to this server"
echo "   2. Run: ./scripts/setup-nginx.sh   OR   ./scripts/setup-caddy.sh"
echo "   3. Authenticate GitHub CLI: gh auth login"
echo "   4. Update GITHUB_REPO in /opt/quicksave/scripts/deploy.sh"
echo "   5. Create GitHub environments with secrets above"
echo ""
