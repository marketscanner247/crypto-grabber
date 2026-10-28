#!/usr/bin/env bash
# Crypto Grabber alert server: one-time setup on a fresh Ubuntu 24.04 server.
# Run it as root on the server:
#   curl -fsSL https://raw.githubusercontent.com/marketscanner247/crypto-grabber/main/server/setup.sh | bash
# It installs Node and a headless browser, copies the app from GitHub, asks for your Telegram details once
# (kept only on this server, in /etc/crypto-grabber.env), and runs the alert check every 5 minutes.
# Safe to run again: it updates instead of reinstalling.
set -euo pipefail
REPO="${REPO:-https://github.com/marketscanner247/crypto-grabber.git}"
DIR=/opt/crypto-grabber ENVF=/etc/crypto-grabber.env BROWSERS=/opt/cg-browsers
[ "$(id -u)" = 0 ] || { echo "Please run this as root (or put sudo in front)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/5 System packages"
apt-get update -qq
apt-get install -y -qq git nodejs npm ca-certificates >/dev/null
timedatectl set-timezone America/Toronto 2>/dev/null || true
# small servers (1–2 GB RAM): add 2 GB of swap so the headless browser never runs out of memory
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 3000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "   added 2 GB swap"
fi
id cg >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/cg --shell /usr/sbin/nologin cg

echo "== 2/5 App from GitHub"
if [ -d "$DIR/.git" ]; then runuser -u cg -- git -C "$DIR" pull -q --ff-only
else git clone -q "$REPO" "$DIR"; chown -R cg:cg "$DIR"; fi

echo "== 3/5 Headless browser (takes a few minutes)"
mkdir -p "$BROWSERS"; chown cg:cg "$BROWSERS"
runuser -u cg -- env HOME=/var/lib/cg PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" bash -c \
  "cd $DIR/bot && npm install --no-audit --no-fund --silent && npx playwright install chromium"
(cd "$DIR/bot" && PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" npx playwright install-deps chromium >/dev/null)

echo "== 4/5 Telegram details"
if [ ! -s "$ENVF" ]; then
  read -rsp "Paste your Telegram bot token (hidden), then press Enter: " TOK </dev/tty; echo
  read -rp  "Paste your Telegram chat id, then press Enter: " CHAT </dev/tty
  OWNER=$(echo "$REPO" | sed -E 's#.*github.com[/:]([^/]+)/([^/.]+).*#\1#'); NAME=$(echo "$REPO" | sed -E 's#.*github.com[/:]([^/]+)/([^/.]+).*#\2#')
  umask 077
  cat > "$ENVF" <<EOF
TELEGRAM_TOKEN=$TOK
TELEGRAM_CHAT_ID=$CHAT
ALERT_MIN=risk
ENTRY=zone
ALERT_TFS=4h
TZ_NAME=America/Toronto
SITE_URL=https://$(echo "$OWNER" | tr 'A-Z' 'a-z').github.io/$NAME/
PLAYWRIGHT_BROWSERS_PATH=$BROWSERS
HOME=/var/lib/cg
EOF
  chmod 600 "$ENVF"
else echo "   already saved in $ENVF (edit that file to change them)"; fi

echo "== 5/5 Every-5-minutes timer"
cat > /etc/systemd/system/crypto-grabber.service <<EOF
[Unit]
Description=Crypto Grabber alert check
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=cg
Group=cg
EnvironmentFile=$ENVF
ExecStart=/bin/bash $DIR/server/run.sh
TimeoutStartSec=9min
Nice=5
EOF
cat > /etc/systemd/system/crypto-grabber.timer <<EOF
[Unit]
Description=Run the Crypto Grabber alert check every 5 minutes

[Timer]
OnCalendar=*:0/5
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF
install -m 755 "$DIR/server/cg" /usr/local/bin/cg
systemctl daemon-reload
systemctl enable --now crypto-grabber.timer >/dev/null
cg start >/dev/null || true   # also starts the live watcher

echo
echo "Done. Sending a test message now..."
cg test || true
echo
echo "You should have a '✅ Crypto Grabber alerts connected' message on Telegram."
echo "From now on it checks every 5 minutes. Type  cg  for status, or  cg help  for the other commands."
