#!/bin/zsh
# run2.sh <php> <runtime> <mode> <ini> [extra docker args]
v=$1; rt=$2; mode=$3; ini=$4; shift 4
n=rrq-${v/./}-$rt-$mode
docker volume create $n-f >/dev/null; docker volume create $n-d >/dev/null
docker run --rm --name $n --runtime $rt --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777 --tmpfs /run/mysqld:rw,noexec,nosuid,nodev,size=256m,uid=999,gid=999,mode=0755 --tmpfs /run/raditi/preview:rw,noexec,nosuid,nodev,size=1m,uid=33,gid=33,mode=0700 \
  -v $n-f:/var/www/html -v $n-d:/var/lib/mysql -e MODE=$mode -e STACK_INI="$ini" -e PHP_INI_SCAN_DIR=:/run/raditi/preview --memory 2g --pids-limit 512 --network bridge \
  "$@" --entrypoint /usr/local/lib/raditi/entry.sh raditi-research-test:$v 2>&1 | grep -v "io_uring\|create_uring"
docker volume rm $n-f $n-d >/dev/null
