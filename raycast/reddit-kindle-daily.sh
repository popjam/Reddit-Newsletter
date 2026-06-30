#!/bin/bash
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Newsletter Daily
# @raycast.mode silent
# Optional parameters:
# @raycast.packageName Reddit Newsletter
# @raycast.description Generate and send the daily Reddit Kindle EPUB.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
fi

cd "/Users/james/stuff-large/reddit-newsletter/Reddit-Newsletter"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found in Raycast's PATH."
  echo "Install Node.js or update PATH in this script."
  exit 127
fi

osascript <<'APPLESCRIPT'
tell application "Terminal"
  activate
  do script "cd /Users/james/stuff-large/reddit-newsletter/Reddit-Newsletter && export REDDIT_CONFIG=user-config.daily.json && npm start"
end tell
APPLESCRIPT
