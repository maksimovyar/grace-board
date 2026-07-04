#!/usr/bin/env bash
#
# Install the bundled extensions (the /grace-feature-dev command, the gfd-* agents,
# and the grace-feature-dev skill) into your user-level Claude Code config so the
# board's headless runs can find them.
#
# WHY this is needed: grace-board launches `claude -p "/grace-feature-dev …"` inside
# the *target project's* directory, not inside grace-board — so Claude Code resolves
# the command/agents/skills from your user config (~/.claude), not from this repo.
# This script symlinks the repo's copies into ~/.claude so a `git pull` keeps them
# up to date. Pre-existing, non-symlink files are left untouched (never clobbered).
#
# Usage:   ./install.sh            # symlink into ~/.claude
#          CLAUDE_HOME=/path ./install.sh   # custom Claude config dir
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
SRC="$REPO/.claude"

link() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "  skip (exists, not a symlink): $dst"
    return
  fi
  ln -sfn "$src" "$dst"
  echo "  linked: $dst"
}

echo "Installing GRACE extensions into: $DEST"
for kind in commands agents skills; do
  [ -d "$SRC/$kind" ] || continue
  for item in "$SRC/$kind"/*; do
    [ -e "$item" ] || continue
    link "$item" "$DEST/$kind/$(basename "$item")"
  done
done

echo
echo "Done. Start a fresh Claude Code session (or restart the board) to pick up"
echo "the /grace-feature-dev pipeline. Then: npm start  →  http://127.0.0.1:4317"
