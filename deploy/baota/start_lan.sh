#!/usr/bin/env bash
set -euo pipefail

cd /www/wwwroot/notify-pro
npm install --omit=dev

export DEPLOY_MODE=lan
export PORT="${PORT:-3180}"

pm2 delete notify-pro-lan >/dev/null 2>&1 || true
pm2 start bootstrap.js --name notify-pro-lan -- lan
pm2 save

echo "notify-pro-lan started."
