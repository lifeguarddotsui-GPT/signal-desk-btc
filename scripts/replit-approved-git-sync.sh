#!/usr/bin/env bash
# Controlled source-only sync inside the EXISTING Replit workspace.
# Never publishes, deploys, force-resets or touches the database.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "Usage: bash scripts/replit-approved-git-sync.sh <full-approved-40-character-SHA> <reviewed-branch>"
  exit 2
fi
expected="$1"
branch="$2"
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$branch" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
  echo "Refusing invalid SHA or branch name"
  exit 2
fi
git rev-parse --is-inside-work-tree | grep -qx true || { echo "Not a Git checkout";exit 3; }
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
origin="$(git remote get-url origin || true)"
case "$origin" in
  https://github.com/lifeguarddotsui-GPT/signal-desk-btc|https://github.com/lifeguarddotsui-GPT/signal-desk-btc.git|git@github.com:lifeguarddotsui-GPT/signal-desk-btc.git) ;;
  *) echo "Origin is not the audited Blue Water GitHub repository. STOP before changing anything.";exit 4;;
esac
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Uncommitted Replit changes exist. STOP; back up and resolve before sync.";exit 5
fi
current="$(git rev-parse HEAD)"
echo "Before: $current"
git fetch --no-tags origin "$branch"
actual="$(git rev-parse FETCH_HEAD)"
if [[ "$actual" != "$expected" ]]; then
  echo "Fetched branch HEAD differs from owner-approved immutable SHA. STOP.";exit 6
fi
if ! git merge-base --is-ancestor "$current" "$expected"; then
  echo "Not a fast-forward from the current workspace. STOP. A one-time reviewed Git reconciliation is needed.";exit 7
fi
echo "Fast-forward preview:"
git diff --stat "$current" "$expected" | tail -n 30
git merge --ff-only "$expected"
if [[ "$(git rev-parse HEAD)" != "$expected" ]]; then
  echo "Unexpected final SHA; stop before building or publishing.";exit 8
fi
echo "Reviewed SHA is now checked out; production IS NOT DEPLOYED."
echo "CI must already be green. Run npm ci --no-audit --no-fund && npm run build."
echo "Only publish via the existing Replit project after separately approving deployment and verifying backup/rollback."
