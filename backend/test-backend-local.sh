#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
cd "$BACKEND_DIR"

if [[ ! -x .venv/bin/python ]]; then
  printf 'backend/.venv is missing. Run ./backend/setup-linux.sh first.\n'
  exit 1
fi

. .venv/bin/activate

export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8000}"
export EXPO_PUBLIC_BACKEND_URL="${EXPO_PUBLIC_BACKEND_URL:-$BACKEND_URL}"
export PYTHONPATH="${PYTHONPATH:-$ROOT_DIR}"

if ! timeout 2 bash -c '</dev/tcp/127.0.0.1/8000' >/dev/null 2>&1; then
  printf 'Backend is not reachable at %s. Start it first:\n' "$BACKEND_URL"
  printf '  ./backend/start-backend-local.sh\n'
  exit 1
fi

cd "$ROOT_DIR"
python -m pytest backend/tests "$@"
