#!/bin/bash
# One-shot server setup for the SMM admin on a fresh Ubuntu 24.04 (Vultr, DigitalOcean, any VPS).
#
# Vultr: Deploy → Cloud Compute → Ubuntu 24.04 → "Cloud-Init User-Data": paste this whole file
# after filling in the four values below. Or run it as root over SSH / the web console.
# Progress log: /var/log/smm-bootstrap.log (takes ~10 minutes).

# ======== fill in ========
GITHUB_TOKEN=""        # fine-grained token, repo mikhadobrin5-del/smm-admin, Contents: Read-only
OWNER_EMAIL=""         # login for the admin
OWNER_PASSWORD=""      # 10+ characters
DOMAIN=""              # e.g. admin.example.com (A record → server IP). Empty = <ip>.sslip.io for now
# =========================

B2_REGISTRY_URL="https://f005.backblazeb2.com/b2api/v1/b2_download_file_by_id?fileId=4_zb651de113a817014a3130812_f1168366d4fa4e43b_d20261108_m184856_c005_v0501041_t0016_u01794163736885"
APP_DIR=/opt/smm-admin

exec > >(tee -a /var/log/smm-bootstrap.log) 2>&1
set -euo pipefail
echo "== bootstrap started $(date -u)"

if [ -z "$GITHUB_TOKEN" ] || [ -z "$OWNER_EMAIL" ] || [ ${#OWNER_PASSWORD} -lt 10 ]; then
  echo "Fill in GITHUB_TOKEN, OWNER_EMAIL and OWNER_PASSWORD (10+ chars) at the top of the script"; exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw openssl

# 2 GB swap so builds and ffmpeg don't run out of memory on small plans
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# Firewall: SSH + HTTP(S) only
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Docker
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

# Code
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/mikhadobrin5-del/smm-admin.git" "$APP_DIR"
  # don't keep the token in the remote URL
  git -C "$APP_DIR" remote set-url origin https://github.com/mikhadobrin5-del/smm-admin.git
fi
cd "$APP_DIR"

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
[ -z "$DOMAIN" ] && DOMAIN="${IP//./-}.sslip.io"

if [ ! -f .env ]; then
  cp .env.example .env
  set_env() { sed -i "s|^$1=.*|$1=$2|" .env; }
  set_env DOMAIN "$DOMAIN"
  set_env APP_URL "https://$DOMAIN"
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env ENCRYPTION_KEY "$(openssl rand -hex 32)"
  set_env AGENT_TOKEN "$(openssl rand -hex 32)"
  set_env B2_REGISTRY_URL "$B2_REGISTRY_URL"
  set_env B2_PREFIX ""
  set_env NOTIFY_EMAILS "$OWNER_EMAIL"
  chmod 600 .env
fi

docker compose up -d --build

echo "== waiting for the app"
for i in $(seq 1 60); do
  docker compose exec -T web node -e "fetch('http://localhost:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 5
done

docker compose exec -T web npm run user:create -- "$OWNER_EMAIL" "$OWNER_PASSWORD" OWNER
docker compose exec -T web npm run seed:pilot || true

echo "== done $(date -u)"
echo "Admin: https://$DOMAIN"
echo "Agent token for agent/config.json: $(grep ^AGENT_TOKEN= .env | cut -d= -f2)"
