#!/usr/bin/env bash
# The stand of the site stacks inside the Colima VM `gvisor` (docs/plan/62-site-stacks.md, §5.5, М7;
# docs/plan/62-slices/e3.md, Э3.16 and Э3.14). From the Mac the published ports of a preview and of
# the database of a production are not seen, and node_modules of the Mac do not run on Linux: the
# whole run goes inside the VM, on a copy of this tree in its home, against its own Docker daemon.
#
#   bash infra/dev/stack-verify/colima-m7.sh <stack> [--no-sync] [--build=<id>]... [--group=<group>]...
#                                            [--runtime=runc|runsc] [--no-m2]
#
#   1. The files of this tree git knows (tracked and untracked, not ignored: never .env,
#      node_modules or dist) are copied into ~/raditi-m7 of the VM; a file gone from the tree is
#      removed there; the copy is a git repository of its own (the stand lists files with git).
#      --no-sync — the copy as it is.
#   2. In the VM: Node 26, pnpm 12, git, Gitleaks 8.30.1, rsync and openssl are checked, each refused
#      in words; `pnpm install --frozen-lockfile`, `pnpm build`; the pinned images (the stand never
#      pulls them); the archives of the builds in ~/raditi-cms; Chromium and WebKit of Playwright;
#      the `site` images of the PHP of the builds with their tools and host rules
#      (`pnpm verify:site-images -- --build-only`, under the tags of that stand).
#   3. М2: the preview suite of the stack under the runtime (--no-m2 — skipped).
#   4. `pnpm verify:stack` with the stack, the runtime, the builds and the groups (by default
#      import, preview and release).
#
# --runtime (runsc by default) reaches the turns and previews of core and the suite of step 3; the
# production of a build and its hosting stay on runc. --build= narrows steps 3 and 4 to those builds.
#
# The VM is never started, stopped or reconfigured here, and no image is pulled: a missing tool or
# image is refused with what to do (infra/dev/stack-verify/README.md, «В ВМ Colima»). Only synthetic
# data; no real model, key or site.
set -euo pipefail

PROFILE=gvisor
VM_TREE=raditi-m7
TOOLS=.raditi-m7
SOCKET=/var/run/docker.sock

refuse() {
  echo "colima-m7: $*" >&2
  exit 1
}
usage() {
  refuse "usage: bash infra/dev/stack-verify/colima-m7.sh <stack> [--no-sync] [--build=<id>]... [--group=<group>]... [--runtime=runc|runsc] [--no-m2]"
}

inside=0
sync=1
m2=1
runtime=runsc
stack=
builds=()
groups=()
args=()
for arg in "$@"; do
  # Every argument crosses ssh and reaches pnpm: plain words only.
  [[ $arg =~ ^[A-Za-z0-9=._-]+$ ]] || refuse "an argument may hold letters, digits and = . _ - only: $arg"
  case $arg in
    --inside) inside=1 ;;
    --no-sync) sync=0 ;;
    --no-m2) m2=0 ;;
    --runtime=runc | --runtime=runsc) runtime=${arg#--runtime=} ;;
    --runtime=*) refuse "the runtime is runc or runsc" ;;
    --build=?*) builds+=("${arg#--build=}") ;;
    --group=?*) groups+=("${arg#--group=}") ;;
    --*) usage ;;
    *)
      [[ -z $stack ]] || usage
      stack=$arg
      ;;
  esac
  [[ $arg == --inside ]] || args+=("$arg")
done
[[ -n $stack ]] || usage

# ─── On the Mac: the copy, then this script again inside the VM ──────────────

if [[ $inside == 0 ]]; then
  command -v colima >/dev/null || refuse "no colima on this machine"
  colima status -p "$PROFILE" >/dev/null 2>&1 ||
    refuse "the Colima VM $PROFILE does not answer; this script never starts or repairs it"
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
  if [[ $sync == 1 ]]; then
    list=$(mktemp)
    trap 'rm -f "$list"' EXIT
    git -C "$root" ls-files -co --exclude-standard -z >"$list"
    if tr '\0' '\n' <"$list" | grep -qxE '\.env|.*/\.env|.*\.pem|.*\.key'; then
      refuse "the listing of the tree names an .env, a key or a certificate: it is not copied"
    fi
    # The tree of the Mac is mounted in the VM at the same path; the copy is made there.
    colima ssh -p "$PROFILE" -- sh -c 'cat > "$HOME/raditi-m7.list"' <"$list"
    colima ssh -p "$PROFILE" -- bash -c '
      set -euo pipefail
      root=$1
      tree=$HOME/raditi-m7
      mkdir -p "$tree"
      rsync -a --from0 --files-from="$HOME/raditi-m7.list" "$root/" "$tree/"
      if [[ -f $HOME/raditi-m7.manifest ]]; then
        comm -z -23 <(sort -z "$HOME/raditi-m7.manifest") <(sort -z "$HOME/raditi-m7.list") |
          while IFS= read -r -d "" path; do rm -f -- "$tree/$path"; done
      fi
      mv "$HOME/raditi-m7.list" "$HOME/raditi-m7.manifest"
      cd "$tree"
      [[ -d .git ]] || git init -q
      git add -A
      git -c user.name=raditi-m7 -c user.email=m7@raditi.invalid commit -q --allow-empty --no-verify -m "copy of the tree"
      echo "copy of the tree in $tree: $(git ls-files | wc -l) files"
    ' colima-m7 "$root"
    # exec below replaces this shell, and an EXIT trap never runs after it: the list goes now.
    rm -f "$list"
    trap - EXIT
  fi
  exec colima ssh -p "$PROFILE" -- bash -c 'cd "$HOME/'"$VM_TREE"'" && exec bash infra/dev/stack-verify/colima-m7.sh --inside "$@"' colima-m7 "${args[@]}"
fi

# ─── Inside the VM ───────────────────────────────────────────────────────────

[[ $(uname -s) == Linux ]] || refuse "--inside runs in the VM only"
cd "$HOME/$VM_TREE" || refuse "no copy of the tree in ~/$VM_TREE: run without --no-sync"
export PATH="$HOME/$TOOLS/bin:$HOME/$TOOLS/node/bin:$PATH"
export DOCKER_HOST="unix://$SOCKET"
export SANDBOX_DOCKER_SOCKET=$SOCKET
export RADITI_CMS_DIR=$HOME/raditi-cms

echo "== step 2: tools of the VM"
command -v node >/dev/null || refuse "no Node in the VM: install Node 26 into ~/$TOOLS/node (README, «В ВМ Colima»)"
[[ $(node --version) == v26.* ]] || refuse "Node 26 is needed, the VM has $(node --version)"
command -v pnpm >/dev/null || refuse "no pnpm in the VM: install pnpm 12 into ~/$TOOLS (README)"
[[ $(pnpm --version) == 12.* ]] || refuse "pnpm 12 is needed, the VM has $(pnpm --version)"
for tool in git rsync openssl; do
  command -v "$tool" >/dev/null || refuse "no $tool in the VM"
done
gitleaks_version=$(sed -n "s/^export const GITLEAKS_VERSION = '\(.*\)'$/\1/p" infra/dev/site-import-verify/stand.mjs)
command -v gitleaks >/dev/null || refuse "no Gitleaks in the VM: install Gitleaks $gitleaks_version into ~/$TOOLS/bin (README)"
[[ $(gitleaks version) == "$gitleaks_version" ]] ||
  refuse "Gitleaks $gitleaks_version is needed, the VM has $(gitleaks version)"
docker info >/dev/null 2>&1 || refuse "the Docker daemon of the VM does not answer on $SOCKET"
if [[ $runtime == runsc ]]; then
  docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' ||
    refuse "the Docker daemon of the VM has no runsc runtime"
fi
echo "node $(node --version), pnpm $(pnpm --version), gitleaks $(gitleaks version), runtime $runtime"

echo "== step 2: install and build"
pnpm install --frozen-lockfile
pnpm build

# The builds of the run: the named ones, or every row of the stack.
if [[ ${#builds[@]} -gt 0 ]]; then
  ids=("${builds[@]}")
else
  mapfile -t ids < <(node -e '
    const rows = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    for (const [id, row] of Object.entries(rows)) if (row.stack === process.argv[2]) console.log(id)
  ' infra/dev/stack-verify/cms-archives.json "$stack")
fi
[[ ${#ids[@]} -gt 0 ]] || refuse "the stack $stack has no build in cms-archives.json"
php=$(node -e '
  const rows = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  const versions = new Set()
  for (const id of process.argv.slice(3)) {
    const row = rows[id]
    if (!row || row.stack !== process.argv[2]) throw new Error(`no build ${id} of ${process.argv[2]}`)
    versions.add(row.php)
  }
  console.log([...versions].join(","))
' infra/dev/stack-verify/cms-archives.json "$stack" "${ids[@]}")

echo "== step 2: pinned images (never pulled here)"
node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const release = await import(`${process.cwd()}/infra/dev/release-verify/stand.mjs`)
  const bases = JSON.parse(readFileSync("infra/preview/site-bases.json", "utf8")).versions
  const images = ["POSTGRES", "REDIS", "S3", "OPENBAO", "GITEA", "RUNNER", "HOSTING", "MARIADB"].map(
    (name) => release[`${name}_IMAGE`],
  )
  for (const php of process.argv[1].split(","))
    images.push(bases.find((row) => row.php === php).image)
  for (const image of images) console.log(`${image}\t${release.PULLED_TAGS[image] ?? image}`)
' "$php" | while IFS=$'\t' read -r image tag; do
  docker image inspect "$image" >/dev/null 2>&1 ||
    refuse "the pinned image $image is not in the VM: docker pull $tag"
done

echo "== step 2: archives of ${ids[*]}"
node infra/dev/stack-verify/fetch-cms.mjs "${ids[@]}"

echo "== step 2: Chromium and WebKit of Playwright"
pnpm --filter e2e exec playwright install --with-deps chromium webkit

echo "== step 2: site images of PHP $php"
pnpm verify:site-images -- --build-only --only "$php"

if [[ $m2 == 1 ]]; then
  echo "== step 3: М2 of $stack under $runtime"
  # One build or more: the suite names each `<CMS> <version> as a preview`.
  only=()
  if [[ ${#builds[@]} -gt 0 ]]; then
    versions=$(printf '%s\n' "${builds[@]}" | sed "s/^$stack-//; s/\./\\\\./g" | paste -sd '|' -)
    only=(--testNamePattern=" ($versions) as a preview")
  fi
  PREVIEW_RUNTIME=$runtime RADITI_PREVIEW_DOCKER_TESTS=1 \
    pnpm --filter core exec vitest run --testTimeout=600000 \
    "${only[@]}" "src/previews/$stack-preview.integration.test.ts"
fi

echo "== step 4: verify:stack of $stack under $runtime"
options=(--stack="$stack" --runtime="$runtime")
for id in "${builds[@]}"; do options+=(--build="$id"); done
if [[ ${#groups[@]} -gt 0 ]]; then
  for group in "${groups[@]}"; do options+=(--group="$group"); done
else
  options+=(--group=import --group=preview --group=release)
fi
pnpm verify:stack -- "${options[@]}"
