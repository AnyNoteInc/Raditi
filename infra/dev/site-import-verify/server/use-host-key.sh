#!/bin/sh
# `use-host-key.sh first|second`: the host key sshd presents from now on. sshd re-executes itself
# on SIGHUP and reads the key again; the published ports and the FTP server stay as they are.
set -eu
case "${1:-}" in
  first | second) ;;
  *) echo 'usage: use-host-key.sh first|second' >&2; exit 2 ;;
esac
echo "$1" > /stand/run/host_key_choice
install -o root -g root -m 0600 "/stand/in/host_keys/$1" /stand/run/ssh_host_key
kill -HUP "$(cat /stand/run/sshd.pid)"
