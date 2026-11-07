#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo 'Run bash deploy/init-env.sh first.' >&2; exit 1; }
compose=(docker compose --env-file .env)
"${compose[@]}" config --quiet
# Read only the documented numeric setting; do not source an executable .env.
port=$(sed -n 's/^PROXY_PORT=\([0-9][0-9]*\)$/\1/p' .env)
[[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || {
  echo 'PROXY_PORT must be an unquoted integer in 1024..65535.' >&2; exit 1;
}
project=$(sed -n 's/^COMPOSE_PROJECT_NAME=\([a-z0-9_-][a-z0-9_-]*\)$/\1/p' .env)
[[ -n "$project" ]] || { echo 'Set a lowercase COMPOSE_PROJECT_NAME.' >&2; exit 1; }
if ss -H -ltn "sport = :$port" | awk 'END { exit NR == 0 }'; then
  # Allow the existing proxy from this project during a redeploy, but not a foreign service.
  proxy=$("${compose[@]}" ps -q proxy)
  [[ -n "$proxy" ]] && docker inspect --format '{{range $p, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{println .HostIp .HostPort}}{{end}}{{end}}' "$proxy" | awk -v port="$port" '$1 == "127.0.0.1" && $2 == port { found=1 } END { exit !found }' || {
    echo "Port $port is in use by another service. Choose another PROXY_PORT." >&2; exit 1;
  }
fi
"${compose[@]}" build --pull backend
# Validate configuration before replacing any running proxy.
"${compose[@]}" run --rm --no-deps proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
if [[ -n "$("${compose[@]}" ps -q --status running backend)" ]]; then
  bash deploy/backup.sh
fi
"${compose[@]}" up -d --force-recreate --wait --wait-timeout 120 backend proxy
curl --fail --silent --show-error "http://127.0.0.1:$port/paperkit/healthz"
printf '\n%s\n' 'Local deployment is healthy. Funnel was NOT changed.'
"${compose[@]}" ps
