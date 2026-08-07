#!/bin/bash
# Bring up a fresh escrow host. Amazon Linux 2023, arm64.
#
# Runs as EC2 user-data on first boot, or by hand on an existing one. Safe to
# re-run: everything below is idempotent.
#
# It deliberately does not set up snapshots, log shipping or flow logs. Each of
# those would keep a record of when something happened, which is the one thing
# this service must not have — and losing the database costs a QR scan, so
# there is nothing here worth a backup that carries that price.
set -euxo pipefail

dnf install -y docker git
systemctl enable --now docker

install -d /usr/local/lib/docker/cli-plugins

ARCH=$(uname -m)
case "$ARCH" in
  aarch64) PLUGIN_ARCH=arm64 ; COMPOSE_ARCH=aarch64 ;;
  *)       PLUGIN_ARCH=amd64 ; COMPOSE_ARCH=x86_64 ;;
esac

curl -sSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# buildx, which AL2023's docker package does not carry. Without it `compose
# build` fails with "requires buildx 0.17.0 or later" — after pulling every
# base image, so the failure looks like a network problem and is not.
BUILDX_URL=$(curl -sS https://api.github.com/repos/docker/buildx/releases/latest \
  | grep -o "https://[^\"]*linux-${PLUGIN_ARCH}" | head -1)
curl -sSL "$BUILDX_URL" -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx

docker buildx version

if [ ! -d /opt/ftw-webapp ]; then
  git clone --depth 1 https://github.com/srcfl/ftw-webapp /opt/ftw-webapp
fi

cd /opt/ftw-webapp/escrow/deploy
docker compose up -d --build

# Survive a reboot without anyone logging in. The host has no SSH; access is
# through SSM, so nothing should need a human to come back up.
cat > /etc/systemd/system/ftw-escrow.service <<'UNIT'
[Unit]
Description=FTW sealed escrow
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/ftw-webapp/escrow/deploy
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable ftw-escrow

echo "escrow up; check with: curl -s http://127.0.0.1:8788/healthz"
