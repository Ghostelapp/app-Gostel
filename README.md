# Ghostel

Ghostel is a mobile/web communication app with a FastAPI backend and an Expo frontend.

## Setup

1. Copy `backend/.env.example` to `backend/.env` and fill in real values.
2. Copy `frontend/.env.example` to `frontend/.env` and point it at the backend URL.
3. Keep secrets out of the repository. Firebase service-account credentials should be provided through `FCM_SERVICE_ACCOUNT_JSON` or `FCM_SERVICE_ACCOUNT_PATH`.

## Linux Local Testing

After moving the project from Windows to Linux, first check the machine:

```bash
./scripts/check-test-env.sh
```

Ubuntu packages usually needed for local tests:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nodejs npm openjdk-17-jdk docker.io
sudo npm install -g n
sudo n 20
sudo npm install -g yarn@1.22.22
```

Backend:

```bash
sudo docker run -d --name ghostel-mongo -p 27017:27017 mongo:7
./backend/setup-linux.sh
./backend/start-backend-local.sh
```

In another terminal:

```bash
./backend/test-backend-local.sh
```

Frontend:

```bash
./frontend/setup-linux.sh
./frontend/serve-web-local.sh
```

Android builds use the checked-in Gradle wrapper:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
cd frontend/android
./gradlew assembleDebug
```

## Security Notes

- `ADMIN_PASSWORD` is required. The backend no longer creates a default admin with a public password.
- `JWT_SECRET` must be a long random value, at least 32 bytes. Rotating it invalidates active sessions.
- Do not commit `backend/firebase-service-account.json`.
- User messages, attachments and call signaling SDP/ICE are required to use client-side E2EE. Calls require device E2EE keys before start and use WebRTC DTLS-SRTP for media transport. Operational metadata, account data, push tokens, membership data and call records are still processed by the backend as needed to operate the service. Do not claim SOC 2 certification unless an external SOC 2 audit/report exists.
