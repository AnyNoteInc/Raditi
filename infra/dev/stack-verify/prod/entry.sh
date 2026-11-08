#!/bin/sh
# The synthetic production of a stand of the site stacks (docs/plan/62-slices/e3.md, Э3.8): one
# container of the image `site` started with this file as its entrypoint — MariaDB inside it, Apache
# as root dropping to www-data, `.htaccess` read as a hosting reads it. The password of the site's
# database comes from the file /prod-secrets/db, which the stand writes once the container runs;
# it is never in a text, an argument or the environment. Under runsc no production runs: the line of
# М7 is the preview.
set -eu
secret=/prod-secrets/db
i=0
until [ -s "$secret" ]; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || { echo 'no password of the database' >&2; exit 1; }
  sleep 0.2
done
password=$(cat "$secret")
# Quoted into one statement below: letters and digits only.
case $password in
  *[!A-Za-z0-9]* | '') echo 'the password of the database is letters and digits' >&2; exit 1 ;;
esac
install -d -o 999 -g 999 -m 0755 /run/mysqld
if [ ! -d /var/lib/mysql/mysql ]; then
  chown -R 999:999 /var/lib/mysql
  mariadb-install-db --no-defaults --user=mysql --basedir=/usr --datadir=/var/lib/mysql \
    --auth-root-authentication-method=socket --skip-test-db --skip-name-resolve >/dev/null
fi
mariadbd --no-defaults --user=mysql --datadir=/var/lib/mysql --socket=/run/mysqld/mysqld.sock \
  --bind-address=0.0.0.0 --port=3306 --skip-name-resolve --character-set-server=utf8mb4 \
  --innodb-use-native-aio=0 --max-allowed-packet=64M >/tmp/db.log 2>&1 &
i=0
until mariadb --no-defaults --socket=/run/mysqld/mysqld.sock --user=root --execute='SELECT 1' \
  >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || { tail -20 /tmp/db.log; exit 1; }
  sleep 0.2
done
mariadb --no-defaults --socket=/run/mysqld/mysqld.sock --user=root --execute="CREATE DATABASE IF NOT EXISTS site CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS 'site'@'%' IDENTIFIED BY '$password'; GRANT ALL PRIVILEGES ON site.* TO 'site'@'%'; FLUSH PRIVILEGES;"
unset password
touch /tmp/prod-ready
exec /usr/sbin/apache2 -f /prod/apache.conf -DFOREGROUND
