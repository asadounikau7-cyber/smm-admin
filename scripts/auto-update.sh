#!/bin/bash
# Pulls new commits from GitHub and rebuilds the app. Run by cron every 5 minutes (see install-auto-update.sh).
# Log: /var/log/smm-update.log
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>/tmp/smm-update.lock
flock -n 9 || exit 0
git fetch -q origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ "${1:-}" != "--force" ]; then exit 0; fi
echo "== $(date -u) updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git pull -q --ff-only origin main
docker compose up -d --build
docker image prune -f >/dev/null
echo "== $(date -u) done"
