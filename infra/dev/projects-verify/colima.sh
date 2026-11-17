#!/usr/bin/env bash
# The projects stand inside the Colima VM `gvisor` (README, «Linux и CI»): a Linux daemon with runc
# and runsc. From the Mac the stand does not run on the daemon of the VM — the processes of the
# stand listen on the loopback of the machine of the daemon, and node_modules of the Mac do not run
# on Linux —, so the whole run goes inside the VM, on a copy of this tree in its home.
#
#   bash infra/dev/projects-verify/colima.sh [--no-sync] [--runtime=runc|runsc] [--no-build]
#                                            [--keep] [--only=E,F]
#
#   1. The files of this tree git knows (tracked and untracked, not ignored: never .env,
#      node_modules or dist) are copied into ~/raditi-projects of the VM; a file gone from the tree
#      is removed there; the copy is a git repository of its own (the stand lists files with git).
#      --no-sync — the copy as it is.
#   2. In the VM: Node 26, pnpm 12, git, rsync, openssl and Gitleaks of apps/core/Dockerfile are
#      checked, each refused in words; with --runtime=runsc, the runsc runtime of the daemon.
#   3. `pnpm verify:projects` with the rest of the options (the stand builds its own private copy
#      and checks the pinned images itself; it never pulls them).
#
# The VM is never started, stopped or reconfigured here, and no image is pulled. Only synthetic
# data; no real model, key or repository.
set -euo pipefail

PROFILE=gvisor
VM_TREE=raditi-projects
# Node, pnpm and Gitleaks of the VM: the folder the stack stand set up (plan 62, М7) and kept.
TOOLS=.raditi-m7
SOCKET=/var/run/docker.sock

refuse() {
  echo "colima: $*" >&2
  exit 1
}

inside=0
sync=1
runtime=runc
args=()
for arg in "$@"; do
  # Every argument crosses ssh and reaches pnpm: plain words only.
  [[ $arg =~ ^[A-Za-z0-9=,._-]+$ ]] || refuse "an argument may hold letters, digits and = , . _ - only: $arg"
  case $arg in
    --inside) inside=1 ;;
    --no-sync) sync=0 ;;
    --runtime=runc | --runtime=runsc) runtime=${arg#--runtime=} ;;
    --runtime=*) refuse "the runtime is runc or runsc" ;;
    --no-build | --keep | --only=?*) ;;
    *) refuse "usage: bash infra/dev/projects-verify/colima.sh [--no-sync] [--runtime=runc|runsc] [--no-build] [--keep] [--only=E,F]" ;;
  esac
  [[ $arg == --inside || $arg == --no-sync ]] || args+=("$arg")
done
[[ " ${args[*]-} " == *" --runtime="* ]] || args+=("--runtime=$runtime")

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
    colima ssh -p "$PROFILE" -- sh -c 'cat > "$HOME/raditi-projects.list"' <"$list"
    colima ssh -p "$PROFILE" -- bash -c '
      set -euo pipefail
      root=$1
      tree=$HOME/raditi-projects
      mkdir -p "$tree"
      rsync -a --from0 --files-from="$HOME/raditi-projects.list" "$root/" "$tree/"
      if [[ -f $HOME/raditi-projects.manifest ]]; then
        comm -z -23 <(sort -z "$HOME/raditi-projects.manifest") <(sort -z "$HOME/raditi-projects.list") |
          while IFS= read -r -d "" path; do rm -f -- "$tree/$path"; done
      fi
      mv "$HOME/raditi-projects.list" "$HOME/raditi-projects.manifest"
      cd "$tree"
      [[ -d .git ]] || git init -q
      git add -A
      git -c user.name=raditi-colima -c user.email=colima@raditi.invalid commit -q --allow-empty --no-verify -m "copy of the tree"
      echo "copy of the tree in $tree: $(git ls-files | wc -l) files"
    ' colima "$root"
    # exec below replaces this shell, and an EXIT trap never runs after it: the list goes now.
    rm -f "$list"
    trap - EXIT
  fi
  exec colima ssh -p "$PROFILE" -- bash -c 'cd "$HOME/'"$VM_TREE"'" && exec bash infra/dev/projects-verify/colima.sh --inside "$@"' colima "${args[@]}"
fi

# ─── Inside the VM ───────────────────────────────────────────────────────────

[[ $(uname -s) == Linux ]] || refuse "--inside runs in the VM only"
cd "$HOME/$VM_TREE" || refuse "no copy of the tree in ~/$VM_TREE: run without --no-sync"
export PATH="$HOME/$TOOLS/bin:$HOME/$TOOLS/node/bin:$PATH"
export DOCKER_HOST="unix://$SOCKET"

command -v node >/dev/null || refuse "no Node in the VM: install Node 26 into ~/$TOOLS/node (README, «Linux и CI»)"
[[ $(node --version) == v26.* ]] || refuse "Node 26 is needed, the VM has $(node --version)"
command -v pnpm >/dev/null || refuse "no pnpm in the VM: install pnpm 12 into ~/$TOOLS/bin (README)"
[[ $(pnpm --version) == 12.* ]] || refuse "pnpm 12 is needed, the VM has $(pnpm --version)"
for tool in git rsync openssl; do
  command -v "$tool" >/dev/null || refuse "no $tool in the VM"
done
gitleaks_version=$(sed -n 's/^ARG GITLEAKS_IMAGE=.*:v\([0-9.]*\)@.*$/\1/p' apps/core/Dockerfile)
command -v gitleaks >/dev/null || refuse "no Gitleaks in the VM: install Gitleaks $gitleaks_version into ~/$TOOLS/bin (README)"
[[ $(gitleaks version) == "$gitleaks_version" ]] ||
  refuse "Gitleaks $gitleaks_version is needed, the VM has $(gitleaks version)"
docker info >/dev/null 2>&1 || refuse "the Docker daemon of the VM does not answer on $SOCKET"
if [[ $runtime == runsc ]]; then
  docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' ||
    refuse "the Docker daemon of the VM has no runsc runtime"
fi
echo "node $(node --version), pnpm $(pnpm --version), gitleaks $(gitleaks version), docker $(docker version --format '{{.Server.Version}}'), the sandbox under $runtime"

exec pnpm verify:projects -- "${args[@]}"
