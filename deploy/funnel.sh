#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "${1:-}" == '--publish' ]] || {
  printf '%s\n' 'This changes the HTTPS 443 root target to the shared proxy.' 'After reviewing the existing routes, run: bash deploy/funnel.sh --publish'
  exit 1
}
port=$(sed -n 's/^PROXY_PORT=\([0-9][0-9]*\)$/\1/p' .env)
[[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || exit 1
curl --fail --silent --show-error "http://127.0.0.1:$port/paperkit/healthz"
code=$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/paperkit/v1/documents")
[[ "$code" == 401 ]] || { echo "Authentication check failed: HTTP $code" >&2; exit 1; }
printf '\n%s\n' 'Current Funnel configuration:'
tailscale funnel status
printf '%s\n' 'Only the HTTPS 443 root target will be changed; no reset is used.'
read -r -p 'Type PUBLISH to replace the root target and expose the API: ' answer
[[ "$answer" == PUBLISH ]] || exit 1
umask 077
mkdir -p .cache/deploy
tailscale funnel status --json > ".cache/deploy/funnel-before-$(date -u +%Y%m%dT%H%M%SZ).json"
tailscale funnel --bg --https=443 --set-path=/ "http://127.0.0.1:$port"
tailscale funnel status
printf '%s\n' 'Use the HTTPS URL above + /paperkit/healthz and /paperkit/v1/documents.'
