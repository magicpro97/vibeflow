#!/usr/bin/env bash
# scripts/create-worktree.sh
#
# A6 (issue #172) — `vf worktree create` shell helper.
#
# Creates a new git worktree at <path> for <branch>, then symlinks
# `node_modules` from $PWD into the worktree so we skip the ~60-90s
# `bun install` per worktree (the standard A6 acceptance criterion).
#
# Contract:
#   create-worktree.sh <branch> <path> [--base <base>]
#
# Exit codes:
#   0  worktree created + node_modules symlinked
#   1  usage error (missing args, unknown flag)
#   2  preflight failed (not in a git repo, branch exists, worktree path exists)
#   3  git worktree add failed
#   4  node_modules symlink failed
#
# Refuses to clobber: if <path> already exists OR a worktree for
# <branch> is already registered, the script exits 2 with a clear
# message. The caller (or the operator) decides whether to remove
# the existing worktree first.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: create-worktree.sh <branch> <path> [--base <base>]

  <branch>  the new branch name (git worktree add -b <branch> ...)
  <path>    the directory to create the worktree in (absolute path
            recommended; relative paths resolve against $PWD)
  --base    the base branch to fork from (default: HEAD)

Creates a git worktree and symlinks node_modules from $PWD so the
new worktree can skip `bun install`.
EOF
}

# ---- arg parse ----
if [[ $# -lt 2 ]]; then
  usage >&2
  exit 1
fi

branch="$1"
path="$2"
base=""

shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $# -lt 2 ]]; then
        echo "create-worktree.sh: --base requires a value" >&2
        exit 1
      fi
      base="$2"
      shift 2
      ;;
    --base=*)
      base="${1#--base=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "create-worktree.sh: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---- preflight: must be in a git repo ----
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "create-worktree.sh: not inside a git work tree (run from inside a repo)" >&2
  exit 2
fi

# ---- refuse to clobber: worktree path must not exist ----
if [[ -e "$path" ]]; then
  echo "create-worktree.sh: path already exists: $path (refusing to clobber)" >&2
  exit 2
fi

# ---- refuse to clobber: branch must not already have a worktree ----
# `git worktree list --porcelain` prints lines like
#   worktree /abs/path
#   HEAD <sha>
#   branch refs/heads/<name>
# We look for any worktree whose branch matches <branch>.
existing=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      wt_path="${line#worktree }"
      ;;
    "branch refs/heads/"*)
      wt_branch="${line#branch refs/heads/}"
      if [[ "$wt_branch" == "$branch" ]]; then
        existing="$wt_path"
      fi
      ;;
  esac
done < <(git worktree list --porcelain)
if [[ -n "$existing" ]]; then
  echo "create-worktree.sh: branch '$branch' already has a worktree at: $existing" >&2
  echo "  (use 'git worktree remove' first, or pick a different branch name)" >&2
  exit 2
fi

# ---- create the worktree ----
parent_dir="$(dirname "$path")"
mkdir -p "$parent_dir"

if [[ -n "$base" ]]; then
  if ! git worktree add -b "$branch" "$path" "$base"; then
    echo "create-worktree.sh: git worktree add -b $branch $path $base failed" >&2
    exit 3
  fi
else
  if ! git worktree add -b "$branch" "$path"; then
    echo "create-worktree.sh: git worktree add -b $branch $path failed" >&2
    exit 3
  fi
fi

# ---- symlink node_modules from the parent repo ----
# A6 spec: "Symlink `node_modules` from parent repo to worktree
# (skip if worktree is for different package manager)." For the
# common case the parent has node_modules; if it doesn't, the
# worktree will install on its own (the symlink is best-effort).
parent_nm="$PWD/node_modules"
worktree_nm="$path/node_modules"
if [[ -e "$parent_nm" && ! -e "$worktree_nm" ]]; then
  # Absolute symlink to the parent's node_modules so the worktree
  # works no matter where the worktree lives relative to the parent.
  if ! ln -s "$parent_nm" "$worktree_nm"; then
    echo "create-worktree.sh: node_modules symlink failed" >&2
    exit 4
  fi
  echo "create-worktree.sh: node_modules symlinked from $parent_nm"
elif [[ -e "$worktree_nm" ]]; then
  echo "create-worktree.sh: node_modules already exists in $path, leaving it alone"
else
  echo "create-worktree.sh: parent has no node_modules; worktree will install on its own"
fi

echo "worktree: $path"
echo "branch:   $branch"
echo "cd $(printf '%q' "$path")"
