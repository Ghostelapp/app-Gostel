#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

export NODE_OPTIONS="${NODE_OPTIONS:---use-system-ca}"
export EXPO_NO_TELEMETRY="${EXPO_NO_TELEMETRY:-1}"
export EXPO_PUBLIC_BACKEND_URL="${EXPO_PUBLIC_BACKEND_URL:-http://127.0.0.1:8000}"

npx expo export --platform web --output-dir dist-local --clear --dev

printf '\nGhostel web is available at:\n'
printf '  http://127.0.0.1:19006\n\n'

exec python3 serve_static.py --host 127.0.0.1 --port 19006 --directory dist-local
