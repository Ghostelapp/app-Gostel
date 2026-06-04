#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
  cp .env.example .env
  printf 'Created frontend/.env.\n'
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js is missing. Install Node.js first, then rerun this script.\n'
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
if [[ "$node_major" -lt 20 ]]; then
  printf 'Node.js 20+ is required. Current version: %s\n' "$(node --version)"
  printf 'One local option:\n'
  printf '  sudo npm install -g n && sudo n 20\n'
  exit 1
fi

if ! command -v yarn >/dev/null 2>&1; then
  printf 'Yarn 1 is missing. Install it with:\n'
  printf '  sudo npm install -g yarn@1.22.22\n'
  exit 1
fi

yarn install

printf '\nFrontend dependencies are ready.\n'
printf 'Run web:\n'
printf '  ./frontend/serve-web-local.sh\n'
printf 'Run Expo dev server:\n'
printf '  ./frontend/start-expo-local.sh\n'
