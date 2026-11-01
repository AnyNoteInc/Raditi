#!/bin/zsh
# run.sh <php> <runtime> <mode>: one probe in a disposable container, volumes removed after.
v=$1; rt=$2; mode=$3
n=rrp-${v/./}-$rt-$mode
docker volume create $n-f >/dev/null; docker volume create $n-d >/dev/null
docker run --rm --name $n --runtime $rt --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 --tmpfs /run/mysqld:rw,noexec,nosuid,nodev,size=256m,uid=999,gid=999,mode=0755 \
  -v $n-f:/var/www/html -v $n-d:/var/lib/mysql -e MODE=$mode --memory 2g --pids-limit 512 --network bridge \
  --entrypoint /usr/local/lib/raditi/entry.sh raditi-research-test:$v 2>&1
docker volume rm $n-f $n-d >/dev/null
