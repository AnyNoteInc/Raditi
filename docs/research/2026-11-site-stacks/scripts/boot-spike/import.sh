#!/bin/bash
# import.sh <prod tag> <cms> <out dir>: the tree of production → the rules → a git commit → `git archive`, as a preview receives it.
set -euo pipefail
tag=$1; cms=$2; out=$3; here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
node "$here/rules.mjs" "$cms" > "$out/gitignore"
docker exec bs-prod-$tag tar -C /var/www/html -cf - . > "$out/prod.tar"
docker run --rm -i --user 0:0 -v "$out":/out --entrypoint sh raditi-dev/core:local -c '
  set -e; mkdir /tmp/w; cd /tmp/w; tar --no-same-owner -xf /out/prod.tar
  rm -rf .git; find . -name .gitignore -path "./*" -delete 2>/dev/null || true
  cp /out/gitignore .gitignore
  git init -q .; git config user.email s@s; git config user.name s; git config core.fileMode false
  git add -A . ; git commit -q -m tree
  git ls-files --others --ignored --exclude-standard > /out/dropped.txt
  git archive --format=tar HEAD > /out/tree.tar
  git ls-files | wc -l > /out/files.count
' 2>&1 | tail -3
rm -f "$out/prod.tar"
echo "imported: $(cat "$out/files.count") files, dropped $(wc -l < "$out/dropped.txt"), tar $(du -h "$out/tree.tar" | cut -f1)"
