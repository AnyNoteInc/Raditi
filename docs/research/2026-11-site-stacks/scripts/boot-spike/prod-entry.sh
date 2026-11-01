#!/bin/sh
# Spike: one container is the production hosting of a synthetic site.
set -eu
install -d -o 999 -g 999 -m 0755 /run/mysqld
if [ ! -d /var/lib/mysql/mysql ]; then
  chown -R 999:999 /var/lib/mysql
  mariadb-install-db --no-defaults --user=mysql --basedir=/usr --datadir=/var/lib/mysql --auth-root-authentication-method=socket --skip-test-db --skip-name-resolve >/dev/null
fi
mariadbd --no-defaults --user=mysql --datadir=/var/lib/mysql --socket=/run/mysqld/mysqld.sock --bind-address=0.0.0.0 --port=3306 --skip-name-resolve --character-set-server=utf8mb4 --innodb-use-native-aio=0 --max-allowed-packet=64M ${DB_FLAGS:-} >/tmp/db.log 2>&1 &
i=0; until mariadb --no-defaults --socket=/run/mysqld/mysqld.sock --user=root --execute='SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 300 ] || { tail -20 /tmp/db.log; exit 1; }; sleep 0.2; done
mariadb --no-defaults --socket=/run/mysqld/mysqld.sock --user=root --execute="CREATE DATABASE IF NOT EXISTS site CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS 'site'@'%' IDENTIFIED BY '<hidden>'; GRANT ALL PRIVILEGES ON site.* TO 'site'@'%'; FLUSH PRIVILEGES;"
touch /tmp/prod-ready
exec /usr/sbin/apache2 -f /prod/prod-apache.conf -DFOREGROUND
