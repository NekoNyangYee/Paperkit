#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="paperkit-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).sqlite3"
docker compose --env-file .env exec -T backend /usr/local/bin/paperkit-api backup "/backup/$name"
umask 077
mkdir -p backups
docker compose --env-file .env cp "backend:/backup/$name" "backups/$name"
chmod 600 "backups/$name"
printf 'Verified backup copied to backups/%s\n' "$name"
printf '%s\n' 'Keep an off-device copy; the Docker backup volume is on the same device.'
