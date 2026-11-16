#!/bin/bash
# macOS: double-click this file to start Jarvis.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Jarvis needs Node.js (free). Install the LTS version from https://nodejs.org"
  echo "then double-click this file again."
  echo ""
  read -r -p "Press Return to close." _
  exit 1
fi
node server.mjs
status=$?
if [ $status -ne 0 ]; then echo ""; read -r -p "Jarvis stopped (code $status). Press Return to close." _; fi
