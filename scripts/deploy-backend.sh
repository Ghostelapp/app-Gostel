#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/apps/app-Gostel"
BACKEND_DIR="$APP_DIR/backend"
SERVICE_NAME="ghostel-app.service"

echo "==> Pulling latest code..."
cd "$APP_DIR"
git fetch origin
git checkout deploy-1.4.54
git pull origin deploy-1.4.54

echo "==> Installing backend dependencies..."
cd "$BACKEND_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "==> Restarting service..."
sudo systemctl restart "$SERVICE_NAME"
sleep 3
sudo systemctl status "$SERVICE_NAME" --no-pager

echo "==> Checking health endpoint..."
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/admin/health || true

echo "==> Done."
