#!/bin/sh
# mimics init.sh: database 999, web 33, both with no capability.
set -eu
START=$(date +%s%N)
MODE=${MODE:-current}
as() { i=$1; shift; setpriv --reuid=$i --regid=$i --clear-groups --bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"; }
as 999 mkdir -p -m 0700 /run/mysqld/tmp
if ! as 999 test -f /var/lib/mysql/.ready; then
  as 999 mariadb-install-db --no-defaults --basedir=/usr --datadir=/var/lib/mysql --tmpdir=/run/mysqld/tmp --auth-root-authentication-method=socket --skip-test-db --skip-name-resolve >/dev/null
  as 999 sh -c 'cat > /run/mysqld/tmp/init.sql <<SQL
CREATE DATABASE IF NOT EXISTS preview;
CREATE USER IF NOT EXISTS "preview"@"127.0.0.1" IDENTIFIED BY "<hidden>";
CREATE USER IF NOT EXISTS "preview"@"localhost" IDENTIFIED BY "<hidden>";
GRANT ALL PRIVILEGES ON preview.* TO "preview"@"127.0.0.1", "preview"@"localhost";
FLUSH PRIVILEGES;
SQL'
  init=--init-file=/run/mysqld/tmp/init.sql
else init=; fi
extra=
if [ "$MODE" = stack ]; then extra="--collation-server=utf8mb4_unicode_ci --sql-mode= --innodb-strict-mode=0 --innodb-flush-log-at-trx-commit=2"; fi
as 999 mariadbd --no-defaults --datadir=/var/lib/mysql --socket=/run/mysqld/mysqld.sock --pid-file=/run/mysqld/mysqld.pid --tmpdir=/run/mysqld/tmp --bind-address=127.0.0.1 --port=3306 --skip-name-resolve --max-allowed-packet=64M --innodb-use-native-aio=0 --character-set-server=utf8mb4 $extra $init </dev/null >/tmp/db.log 2>&1 &
i=0; until mariadb --no-defaults --socket=/run/mysqld/mysqld.sock --user=root --execute='SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 300 ] || { echo DB-DID-NOT-START; cat /tmp/db.log | tail -20; exit 1; }; sleep 0.2; done
as 999 touch /var/lib/mysql/.ready
as 33 sh -c 'mkdir -p /tmp/apache2/run /tmp/apache2/lock; cp /usr/local/lib/raditi/t.php /usr/local/lib/raditi/t2.php /usr/local/lib/raditi/bitrix_server_test.php /var/www/html/; printf "<?php echo \"rewritten:\" . \$_SERVER[\"REQUEST_URI\"];\n" > /var/www/html/index.php'
[ -z "${STACK_INI:-}" ] || { printf "%b" "$STACK_INI" | as 33 sh -c "cat > /run/raditi/preview/raditi-stack.ini"; }
export APACHE_RUN_DIR=/tmp/apache2/run APACHE_LOCK_DIR=/tmp/apache2/lock APACHE_PID_FILE=/tmp/apache2/run/apache2.pid
as 33 sh -c '/usr/sbin/apache2 -f /usr/local/lib/raditi/apache.conf -DFOREGROUND 2>&1 | cat > /tmp/web.log' </dev/null &
i=0; until php -r 'exit(@fsockopen("127.0.0.1",8081)?0:1);' 2>/dev/null; do i=$((i+1)); [ $i -lt 200 ] || break; sleep 0.1; done
echo "web-up-ms: $(( ($(date +%s%N)-START)/1000000 ))"
php -r '$u="http://127.0.0.1:8081/t2.php"; @file_get_contents($u); echo @file_get_contents($u) ?: ("HTTP-FAILED ".json_encode(error_get_last())), "\n";'
if [ "${BX:-}" = 1 ]; then php -r '$u="http://127.0.0.1:8081/bitrix_server_test.php?start_test=Y&lang=ru&mysql_test=Y&host=127.0.0.1&user=preview&password=<hidden>&db=preview"; $c=stream_context_create(array("http"=>array("timeout"=>120))); $h=@file_get_contents($u,false,$c); file_put_contents("/tmp/bx.html",$h); echo "bx bytes ",strlen($h),"\n"; echo substr(preg_replace("/\s+/"," ",strip_tags(preg_replace("/<\/tr>/","\n@@",$h))),0,40000),"\n";'; fi
sleep ${HOLD:-0}
tail -3 /tmp/web.log | cut -c1-220
