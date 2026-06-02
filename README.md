# Ghostel

Ghostel is a mobile/web communication app with a FastAPI backend and an Expo frontend.

## Setup

1. Copy `backend/.env.example` to `backend/.env` and fill in real values.
2. Copy `frontend/.env.example` to `frontend/.env` and point it at the backend URL.
3. Keep secrets out of the repository. Firebase service-account credentials should be provided through `FCM_SERVICE_ACCOUNT_JSON` or `FCM_SERVICE_ACCOUNT_PATH`.

## Security Notes

- `ADMIN_PASSWORD` is required. The backend no longer creates a default admin with a public password.
- Do not commit `backend/firebase-service-account.json`.
- The current chat payloads are stored server-side; do not market the app as end-to-end encrypted until client-side message encryption is implemented.
