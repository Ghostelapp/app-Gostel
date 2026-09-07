# FILE_STRUCTURE.md

## Root

```
app-Gostel/
├── backend/                 # FastAPI backend
│   ├── server.py           # Główny plik aplikacji (setup, startup, include_router)
│   ├── app/                # Modułowa aplikacja FastAPI
│   │   ├── core/           # config, database, utils, auth
│   │   ├── models.py       # Modele Pydantic
│   │   ├── services/       # logika biznesowa
│   │   └── routes/         # endpointy FastAPI
│   ├── fcm.py              # Firebase Cloud Messaging
│   ├── apns.py             # Apple Push Notification (VoIP)
│   ├── requirements.txt    # Zależności Python
│   ├── .env.example        # Przykładowe zmienne środowiskowe
│   ├── tests/              # Testy pytest
│   └── setup-linux.sh      # Skrypt setupu lokalnego
├── frontend/               # Główna aplikacja Expo
│   ├── app/                # Expo Router screens
│   ├── src/                # Współdzielone moduły
│   ├── assets/             # Obrazy, dźwięki, czcionki
│   ├── android/            # Natywne pliki Android (prebuild)
│   ├── desktop/            # Konfiguracja Electron
│   ├── scripts/            # Skrypty postinstall/patch
│   ├── plugins/            # Własne pluginy Expo
│   ├── public/             # Statyczne pliki web
│   ├── app.json            # Konfiguracja Expo (wersja 1.4.54, build iOS 66 / Android 61)
│   ├── package.json        # Wersja 1.4.54
│   └── .env.example
├── IOS/                    # (usunięty duplikat GhostelIOS/; iOS buildowany z frontend/)
├── memory/                 # Pamięć projektu (dokumentacja agenta)
├── docs/                   # Dokumentacja użytkowa/testerska
├── tests/                  # Wspólne testy (puste __init__.py)
├── scripts/                # Skrypty deploy/test
├── .emergent/              # Konfiguracja Emergent
└── *.md, *.apk, *.aab      # Artefakty deploy (nie w git)
```

## Backend

- `server.py` — konfiguracja FastAPI, startup/shutdown, include_router dla wszystkich tras
- `app/core/config.py` — stałe i zmienne środowiskowe
- `app/core/database.py` — klient MongoDB
- `app/core/utils.py` — helpery ogólne
- `app/core/auth.py` — autentykacja JWT, sesje, role
- `app/models.py` — modele Pydantic (wejścia API)
- `app/services/push.py` — FCM/APNs, tokeny, powiadomienia
- `app/services/calls.py` — WebRTC, ICE/TURN, sygnalizacja połączeń
- `app/services/websocket.py` — WSManager, WebSocket, ws-ticket
- `app/services/users.py` — użytkownicy, kontakty, blokowanie
- `app/services/admin.py` — helpery panelu admina
- `app/services/conversations.py` — konwersacje i wiadomości
- `app/routes/*.py` — grupy endpointów FastAPI
- `fcm.py` — inicjalizacja Firebase, wysyłka powiadomień
- `apns.py` — inicjalizacja APNs, VoIP push
- `tests/` — 8 plików testowych pytest

## Frontend app/ (routing)

- `(auth)/` — ekrany logowania/rejestracji
- `(tabs)/` — główne zakładki: admin, calls, chats, contacts, profile
- `call/[id].tsx` — ekran połączenia
- `chat/[id].tsx` — ekran czatu
- `settings/` — ekrany ustawień
- `user/[id].tsx` — profil użytkownika
- `new-chat.tsx` — tworzenie nowej rozmowy
- `group-info/[id].tsx` — info o grupie

## Frontend src/

- `api.ts` — axios client
- `auth.tsx` — kontekst autentykacji
- `ws.ts` — WebSocket
- `webrtc.ts` / `webrtc.web.ts` — WebRTC
- `callManager.ts`, `callState.ts`, `callkeep.ts` — połączenia
- `push.ts`, `voipPush.ts`, `fcmBackground.ts` — push
- `e2ee.ts` — E2EE
- `i18n/` — tłumaczenia
- `tokenStorage.ts`, `pinLock.tsx`, `theme.ts` — utils

## iOS

Buildy iOS są robione z głównego projektu `frontend/` (EAS). Natywne pliki iOS znajdują się w `frontend/ios/` i zawierają konfigurację CallKit/VoIP.

## Nieśpójności do uporządkowania

1. `frontend/package.json` wersja `1.4.53` vs `frontend/app.json` wersja `1.4.54`
2. `IOS/GhostelIOS/package.json` wersja `1.4.0` — może być nieaktualna
3. Duplikacja kodu między `frontend/` a `IOS/GhostelIOS/`
4. Artefakty buildów (APK/AAB) w root i frontend/
5. Backend jako jeden monolit — trudny w utrzymaniu
