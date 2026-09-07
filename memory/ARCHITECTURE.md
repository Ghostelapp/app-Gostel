# ARCHITECTURE.md

## Ogólna architektura

```
┌─────────────────────────────────────────────────────────────┐
│                        KLIENT                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   iOS App   │  │ Android App │  │   Web / Desktop     │  │
│  │ (Expo/EAS)  │  │ (Expo/EAS)  │  │   (React Native Web)│  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │             │
│         └────────────────┴────────────────────┘             │
│                          │                                   │
│                   REST API + WebSocket                       │
└──────────────────────────┬───────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Nginx     │
                    │  (reverse)  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌────▼────┐ ┌────▼─────┐
        │  FastAPI  │ │ MongoDB │ │   S3     │
        │  backend  │ │         │ │ uploads  │
        │  server.py│ │         │ │          │
        └─────┬─────┘ └─────────┘ └──────────┘
              │
        ┌─────▼──────────────────────┐
        │   FCM / APNs VoIP Push     │
        └────────────────────────────┘
```

## Backend

Jeden plik `backend/server.py` (~6k linii, 171 funkcji, 29 klas Pydantic + WSManager).

### Główne komponenty

- **FastAPI app** + `APIRouter(prefix="/api")`
- **MongoDB** via `AsyncIOMotorClient`
- **Auth**: JWT access tokens, refresh sessions, TOTP 2FA, bcrypt
- **WebSocket Manager**: `/api/ws` — realtime messages, presence, call signaling
- **Push**: FCM (Android), APNs VoIP (iOS)
- **Uploads**: S3 pre-signed URLs
- **Admin**: stats, users, health, restart

### Pliki pomocnicze backend

- `backend/fcm.py` — konfiguracja i wysyłka FCM
- `backend/apns.py` — konfiguracja i wysyłka VoIP push iOS
- `backend/requirements.txt` — zależności Python
- `backend/tests/` — testy pytest

## Frontend

### Struktura

- `frontend/app/` — routing Expo Router (file-based)
- `frontend/src/` — współdzielone moduły (API, auth, WebRTC, push, i18n)
- `frontend/assets/` — obrazy, dźwięki, czcionki
- `frontend/android/` — natywne pliki Android (prebuild)
- `frontend/desktop/` — konfiguracja Electron

### Kluczowe moduły src

- `api.ts` — axios client, BASE_URL, timeout 60s
- `auth.tsx` — kontekst auth, login/register/logout
- `ws.ts` — WebSocket client
- `webrtc.ts` / `webrtc.web.ts` — WebRTC native / web
- `callManager.ts`, `callState.ts`, `callkeep.ts` — zarządzanie połączeniami
- `push.ts`, `voipPush.ts`, `fcmBackground.ts` — powiadomienia
- `e2ee.ts` — UI dla E2EE (tweetnacl)
- `i18n/` — tłumaczenia (en, pl, de)

## iOS Native Variant

`IOS/GhostelIOS/` to osobny projekt Expo z natywnymi plikami iOS:

- `ios/Ghostel.xcodeproj/`
- `ios/Ghostel/AppDelegate.swift`
- `ios/Ghostel/Ghostel.entitlements`
- Brak `frontend/ios/` — główny frontend używa prebuildu zarządzanego przez EAS

Ten katalog jest potrzebny do buildów iOS z custom CallKit/VoIP push.

## Komunikacja realtime

1. Klient otwiera WebSocket `/api/ws` z tokenem
2. Backend utrzymuje `WSManager` z mapą `user_id -> connections`
3. Wiadomości, presence, call signaling przechodzą przez WS
4. Fallback: polling 5s dla wiadomości

## Call flow

1. Dzwoniący: `POST /calls/start`
2. Backend wysyła push (FCM/APNs VoIP) do odbiorcy
3. Odbiorca akceptuje: `POST /calls/{id}/accept`
4. WebRTC offer/answer/ICE przez WS lub `POST /calls/{id}/signals`
5. CallKit na iOS zarządza UI natywnym
