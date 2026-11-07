#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || { echo 'An exact commit SHA is required.' >&2; exit 2; }
unit="paperkit-deploy@$1.service"
status=0
systemctl start --wait "$unit" || status=$?
journalctl -u "$unit" --no-pager -n 200
exit "$status"
