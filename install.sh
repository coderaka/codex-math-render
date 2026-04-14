#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PATH="${1:-/Applications/Codex.app}"

cd "$REPO_DIR"

if [ ! -d "node_modules" ]; then
  npm install
fi

node ./scripts/install_codex_math_poc.mjs --app "$APP_PATH"
