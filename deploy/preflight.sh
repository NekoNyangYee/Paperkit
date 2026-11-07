#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
printf '%s\n' 'Machine architecture:'
uname -m
printf '%s\n' 'Compose version:'
docker compose version
printf '%s\n' 'Existing containers (read-only inspection):'
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
printf '%s\n' 'Listening TCP ports:'
ss -ltn
printf '%s\n' 'Docker and Tailscale boot configuration:'
systemctl is-enabled docker tailscaled || true
printf '%s\n' 'Existing Funnel configuration (unchanged):'
tailscale funnel status
printf '%s\n' 'No containers or Funnel routes were changed.'
