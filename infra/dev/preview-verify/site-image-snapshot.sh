#!/usr/bin/env bash
# The snapshot of the site image before and after its base moved to php-base (docs/plan/62,
# Т22; docs/plan/62-slices/e1.md, Э1.5, step 2): the same commands on both images, each into a
# folder of its own, and their diff. Every line of the diff is explained in the plan.
#
#   bash infra/dev/preview-verify/site-image-snapshot.sh [<folder>]
#
# OLD is built here from this tree on the way back (BASE=wordpress@…, PHP 8.3 only); NEW is the
# image `pnpm verify:site-images --only 8.3` built (raditi-site-verify:8.3). The folder gets
# old/, new/ and diff.txt, written anew on each run; nothing else in it is touched. A difference
# is the result, a person explains it in the plan; the script fails when a command does and when
# a PHP or Apache module of OLD is missing from NEW (the stop of step 2), status_module aside
# (Т22). Run from the root of the repository.
set -euo pipefail

out=${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/site-image-snapshot}
old=${SNAPSHOT_OLD_IMAGE:-raditi-preview-site:8.3-wordpress}
new=${SNAPSHOT_NEW_IMAGE:-raditi-site-verify:8.3}
wordpress=wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5

docker image inspect "$new" >/dev/null 2>&1 || {
  echo "No image $new: build it first with pnpm verify:site-images --only 8.3" >&2
  exit 1
}
docker build -q -f infra/preview/Dockerfile --target site --build-arg "BASE=$wordpress" \
  -t "$old" infra/preview >/dev/null

# One image into one folder. Nothing of a run reaches the network.
snapshot() {
  image=$1
  dir=$2
  mkdir -p "$dir"
  run="docker run --rm --network none"
  $run --user 33:33 --entrypoint php "$image" -v > "$dir/php-v.txt"
  $run --user 33:33 --entrypoint php "$image" -m > "$dir/php-m.txt"
  $run --user 33:33 --entrypoint php "$image" -i \
    | grep -Ev '^(Build Date|Build System|_SERVER|_ENV|\$_|REQUEST_TIME|PWD|HOSTNAME)' \
    > "$dir/php-i.txt"
  $run --user 33:33 --entrypoint php "$image" -r 'var_export(gd_info());' > "$dir/gd-info.txt"
  $run --entrypoint sh "$image" -c 'apache2ctl -M 2>/dev/null | sort' > "$dir/apache-modules.txt"
  # shellcheck disable=SC2016 # expanded inside the container
  $run --entrypoint sh "$image" \
    -c 'for f in "$PHP_INI_DIR"/conf.d/*.ini; do echo "## $f"; cat "$f"; done' > "$dir/ini.txt"
  docker image inspect --format '{{json .Config.Volumes}} {{.Size}}' "$image" > "$dir/image.txt"
}

# Only what this script writes goes: the folder may be $TMPDIR or one with other work in it.
mkdir -p "$out"
rm -rf "$out/old" "$out/new" "$out/diff.txt"
snapshot "$old" "$out/old"
snapshot "$new" "$out/new"
status=0
(cd "$out" && diff -ru old new > diff.txt) || status=$?
[ "$status" -le 1 ] || exit "$status"
echo "OLD $old, NEW $new: $(grep -c '^[-+][^-+]' "$out/diff.txt" || true) lines differ; $out/diff.txt"

# A module of OLD that NEW lost stops the slice; the rest of the diff is read by a person.
missing() {
  comm -23 <(sed 's/^ *//' "$out/old/$1" | grep -v "$2" | sort -u) \
    <(sed 's/^ *//' "$out/new/$1" | sort -u)
}
lost=$(missing php-m.txt '^$'; missing apache-modules.txt '^status_module ')
if [ -n "$lost" ]; then
  echo "NEW lost what OLD has:" >&2
  echo "$lost" >&2
  exit 1
fi
