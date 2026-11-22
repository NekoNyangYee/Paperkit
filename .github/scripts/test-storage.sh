#!/usr/bin/env bash
# Run after the legacy-volume smoke test on a disposable Linux CI runner.
set -euo pipefail
compose=(docker compose --env-file .env)
limits() {
  docker inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}' "$("${compose[@]}" ps -q "$1")"
}
[[ "$(limits backend)" == '200000000 436207616 436207616' ]]
[[ "$(limits proxy)" == '50000000 100663296 100663296' ]]

scratch=$(mktemp -d)
export PAPERKIT_STORAGE_ROOT="$scratch/mount" PAPERKIT_STORAGE_MAX_GIB=1
export COMPOSE_FILE=compose.yaml:deploy/compose.storage.yaml
mkdir "$PAPERKIT_STORAGE_ROOT"
truncate -s 64M "$scratch/disk.img"
mkfs.ext4 -q -F "$scratch/disk.img"
sudo mount -o loop,nodev,nosuid "$scratch/disk.img" "$PAPERKIT_STORAGE_ROOT"
cleanup() {
  "${compose[@]}" stop backend
  sudo umount "$PAPERKIT_STORAGE_ROOT"
}
trap cleanup EXIT
sudo install -d -m 0700 -o 10001 -g 10001 "$PAPERKIT_STORAGE_ROOT"/{data,backups}

run_backend=("${compose[@]}" run --rm --no-deps backend)
if "${run_backend[@]}" --check-storage; then
  echo 'Empty storage was accepted before explicit initialization.' >&2
  exit 1
fi
"${run_backend[@]}" migrate
"${run_backend[@]}" --check-storage
mkdir "$scratch/unbounded"
sudo install -d -m 0700 -o 10001 -g 10001 "$scratch/unbounded"/{data,backups}
if PAPERKIT_STORAGE_ROOT="$scratch/unbounded" "${run_backend[@]}" migrate; then
  echo 'The host filesystem exceeded the 1 GiB validation limit.' >&2
  exit 1
fi
"${compose[@]}" run --rm --no-deps --entrypoint sh backend -ec '
  if dd if=/dev/zero of=/backup/probe bs=1M count=80; then exit 1; fi
  test -s /backup/probe
  rm /backup/probe
'
legacy_count=$(find backups -type f | wc -l)
"${compose[@]}" up -d --no-deps --wait backend
bash deploy/backup.sh
[[ "$(find backups -type f | wc -l)" -eq "$legacy_count" ]]
[[ "$(sudo find "$PAPERKIT_STORAGE_ROOT/backups" -name 'paperkit-*.sqlite3' -size +0c | wc -l)" -eq 1 ]]
