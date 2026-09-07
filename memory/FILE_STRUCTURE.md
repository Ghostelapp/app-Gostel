# FILE_STRUCTURE.md

## Root

```
app-Gostel/
├── backend/                 # FastAPI backend
│   ├── server.py           # Główny plik aplikacji (~6k linii)
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
│   ├── app.json            # Konfiguracja Expo (wersja 1.4.54)
│   ├── package.json        # Wersja 1.4.53 (NIESPÓJNOŚĆ!)
│   └── .env.example
├── IOS/GhostelIOS/         # Osobny projekt iOS z natywnymi plikami Xcode
│   ├── app/                # Screens (subset frontend/app)
│   ├── ios/                # Natywne pliki iOS
│   ├── src/                # Współdzielone moduły
│   └── package.json        # Wersja 1.4.0 (starsza)
├── memory/                 # Pamięć projektu (dokumentacja agenta)
├── docs/                   # Dokumentacja użytkowa/testerska
├── tests/                  # Wspólne testy (puste __init__.py)
├── scripts/                # Skrypty deploy/test
├── .emergent/              # Konfiguracja Emergent
└── *.md, *.apk, *.aab      # Artefakty deploy (nie w git)
```

## Backend

- `server.py` — monolit zawierający wszystkie endpointy, modele, logikę
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

## IOS/GhostelIOS

Osobny projekt iOS. `app/` zawiera te same screens co `frontend/app/` minus 4 nowsze ekrany ustawień:
- `settings/call-diagnostics.tsx`
- `settings/permissions.tsx`
- `settings/push-devices.tsx`
- `settings/report-problem.tsx`

`ios/` zawiera natywne pliki Xcode wymagane do buildów iOS z CallKit/VoIP.

## Nieśpójności do uporządkowania

1. `frontend/package.json` wersja `1.4.53` vs `frontend/app.json` wersja `1.4.54`
2. `IOS/GhostelIOS/package.json` wersja `1.4.0` — może być nieaktualna
3. Duplikacja kodu między `frontend/` a `IOS/GhostelIOS/`
4. Artefakty buildów (APK/AAB) w root i frontend/
5. Backend jako jeden monolit — trudny w utrzymaniu
