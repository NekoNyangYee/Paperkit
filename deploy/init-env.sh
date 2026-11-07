#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -e .env || -L .env ]]; then
  printf '%s\n' '.env already exists; kept unchanged.'
  exit 0
fi
umask 077
# noclobber also protects against concurrent initializations.
(set -o noclobber; cat .env.example > .env)
printf '%s\n' 'Created .env with owner-only permissions. Set Supabase URL and publishable key before deployment.'
