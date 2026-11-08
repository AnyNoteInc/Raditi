#!/bin/sh
# Unseals the host's OpenBao after a start (owner's decision of 08.11.2026: the unseal key lives on
# the server, root 0400, so a reboot needs nobody). The key goes in the body from its file, never
# in an argument. Exits 0 once OpenBao answers unsealed.
set -eu
key=/etc/raditi/openbao/unseal.json
addr=http://127.0.0.1:8200
for _ in $(seq 1 60); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$addr/v1/sys/health" || true)
  case "$status" in
  200 | 429 | 473) exit 0 ;;          # active, standby, performance standby
  501) echo "openbao-unseal: not initialized" >&2; exit 1 ;;
  503) curl -sf -o /dev/null -X PUT --data "@$key" "$addr/v1/sys/unseal" || true ;;
  esac
  sleep 2
done
echo "openbao-unseal: OpenBao did not answer unsealed" >&2
exit 1
