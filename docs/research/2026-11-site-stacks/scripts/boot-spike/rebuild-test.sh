#!/bin/bash
# rebuild-test.sh: the root 1775 questions, on Joomla 6 with its cache on.
B=<work>/research/boot-spike
H=site-j6-chat-a.localhost; P=28106; W=$B/work/j6
./preview-up.sh j6 $H $P $W 2>&1 | tail -1 | cut -c1-150
helper() { local user=$1 caps=$2; shift 2; docker run --rm -i --user $user --read-only --cap-drop ALL $caps --security-opt no-new-privileges --network none --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --mount type=volume,src=bs-pv-j6-files,dst=/files,volume-nocopy --entrypoint /usr/local/bin/node raditi-preview-tools:local /usr/local/lib/raditi/files.mjs "$@"; }
frame() { node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))' "$1"; }
./probe.sh j6 $H $P / /blog /blog/welcome-to-your-blog
echo '--- Joomla cache=2: folders in the root 1775'
docker exec -u 33:33 bs-pv-j6 sh -c 'ls -ld /var/www/html/cache /var/www/html/tmp 2>&1; find /var/www/html/cache -maxdepth 2 | head -8 | tr "\n" " "; echo; find /var/www/html/cache -type f | wc -l'
echo '--- full rebuild over what PHP wrote: release, write replace, platform'
s=$(date +%s)
helper 0:0 "--cap-add CHOWN" release 33:33 </dev/null
{ node -e 'const b=Buffer.from(JSON.stringify({replace:true,deletes:[]}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))'; cat $W/tree.tar; } | helper 33:33 "" write
frame $W/platform.json | helper 0:0 "--cap-add CHOWN" platform 33:33
echo "rebuild $(( $(date +%s)-s )) s"
./probe.sh j6 $H $P / /blog/welcome-to-your-blog
docker exec -u 33:33 bs-pv-j6 sh -c 'ls -ld /var/www/html /var/www/html/cache /var/www/html/configuration.php 2>&1'
echo '--- write --replace WITHOUT release: what the order protects'
{ node -e 'const b=Buffer.from(JSON.stringify({replace:true,deletes:[]}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))'; cat $W/tree.tar; } | helper 33:33 "" write; echo "write exit=$?"
helper 0:0 "--cap-add CHOWN" release 33:33 </dev/null
{ node -e 'const b=Buffer.from(JSON.stringify({replace:true,deletes:[]}));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]))'; cat $W/tree.tar; } | helper 33:33 "" write >/dev/null
frame $W/platform.json | helper 0:0 "--cap-add CHOWN" platform 33:33 >/dev/null
echo '--- a folder PHP made 0700 first, then the platform writes into it'
docker exec -u 33:33 bs-pv-j6 sh -c 'umask 077; rm -rf /var/www/html/administrator/logs; mkdir -p /var/www/html/administrator/logs; ls -ld /var/www/html/administrator/logs'
printf '%s' '{"files":[{"path":"administrator/logs/index.html","content":"<html></html>"}]}' > /tmp/pf.json
frame /tmp/pf.json | helper 0:0 "--cap-add CHOWN" platform 33:33; echo "platform exit=$?"
docker exec -u 33:33 bs-pv-j6 sh -c 'ls -ld /var/www/html/administrator /var/www/html/administrator/logs; ls -la /var/www/html/administrator/logs | head -5'
