#!/bin/sh
# The filesystem enforces the hard limit, including SQLite WAL and backups.
set -eu
fail() { echo "Paperkit storage: $*" >&2; exit 1; }
limit=${PAPERKIT_STORAGE_MAX_GIB:?Set PAPERKIT_STORAGE_MAX_GIB}
case "$limit" in ''|0*|*[!0-9]*|???????*) fail 'expected a positive integer GiB limit (1..999999)' ;; esac
[ "$(stat -c %d /data)" = "$(stat -c %d /backup)" ] || fail 'data and backups must share the bounded filesystem'
case "$(stat -f -c %T /data)" in tmpfs|ramfs|overlayfs) fail 'a persistent filesystem is required' ;; esac
blocks=$(stat -f -c %b /data)
block_bytes=$(stat -f -c %S /data)
[ "$blocks" -le "$((limit * 1073741824 / block_bytes))" ] || fail "filesystem exceeds ${limit} GiB"
[ -w /data ] && [ -w /backup ] || fail 'data and backups must be writable by UID 10001'
if [ ! -s /data/paperkit.sqlite3 ] && [ "${1:-}" != migrate ]; then
    fail 'database missing: restore the existing database, or run migrate for a fresh installation'
fi
if [ "${1:-}" = --check-storage ]; then
    printf 'Paperkit data and backup filesystem: %s blocks of %s bytes (ceiling %s GiB)\n' "$blocks" "$block_bytes" "$limit"
    exit 0
fi
exec /usr/local/bin/paperkit-api "$@"
