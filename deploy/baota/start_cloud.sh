#!/usr/bin/env bash
set -euo pipefail

cd /www/wwwroot/notify-pro
npm install --omit=dev

if [[ -z "${PUBLIC_BASE_URL:-}" ]]; then
  echo "ERROR: PUBLIC_BASE_URL is required in cloud mode."
  exit 1
fi

if [[ -z "${MYSQL_URL:-}" ]]; then
  echo "ERROR: MYSQL_URL is required in cloud mode."
  exit 1
fi

export DEPLOY_MODE=cloud
export PORT="${PORT:-3180}"
export STRICT_CLOUD_MYSQL="${STRICT_CLOUD_MYSQL:-true}"

pm2 delete notify-pro-cloud >/dev/null 2>&1 || true
pm2 start bootstrap.js --name notify-pro-cloud -- cloud
pm2 save

echo "notify-pro-cloud started."
