#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok() {
  printf '[OK] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

missing() {
  printf '[MISSING] %s\n' "$1"
}

check_cmd() {
  local cmd="$1"
  local hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd: $($cmd --version 2>&1 | head -n 1)"
  else
    missing "$cmd ($hint)"
  fi
}

printf 'ghostel.app test environment check\n'
printf 'Root: %s\n\n' "$ROOT_DIR"

check_cmd python3 "install python3 python3-venv python3-pip"

tmp_venv="$(mktemp -d)"
if python3 -m venv "$tmp_venv/check" >/dev/null 2>&1 && "$tmp_venv/check/bin/python" -m pip --version >/dev/null 2>&1; then
  ok "python3 venv module"
else
  missing "python3 venv module (sudo apt install python3-venv python3-pip)"
fi
rm -rf "$tmp_venv"

if python3 -m pip --version >/dev/null 2>&1; then
  ok "python3 pip: $(python3 -m pip --version)"
else
  missing "python3 pip (sudo apt install python3-pip)"
fi

check_cmd node "install Node.js 20+"
check_cmd npm "install npm or enable corepack"

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
  if [[ "$node_major" -ge 20 ]]; then
    ok "Node.js major version is >= 20"
  else
    missing "Node.js 20+ required by Firebase packages (current: $(node --version))"
  fi
fi

if command -v yarn >/dev/null 2>&1; then
  ok "yarn: $(yarn --version)"
else
  missing "yarn (npm install -g yarn@1.22.22 after Node is installed)"
fi

if command -v java >/dev/null 2>&1; then
  ok "java: $(java -version 2>&1 | head -n 1)"
else
  warn "java missing; Android builds need JDK 17"
fi

if command -v mongod >/dev/null 2>&1; then
  ok "mongod: $(mongod --version 2>&1 | head -n 1)"
else
  warn "mongod missing; use MongoDB locally or Docker"
fi

if command -v docker >/dev/null 2>&1; then
  ok "docker: $(docker --version)"
else
  warn "docker missing; optional, useful for local MongoDB"
fi

if timeout 1 bash -c '</dev/tcp/127.0.0.1/27017' >/dev/null 2>&1; then
  ok "MongoDB reachable at 127.0.0.1:27017"
else
  warn "MongoDB is not reachable at 127.0.0.1:27017"
fi

android_home="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
if [[ -x "$android_home/cmdline-tools/latest/bin/sdkmanager" ]]; then
  ok "Android SDK: $android_home"
else
  warn "Android SDK command-line tools missing at $android_home"
fi

if [[ -f "$ROOT_DIR/backend/.env" ]]; then
  ok "backend/.env exists"
else
  warn "backend/.env missing; backend/setup-linux.sh can create it"
fi

if [[ -f "$ROOT_DIR/frontend/.env" ]]; then
  ok "frontend/.env exists"
else
  warn "frontend/.env missing; frontend/setup-linux.sh can create it"
fi

printf '\nSuggested Ubuntu packages:\n'
printf '  sudo apt update && sudo apt install -y python3 python3-venv python3-pip nodejs npm openjdk-17-jdk docker.io\n'
printf 'Then install Node 20 and Yarn 1:\n'
printf '  sudo npm install -g n && sudo n 20\n'
printf '  sudo npm install -g yarn@1.22.22\n'
printf 'MongoDB via Docker:\n'
printf '  sudo docker run -d --name ghostel-mongo -p 27017:27017 mongo:7\n'
