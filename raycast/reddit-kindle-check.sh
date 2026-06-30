#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Reddit Kindle Check
# @raycast.mode fullOutput
# Optional parameters:
# @raycast.packageName Reddit Newsletter
# @raycast.description Check Raycast, Node, npm, and config paths without generating anything.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
fi

PROJECT_DIR="/Users/james/stuff-large/reddit-newsletter/Reddit-Newsletter"

echo "Raycast can run this script."
echo "Project: $PROJECT_DIR"

cd "$PROJECT_DIR"

echo
echo "Node:"
if command -v node >/dev/null 2>&1; then
  node --version
else
  echo "not found"
fi

echo
echo "npm:"
if command -v npm >/dev/null 2>&1; then
  npm --version
else
  echo "not found"
fi

echo
echo "Configs:"
[[ -f user-config.json ]] && echo "weekly config: found" || echo "weekly config: missing"
[[ -f user-config.daily.json ]] && echo "daily config: found" || echo "daily config: missing"

echo
echo "No generation was run."
