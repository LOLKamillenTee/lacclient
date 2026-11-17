#!/usr/bin/env bash
# LAC sync service on a fresh Ubuntu VM (Oracle Cloud Always Free, ARM or x86).
# usage:  sudo DOMAIN=meinname.duckdns.org bash setup.sh
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. sudo DOMAIN=meinname.duckdns.org bash setup.sh}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential python3 gpg debian-keyring debian-archive-keyring apt-transport-https sqlite3 iptables-persistent
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# Caddy (HTTPS certificate by itself)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy
# the service
id lac >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin lac
if [ -d /opt/lac/.git ]; then git -C /opt/lac pull -q; else git clone -q https://github.com/LOLKamillenTee/lacclient.git /opt/lac; fi
(cd /opt/lac/server/node && npm install --omit=dev)
mkdir -p /var/lib/lac && chown -R lac:lac /var/lib/lac /opt/lac
cat > /etc/systemd/system/lac-sync.service <<UNIT
[Unit]
Description=LAC sync service
After=network.target
[Service]
User=lac
WorkingDirectory=/opt/lac/server/node
Environment=PORT=8787
Environment=DB=/var/lib/lac/lac.db
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
# Ubuntu images on Oracle block everything but SSH: open 80 and 443
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
netfilter-persistent save
# a copy of the database every night (7 days kept)
cat > /etc/cron.d/lac-backup <<CRON
0 4 * * * lac sqlite3 /var/lib/lac/lac.db ".backup '/var/lib/lac/backup-\$(date +\%u).db'"
CRON
systemctl daemon-reload
systemctl enable --now lac-sync
systemctl restart caddy
echo "ready: https://$DOMAIN/v1/packs should answer {\"packs\":[]}"
