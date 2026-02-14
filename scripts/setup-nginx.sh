#!/bin/bash
#
# Setup Nginx as reverse proxy with Let's Encrypt SSL
# More control, familiar to most devops
#
# Usage: ssh root@your-server 'bash -s' < scripts/setup-nginx.sh
#
set -e

DOMAIN="${DOMAIN:-quicksave.dev}"
STAGING_DOMAIN="staging.${DOMAIN}"
SIGNAL_DOMAIN="signal.${DOMAIN}"
SIGNAL_STAGING_DOMAIN="signal-staging.${DOMAIN}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"

echo "==> Installing Nginx and Certbot..."
apt update
apt install -y nginx certbot python3-certbot-nginx

echo "==> Stopping Nginx temporarily..."
systemctl stop nginx

echo "==> Creating Nginx configuration..."

# Production PWA
cat > /etc/nginx/sites-available/${DOMAIN} << EOF
server {
    listen 80;
    server_name ${DOMAIN};

    root /opt/quicksave/production/apps/pwa/dist;
    index index.html;

    # Security headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # SPA routing
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Cache static assets
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# Staging PWA
cat > /etc/nginx/sites-available/${STAGING_DOMAIN} << EOF
server {
    listen 80;
    server_name ${STAGING_DOMAIN};

    root /opt/quicksave/staging/apps/pwa/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# Production Signaling
cat > /etc/nginx/sites-available/${SIGNAL_DOMAIN} << EOF
server {
    listen 80;
    server_name ${SIGNAL_DOMAIN};

    # Webhook endpoint
    location /hooks/ {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # WebSocket signaling
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400;
    }
}
EOF

# Staging Signaling
cat > /etc/nginx/sites-available/${SIGNAL_STAGING_DOMAIN} << EOF
server {
    listen 80;
    server_name ${SIGNAL_STAGING_DOMAIN};

    location /hooks/ {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 86400;
    }
}
EOF

echo "==> Enabling sites..."
ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/${STAGING_DOMAIN} /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/${SIGNAL_DOMAIN} /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/${SIGNAL_STAGING_DOMAIN} /etc/nginx/sites-enabled/

# Remove default site
rm -f /etc/nginx/sites-enabled/default

echo "==> Testing Nginx configuration..."
nginx -t

echo "==> Starting Nginx..."
systemctl start nginx
systemctl enable nginx

echo ""
echo "==> Nginx setup complete (HTTP only)!"
echo ""
echo "==> To enable SSL, ensure DNS is pointing to this server, then run:"
echo ""
echo "   certbot --nginx -d ${DOMAIN} -d ${STAGING_DOMAIN} -d ${SIGNAL_DOMAIN} -d ${SIGNAL_STAGING_DOMAIN} --email ${EMAIL} --agree-tos --non-interactive"
echo ""
echo "Or run each domain separately if not all DNS records are ready:"
echo "   certbot --nginx -d ${DOMAIN} --email ${EMAIL} --agree-tos"
echo "   certbot --nginx -d ${STAGING_DOMAIN} --email ${EMAIL} --agree-tos"
echo "   certbot --nginx -d ${SIGNAL_DOMAIN} --email ${EMAIL} --agree-tos"
echo "   certbot --nginx -d ${SIGNAL_STAGING_DOMAIN} --email ${EMAIL} --agree-tos"
echo ""
