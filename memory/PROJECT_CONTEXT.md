# PROJECT_CONTEXT.md

## Czym jest ghostel.app

ghostel.app to mobilna/webowa aplikacja komunikacyjna z szyfrowanymi wiadomościami, rozmowami głosowymi (WebRTC), kontaktami, grupami, powiadomieniami push (FCM/APNs) oraz panelem administracyjnym.

## Problem, który rozwiązuje

Prywatna komunikacja tekstowa i głosowa z naciskiem na bezpieczeństwo, obecność (presence) i zarządzanie użytkownikami przez administratora.

## Technologie

### Backend
- **FastAPI** (Python 3.12+)
- **MongoDB** (motor + pymongo)
- **JWT** + **bcrypt** + **pyotp** (2FA TOTP)
- **Uvicorn** + **WebSockets** (`/api/ws`)
- **FCM** (Firebase Cloud Messaging) + **APNs VoIP** (iOS)
- **S3** (boto3) do przechowywania załączników
- **Stripe** (płatności, obecnie nieaktywne?)

### Frontend
- **Expo SDK 54** + **React Native 0.81.5**
- **React 19.1.0**
- **TypeScript**
- **expo-router** (file-based routing)
- **react-native-webrtc**, **react-native-callkeep**, **react-native-incall-manager**
- **axios**, **i18next**, **tweetnacl** (E2EE UI)
- **Electron** (desktop build)

### Infrastruktura
- VPS: `194.110.4.129:2022` (Ubuntu)
- Domeny: `ghostel.app`, `api.ghostel.app`
- EAS Build (Expo Application Services)
- TestFlight (iOS)

## Najważniejsze katalogi

- `backend/` — FastAPI backend, głównie `server.py` (monolit ~6k linii)
- `frontend/` — główna aplikacja Expo (Android/iOS/Web/Desktop)
- `IOS/GhostelIOS/` — osobny projekt iOS z natywnymi plikami Xcode (CallKit/VoIP push)
- `backend/tests/` — testy pytest
- `memory/` — pamięć projektu (ten katalog)
- `docs/` — dokumentacja użytkowa/testerska

## Aktualny stan (wrzesień 2026)

- Wersja aplikacji: **1.4.54**
- iOS build: **66** (TestFlight)
- Android build: **61** (preview/APK)
- Backend: wdrożony na VPS, działa `ghostel-app.service`
- Strona: `GhostelAPPweb` (osobne repo), deklaruje wersję 1.4.54

## Krytyczne funkcje

1. Auth (JWT + 2FA TOTP)
2. Rozmowy 1-1 i grupowe
3. Wiadomości tekstowe, głosowe, załączniki
4. Połączenia głosowe WebRTC z CallKit (iOS)
5. Powiadomienia push FCM/APNs
6. Panel admina (stats, users, role, health, restart)
7. E2EE UI (klucze publiczne, szyfrowane wiadomości — backend przekazuje payload)
