#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
  printf 'backend/.env is missing. Run ./backend/setup-linux.sh first.\n'
  exit 1
fi

if [[ ! -x .venv/bin/python ]]; then
  printf 'backend/.venv is missing. Run ./backend/setup-linux.sh first.\n'
  exit 1
fi

if ! timeout 1 bash -c '</dev/tcp/127.0.0.1/27017' >/dev/null 2>&1; then
  printf 'MongoDB is not running on 127.0.0.1:27017.\n'
  printf 'Install/start MongoDB, or with Docker:\n'
  printf '  docker run -d --name ghostel-mongo -p 27017:27017 mongo:7\n'
  exit 1
fi

printf 'Ghostel backend: http://127.0.0.1:8000/api/\n'
. .venv/bin/activate
exec python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
