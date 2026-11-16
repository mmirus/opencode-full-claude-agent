#!/usr/bin/env bash
# Moves the checkout that OpenCode loads to a commit and installs its dependencies.
# Usage: scripts/deploy-live.sh [--force] [<live-checkout>] [<ref>]
set -euo pipefail

force=0
if [[ "${1:-}" == "--force" ]]; then force=1; shift; fi
live="${1:-$HOME/git/opencode-full-claude-agent-live}"
ref="${2:-main}"

# OpenCode re-imports Full Claude when its files change, which interrupts every active Full Claude turn,
# including the one running this script from native Bash.
if [[ -n "${CLAUDECODE:-}" && $force -eq 0 ]]; then
  echo "Refusing to deploy from inside a Claude Code turn; run this from a terminal while no Full Claude turn is active, or pass --force." >&2
  exit 1
fi

if [[ ! -e "$live/.git" ]]; then
  repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
  git -C "$repo" worktree add --detach "$live" "$ref"
else
  if [[ -n "$(git -C "$live" status --porcelain)" ]]; then
    echo "$live has local changes; resolve them before deploying." >&2
    exit 1
  fi
  git -C "$live" switch --detach "$ref"
fi
(cd "$live" && bun install --frozen-lockfile)
echo "Deployed $(git -C "$live" rev-parse --short HEAD) to $live"
