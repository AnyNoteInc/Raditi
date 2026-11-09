#!/usr/bin/env bash
# Prints passed=true to $GITHUB_OUTPUT when the commit $SHA of main is a tree the workflow CI has
# already passed on: the head of a merged pull request has the same tree, it contains the parent of
# $SHA, and a run of CI on that head succeeded. CI of a pull request checks the merge of its head
# with the base of that moment; that base is an ancestor of the parent of $SHA and so of the head,
# so the merge it checked is the head's tree, and that is the tree of $SHA. Anything else, an
# error of the API included, prints passed=false, and Release runs the gates itself.
set -uo pipefail

verdict() {
  echo "passed=$1" >> "$GITHUB_OUTPUT"
  echo "$2"
  exit 0
}

tree=$(git rev-parse "$SHA^{tree}") || verdict false "no tree of $SHA"
parent=$(git rev-parse "$SHA^") || verdict false "no parent of $SHA"
numbers=$(gh api "repos/$REPO/commits/$SHA/pulls" --jq '.[] | select(.merged_at != null) | .number') ||
  verdict false 'the pull requests of the commit were not read'

for number in $numbers; do
  head=$(gh api "repos/$REPO/pulls/$number" --jq .head.sha) || continue
  git fetch --quiet --no-tags origin "refs/pull/$number/head" || continue
  [ "$(git rev-parse "$head^{tree}")" = "$tree" ] || {
    echo "#$number: the head $head has another tree"
    continue
  }
  git merge-base --is-ancestor "$parent" "$head" || {
    echo "#$number: the head $head does not contain $parent"
    continue
  }
  runs=$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$head&event=pull_request&status=success" \
    --jq .total_count) || continue
  [ "${runs:-0}" -gt 0 ] && verdict true "#$number: CI passed on $head, the tree of $SHA"
  echo "#$number: no successful CI run on $head"
done
verdict false "no pull request of $SHA was checked on its tree"
