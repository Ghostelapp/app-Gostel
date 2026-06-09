# ghostel.app Handoff

This file is a quick handoff for continuing ghostel.app on a new computer.

## Repository

GitHub:

```text
https://github.com/Ghostelapp/app-Gostel
```

Clone:

```powershell
git clone https://github.com/Ghostelapp/app-Gostel.git
cd app-Gostel
```

## Project Layout

```text
backend/   FastAPI backend, MongoDB, auth, messaging, calls, push support
frontend/  Expo / React Native Android app
memory/    Product notes
tests/     Shared tests
```

## What Is Not In Git

These are intentionally not pushed:

```text
backend/.env
frontend/.env
backend/.venv/
frontend/node_modules/
frontend/android/app/build/
APK files
local Gradle/Metro/cache folders
```

Copy local `.env` files from the old computer or recreate them from:

```text
backend/.env.example
frontend/.env.example
```

Do not commit real passwords, JWT secrets, Firebase private keys, or service account JSON files.

## Backend Setup

Requirements:

```text
Python 3.12+
MongoDB running on 127.0.0.1:27017
```

Linux quick start:

```bash
./scripts/check-test-env.sh
sudo docker run -d --name ghostel-mongo -p 27017:27017 mongo:7
./backend/setup-linux.sh
./backend/start-backend-local.sh
```

Run backend tests from another terminal:

```bash
./backend/test-backend-local.sh
```

Windows quick start:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
```

Fill `backend/.env`, then start:

```powershell
.\start-backend-local.ps1
```

Backend URL:

```text
http://127.0.0.1:8000/docs
```

For phone testing, use the computer LAN IP:

```text
http://YOUR_PC_LAN_IP:8000
```

Example from the old machine:

```text
http://192.168.88.7:8000
```

## Frontend Setup

Requirements:

```text
Node.js LTS
npm
Android Studio
Android SDK
Java from Android Studio JBR
```

Linux quick start:

```bash
./frontend/setup-linux.sh
./frontend/serve-web-local.sh
```

The current Firebase packages require Node.js 20 or newer. If Ubuntu installs Node 18, upgrade it locally:

```bash
sudo npm install -g n
sudo n 20
hash -r
```

Install:

```powershell
cd frontend
npm install
copy .env.example .env
```

Set `frontend/.env`:

```text
EXPO_PUBLIC_BACKEND_URL=http://YOUR_PC_LAN_IP:8000
```

For web/dev:

```powershell
npm run start
```

For Android native builds, make sure Android Studio SDK paths are configured.

## Current Test Login

Admin email:

```text
admin@ghostel.app
```

The admin password is in the local `backend/.env` file on the old computer. It is not stored in GitHub.

## Important Recent Fixes

The Android release APK previously showed `Network Error` while logging in to the local backend. The fix was added in:

```text
frontend/android/app/src/main/AndroidManifest.xml
```

The app now allows cleartext local HTTP for development:

```text
android:usesCleartextTraffic="true"
```

This is for local testing with `http://192.168.x.x:8000`. For production, use HTTPS and remove or restrict this behavior.

Other important fixes already in the repo:

```text
frontend/scripts/patch-callkeep.js
frontend/scripts/patch-webrtc.js
```

`package.json` runs those patches on postinstall.

## Testing Checklist On New Computer

1. Clone repo.
2. Recreate `backend/.env`.
3. Start MongoDB.
4. Start backend and open `http://127.0.0.1:8000/docs`.
5. Test backend login through API.
6. Recreate `frontend/.env` with the new PC LAN IP.
7. Install frontend dependencies.
8. Build/install Android app.
9. Test login on the phone.
10. If phone shows `Network Error`, check:
    - phone and PC are on the same Wi-Fi
    - backend listens on `0.0.0.0:8000`
    - Windows firewall allows port `8000`
    - `frontend/.env` uses the current PC LAN IP

## Continuing With Codex

Start a new Codex conversation on the new computer and say:

```text
Kontynuujemy projekt ghostel.app z repo Ghostelapp/app-Gostel. Backend to FastAPI/MongoDB na porcie 8000, frontend to Expo/React Native Android. Ostatnio naprawiliśmy Android Network Error przez usesCleartextTraffic i wypchnęliśmy pierwszy commit na GitHuba. Przeczytaj HANDOFF.md i pomóż uruchomić projekt lokalnie.
```
