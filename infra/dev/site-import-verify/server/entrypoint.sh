#!/bin/sh
# Starts the stand's hosting: vsftpd and sshd side by side; either one leaving ends the container.
# What the stand copied in before the start lies in /stand/in; the site is in /home/site.
set -eu

in=/stand/in
run=/stand/run

case "${PASV_MIN:-}:${PASV_MAX:-}" in
  *[!0-9:]* | :* | *:) echo 'PASV_MIN and PASV_MAX must be port numbers' >&2; exit 1 ;;
esac

if [ ! -e "$run/configured" ]; then
  # Every account shares the chrooted home: `site` may write there, the others only read.
  # `ftpsite` has FTP only, `siteb` and `sitec` SSH only (sshd_config, AllowUsers).
  for user in site ftpsite siteb sitec; do
    adduser -D -H -h /home/site -s /bin/sh "$user"
  done
  # user:password lines from a 0600 file: never an argument of a process. Read once, then gone.
  chpasswd < "$in/passwords"
  rm -f "$in/passwords"

  mkdir -p "$run/authorized_keys"
  install -o root -g root -m 0644 "$in/authorized_keys/site" "$run/authorized_keys/site"
  install -o root -g root -m 0644 "$in/tls/cert.pem" "$run/ftp-cert.pem"
  install -o root -g root -m 0600 "$in/tls/key.pem" "$run/ftp-key.pem"
  chmod 0600 "$in/host_keys/first" "$in/host_keys/second"
  echo first > "$run/host_key_choice"

  # The chroot itself belongs to root (sshd and vsftpd insist); what is inside to the user.
  chown root:root /home/site
  chmod 0755 /home/site
  for entry in /home/site/* /home/site/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    chown -hR site:site "$entry"
    chmod -R u=rwX,go=rX "$entry"
  done

  cp /opt/stand/vsftpd.conf "$run/vsftpd.conf"
  printf 'pasv_min_port=%s\npasv_max_port=%s\n' "$PASV_MIN" "$PASV_MAX" >> "$run/vsftpd.conf"
  touch "$run/configured"
fi

install -o root -g root -m 0600 "$in/host_keys/$(cat "$run/host_key_choice")" "$run/ssh_host_key"
mkdir -p /run/sshd /var/empty

/usr/sbin/vsftpd "$run/vsftpd.conf" &
ftp=$!
/usr/sbin/sshd -D -e -f /opt/stand/sshd_config &
ssh=$!
trap 'kill -TERM "$ftp" "$ssh" 2>/dev/null; exit 0' TERM INT
while kill -0 "$ftp" 2>/dev/null && kill -0 "$ssh" 2>/dev/null; do
  sleep 1
done
kill -0 "$ftp" 2>/dev/null || echo 'vsftpd of the stand hosting stopped' >&2
kill -0 "$ssh" 2>/dev/null || echo 'sshd of the stand hosting stopped' >&2
kill -TERM "$ftp" "$ssh" 2>/dev/null || true
exit 1
