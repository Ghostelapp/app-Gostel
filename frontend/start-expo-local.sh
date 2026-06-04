#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

export NODE_OPTIONS="${NODE_OPTIONS:---use-system-ca}"
export EXPO_NO_TELEMETRY="${EXPO_NO_TELEMETRY:-1}"

exec npx expo start --web --port "${PORT:-19006}"
