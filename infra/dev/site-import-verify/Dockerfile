# The hosting of `pnpm verify:site-import` (README.md): SFTP over SSH (OpenSSH, internal-sftp, no
# shell) and FTP with explicit FTPS (vsftpd) in one container, as a client's hosting offers them.
# Built locally once per content of this file and server/ (stand.mjs tags it by their hash); the
# stand copies the site, the users' passwords and keys, the host keys and the certificate in
# before the container starts, so the image holds no secret and no site.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

RUN apk add --no-cache openssh-server vsftpd \
  && rm -f /etc/ssh/ssh_host_* \
  && mkdir -p /stand/in /stand/run /home/site \
  && chmod 0755 /stand /stand/in /stand/run /home/site

COPY . /opt/stand/
RUN chmod 0755 /opt/stand/entrypoint.sh /opt/stand/use-host-key.sh \
  && chmod 0644 /opt/stand/sshd_config /opt/stand/vsftpd.conf /opt/stand/ftp-users

EXPOSE 21 22
ENTRYPOINT ["/opt/stand/entrypoint.sh"]
