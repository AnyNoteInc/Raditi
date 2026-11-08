#!/bin/bash
B=<work>/research/boot-spike; H=site-oc3-chat-a.localhost; P=28143
variant() { name=$1; shift; W=$B/work/oc3v-$name; mkdir -p $W; cp $B/work/oc3/seed.sql $W/
  python3 - "$B/work/oc3/tree.tar" "$W/tree.tar" "$@" <<'PY'
import sys,tarfile,shutil
src,dst,*dirs=sys.argv[1:]
shutil.copy(src,dst)
with tarfile.open(dst,'a',format=tarfile.PAX_FORMAT) as t:
    for d in dirs:
        i=tarfile.TarInfo(d); i.type=tarfile.DIRTYPE; i.mode=0o755; t.addfile(i)
PY
  rm -rf $B/cms/oc3v; mkdir -p $B/cms/oc3v/platform/admin; cp $B/cms/opencart3/rewrite.conf $B/cms/opencart3/policy.mjs $B/cms/oc3v/; cp $B/cms/opencart3/platform/config.php $B/cms/oc3v/platform/; cp $B/cms/opencart3/platform/admin/config.php $B/cms/oc3v/platform/admin/
  node mkwork.mjs $B/cms/oc3v $W '{"TABLE_PREFIX":"oc_"}' tablesOffline >/dev/null
  ./preview-up.sh oc3 $H $P $W 2>&1 | tail -1 | cut -c1-110
  echo "--- $name: $*"; ./probe.sh oc3 $H $P / /desktops /admin/ | cut -c1-90
  curl -s -H "Host: $H:$P" http://127.0.0.1:$P/ | head -c 130 | tr '\n' ' '; echo
  docker exec -u 33:33 bs-pv-oc3 sh -c 'ls -ld /var/www/html/system/storage/* | awk "{print \$1,\$3,\$NF}" | sed "s#/var/www/html/system/storage/##" | tr "\n" ";"'; echo
  docker logs bs-pv-oc3 2>&1 | grep -E 'PHP (Fatal|Warning)' | sed 's/^\[[^]]*\] //' | cut -c1-120 | sort | uniq -c | sort -rn | head -3
}
variant logs-only system/storage/logs/
variant cache-only system/storage/cache/
variant both system/storage/logs/ system/storage/cache/
variant all-dirs system/storage/logs/ system/storage/cache/ system/storage/session/ system/storage/upload/ system/storage/download/
