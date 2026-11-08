#!/bin/bash
# prod-up.sh <tag> <http port> <db port> <source dir> [image]: a synthetic production with the tree unpacked into its volume.
set -euo pipefail
tag=$1; http=$2; db=$3; src=$4; image=${5:-raditi-boot-spike:8.3}
here=$(cd "$(dirname "$0")" && pwd)
docker rm -f bs-prod-$tag >/dev/null 2>&1 || true
docker volume rm -f bs-prod-$tag-files bs-prod-$tag-db >/dev/null 2>&1 || true
docker run -d --name bs-prod-$tag -p 127.0.0.1:$http:80 -p 127.0.0.1:$db:3306 -e DB_FLAGS="${DB_FLAGS:-}" \
  -v "$here":/prod:ro -v bs-prod-$tag-files:/var/www/html -v bs-prod-$tag-db:/var/lib/mysql \
  --entrypoint /prod/prod-entry.sh "$image" >/dev/null
for i in $(seq 1 100); do docker exec bs-prod-$tag test -f /tmp/prod-ready && break; sleep 0.3; done
docker exec bs-prod-$tag test -f /tmp/prod-ready
COPYFILE_DISABLE=1 tar --no-xattrs -C "$src" --exclude=.git -cf - . | docker exec -i bs-prod-$tag tar -C /var/www/html -xf - 2>/dev/null
docker exec bs-prod-$tag chown -R 33:33 /var/www/html
echo "prod $tag up: http 127.0.0.1:$http db 127.0.0.1:$db"
