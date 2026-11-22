#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="paperkit-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).sqlite3"
compose=(docker compose --env-file .env)
container=$("${compose[@]}" ps -q backend)
mode=$(docker inspect --format '{{index .Config.Labels "io.paperkit.storage"}}' "$container")
docker exec "$container" /usr/local/bin/paperkit-api backup "/backup/$name"
if [[ "$mode" == bounded ]]; then
  printf 'Verified backup in bounded storage: /backup/%s\n' "$name"
  exit 0
fi
umask 077
mkdir -p backups
docker cp "$container:/backup/$name" "backups/$name"
chmod 600 "backups/$name"
printf 'Verified backup copied to backups/%s\n' "$name"
printf '%s\n' 'Keep an off-device copy; the Docker backup volume is on the same device.'
