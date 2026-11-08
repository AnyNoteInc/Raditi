#!/bin/bash
# preview-up.sh <tag> <hostname> <public port> <work dir> [runtime]: builds a preview as the product does.
# <work dir> holds tree.tar, seed.sql, platform.json ({files:[{path,content}]}), apache2.conf, settings.json (the "settings" field).
set -euo pipefail
tag=$1; host=$2; port=$3; work=$4; runtime=${5:-runc}; image=${IMAGE:-raditi-boot-spike:8.3}
c=bs-pv-$tag; fv=$c-files; dv=$c-db; tools=${TOOLS_IMAGE:-raditi-preview-tools:local}
docker rm -f $c >/dev/null 2>&1 || true
docker volume rm -f $fv $dv >/dev/null 2>&1 || true
docker volume create $fv >/dev/null; docker volume create $dv >/dev/null
start=$(date +%s%N)
userpw='<hidden>'; rootpw='<hidden>'
helper() { # helper <uid:gid> <caps> <args...> with stdin
  local user=$1 caps=$2; shift 2
  docker run --rm -i --runtime $runtime --user $user --read-only --cap-drop ALL $caps --security-opt no-new-privileges --network none \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --mount type=volume,src=$fv,dst=/files,volume-nocopy ${FILES_MJS:+-v $FILES_MJS:/usr/local/lib/raditi/files.mjs:ro} \
    --entrypoint /usr/local/bin/node $tools /usr/local/lib/raditi/files.mjs "$@"
}
helper 0:0 "--cap-add CHOWN" init 33:33 </dev/null >/dev/null
docker run -d --name $c --runtime $runtime --user 0:0 --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP \
  --security-opt no-new-privileges --cpus 2 --memory 2g --memory-swap 2g --pids-limit 512 \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 \
  --tmpfs /run/raditi/preview:rw,noexec,nosuid,nodev,size=1m,uid=33,gid=33,mode=0700 \
  --tmpfs /run/raditi/db:rw,noexec,nosuid,nodev,size=1m,uid=999,gid=999,mode=0700 \
  --tmpfs /run/mysqld:rw,noexec,nosuid,nodev,size=256m,uid=999,gid=999,mode=0755 \
  --tmpfs /run/raditi-forward:rw,noexec,nosuid,nodev,size=1m,uid=10001,gid=10001,mode=0700 \
  --tmpfs /run/raditi/ready:rw,noexec,nosuid,nodev,size=1m,mode=0755 \
  -e RADITI_HTTP_HOST=$host -e RADITI_WEB_PORT=8081 -e RADITI_DATABASE=1 -e RADITI_DNS_SERVERS=1.1.1.1 \
  -e APACHE_RUN_DIR=/tmp/apache2/run -e APACHE_LOCK_DIR=/tmp/apache2/lock -e APACHE_PID_FILE=/tmp/apache2/run/apache2.pid \
  -p 127.0.0.1:$port:8080 -w /var/www/html \
  --mount type=volume,src=$fv,dst=/var/www/html,volume-nocopy --mount type=volume,src=$dv,dst=/var/lib/mysql \
  $image apache-foreground -f /run/raditi/preview/apache2.conf >/dev/null
printf %s "$userpw" | docker exec -i -u 999:999 $c sh -c 'umask 077; cat > /run/raditi/db/user'
printf %s "$rootpw" | docker exec -i -u 999:999 $c sh -c 'umask 077; cat > /run/raditi/db/root'
docker exec -i -u 33:33 $c sh -c 'umask 077; cat > /run/raditi/preview/apache2.conf' < "$work/apache2.conf"
node -e '
  const fs=require("fs"); const [host,port,pw,prod,file]=process.argv.slice(1);
  process.stdout.write(JSON.stringify({v:2,hostname:host,origin:`http://${host}:${port}`,productionOrigin:prod,
    database:{engine:"mysql",host:"127.0.0.1",port:3306,name:"preview",user:"preview",password:pw},
    settings:JSON.parse(fs.readFileSync(file,"utf8")),env:{}}))' "$host" "$port" "$userpw" "${PROD_ORIGIN:-https://prod.spike.test}" "$work/settings.json" \
  | docker exec -i -u 33:33 $c sh -c 'umask 077; cat > /run/raditi/preview/settings.json'
for i in $(seq 1 300); do docker exec -u 10001:10001 $c test -f /run/raditi-forward/ready 2>/dev/null && break; docker inspect -f '{{.State.Running}}' $c | grep -q true || { echo CONTAINER-DIED; docker logs $c 2>&1 | tail -20; exit 1; }; sleep 0.2; done
for i in $(seq 1 300); do docker exec $c test -f /run/raditi/ready/db 2>/dev/null && break; sleep 0.2; done
up=$(date +%s%N)
docker exec -u 999:999 -e MYSQL_PWD=$userpw $c mariadb --no-defaults --protocol=tcp --host=127.0.0.1 --user=preview --execute='DROP DATABASE IF EXISTS `preview`; CREATE DATABASE `preview`'
if ! docker exec -i -u 999:999 -e MYSQL_PWD=$userpw $c mariadb --no-defaults --protocol=tcp --host=127.0.0.1 --user=preview --binary-mode --sandbox --max-allowed-packet=64M --database=preview < "$work/seed.sql" 2> "$work/seed.err"; then echo "SEED-LOAD-FAILED: $(head -c 600 "$work/seed.err")"; fi
loaded=$(date +%s%N)
{ node -e 'const b=Buffer.from(JSON.stringify({replace:true,deletes:[]}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))'; cat "$work/tree.tar"; } | helper 33:33 "" write
node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))' "$work/platform.json" | helper 0:0 "--cap-add CHOWN" platform 33:33
done=$(date +%s%N)
echo "preview $tag: containers+db $(( (up-start)/1000000 )) ms, seed $(( (loaded-up)/1000000 )) ms, tree+platform $(( (done-loaded)/1000000 )) ms; http://$host:$port/"
