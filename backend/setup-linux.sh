#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
  jwt_secret="$(openssl rand -hex 32 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  admin_password="$(openssl rand -base64 24 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
)"
  demo_password="$(openssl rand -base64 24 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
)"
  cp .env.example .env
  sed -i \
    -e "s/JWT_SECRET=replace-with-a-long-random-secret/JWT_SECRET=${jwt_secret}/" \
    -e "s|ADMIN_PASSWORD=replace-with-a-strong-password|ADMIN_PASSWORD=${admin_password}|" \
    -e "s|DEMO_PASSWORD=replace-with-a-strong-password|DEMO_PASSWORD=${demo_password}|" \
    .env
  printf 'Created backend/.env with generated local credentials.\n'
  printf 'Admin password: %s\n' "$admin_password"
  printf 'Demo password: %s\n' "$demo_password"
fi

tmp_venv="$(mktemp -d)"
if ! python3 -m venv "$tmp_venv/check" >/dev/null 2>&1 || ! "$tmp_venv/check/bin/python" -m pip --version >/dev/null 2>&1; then
  rm -rf "$tmp_venv"
  printf 'Missing working python3 venv/pip support. Install it first:\n'
  printf '  sudo apt install python3-venv python3-pip\n'
  exit 1
fi
rm -rf "$tmp_venv"

if [[ -x .venv/bin/python ]] && ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  printf 'Existing backend/.venv is incomplete; recreating it.\n'
  rm -rf .venv
fi

if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi

. .venv/bin/activate
python -m pip install --upgrade pip wheel setuptools
python -m pip install -r requirements.txt

printf '\nBackend dependencies are ready.\n'
printf 'Start MongoDB, then run:\n'
printf '  ./backend/start-backend-local.sh\n'
printf 'In another terminal run:\n'
printf '  ./backend/test-backend-local.sh\n'
