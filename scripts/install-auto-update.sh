#!/bin/bash
# One-time: makes the server update itself from GitHub every 5 minutes.
# Usage: bash scripts/install-auto-update.sh <github_token>   (token: fine-grained, Contents: Read-only)
# Turn off: rm /etc/cron.d/smm-update
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=$(pwd)
if [ -n "${1:-}" ]; then
  git remote set-url origin "https://x-access-token:$1@github.com/mikhadobrin5-del/smm-admin.git"
fi
chmod 700 .git
chmod +x scripts/auto-update.sh
echo "*/5 * * * * root $DIR/scripts/auto-update.sh >> /var/log/smm-update.log 2>&1" > /etc/cron.d/smm-update
chmod 644 /etc/cron.d/smm-update
echo "Автообновление включено: сервер раз в 5 минут проверяет GitHub. Лог: /var/log/smm-update.log"
echo "Собираю текущую версию (3–5 минут)…"
"$DIR/scripts/auto-update.sh" --force
