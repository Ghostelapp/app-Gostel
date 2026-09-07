# EXTERNAL_SERVICES.md

## Zewnętrzne usługi używane przez projekt

### Firebase Cloud Messaging (FCM)

**Do czego służy:** Powiadomienia push na Android
**Pliki:**
- `backend/fcm.py`
- `frontend/src/push.ts`
- `frontend/src/fcmBackground.ts`
- `frontend/google-services.json`
**Konfiguracja:** `FCM_SERVICE_ACCOUNT_JSON` lub `FCM_SERVICE_ACCOUNT_PATH`

### Apple Push Notification Service (APNs)

**Do czego służy:** Powiadomienia VoIP i regularne push na iOS
**Pliki:**
- `backend/apns.py`
- `frontend/src/voipPush.ts`
- `IOS/GhostelIOS/ios/Ghostel/AppDelegate.swift`
**Konfiguracja:** Certyfikaty/klucze APNs w `.env`

### MongoDB

**Do czego służy:** Główna baza danych
**Pliki:**
- `backend/server.py` (inicjalizacja Motor client)
**Konfiguracja:** `MONGO_URL`, `DB_NAME`

### S3 (AWS / compatible)

**Do czego służy:** Przechowywanie załączników
**Pliki:**
- `backend/server.py` (endpointy `/uploads`)
- `frontend/src/upload.ts`
**Konfiguracja:** Zmienne AWS/S3 w `.env`

### Expo Application Services (EAS)

**Do czego służy:** Buildy iOS/Android w chmurze
**Pliki:**
- `frontend/eas.json`
- `frontend/app.json`
**Konfiguracja:** `eas.projectId`, konto `coda666`

### TestFlight / App Store Connect

**Do czego służy:** Dystrybucja iOS beta
**Konfiguracja:** `ascAppId: 6781015398`

### Cloudflare TURN (opcjonalnie)

**Do czego służy:** Relay WebRTC dla połączeń między różnymi sieciami
**Pliki:**
- `backend/server.py` (`/calls/ice-servers`)
**Konfiguracja:** `CLOUDFLARE_TURN_APP_ID`, `CLOUDFLARE_TURN_API_TOKEN`

### Stripe

**Do czego służy:** Płatności (obecnie nieaktywne?)
**Pliki:**
- `backend/server.py` (import `stripe`)
**Konfiguracja:** Brak w `.env.example` — do zweryfikowania

### Sentry / Logowanie

**Do czego służy:** Logowanie błędów (brak w kodzie?)
**Status:** Nieznaleziony — aplikacja używa głównie `logging`

## Uwagi

- Nie zapisuj sekretów w repozytorium.
- `google-services.json` i `GoogleService-Info.plist` są w git — sprawdź czy nie zawierają poufnych danych (zazwyczaj zawierają tylko publiczne app IDs).
