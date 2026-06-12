#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$HOME/apps/app-Gostel}"
WEBSITE_ROOT="${WEBSITE_ROOT:-$HOME/apps/GhostelAPPweb}"
WEB_APP_ROOT="${WEB_APP_ROOT:-/var/www/ghostel-web-app}"
WEBSITE_STATIC_ROOT="${WEBSITE_STATIC_ROOT:-/var/www/ghostel}"

echo "Updating ghostel.app backend and browser app..."
cd "$APP_ROOT"
git pull --ff-only origin main

cd backend
. .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart ghostel-app

cd "$APP_ROOT/frontend"
corepack yarn install --frozen-lockfile
EXPO_PUBLIC_BACKEND_URL=https://api.ghostel.app corepack yarn web:build
sudo install -d -o www-data -g www-data "$WEB_APP_ROOT"
sudo cp -a dist-web/. "$WEB_APP_ROOT/"
sudo chown -R www-data:www-data "$WEB_APP_ROOT"

echo "Updating ghostel.app landing page..."
cd "$WEBSITE_ROOT"
git pull --ff-only origin GhostelWebApp

cd backend
. .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart ghostel-web-api

cd frontend
corepack yarn install --frozen-lockfile
corepack yarn build
sudo install -d -o www-data -g www-data "$WEBSITE_STATIC_ROOT"
sudo cp -a build/. "$WEBSITE_STATIC_ROOT/"
sudo chown -R www-data:www-data "$WEBSITE_STATIC_ROOT"

sudo nginx -t
sudo systemctl reload nginx

curl -fsS https://api.ghostel.app/api/ >/dev/null
curl -fsS https://panel-api.ghostel.app/api/ >/dev/null
curl -fsSI https://app.ghostel.app >/dev/null
curl -fsSI https://ghostel.app >/dev/null

echo "ghostel.app release deployed successfully."
