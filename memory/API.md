# API.md

## Endpointy backendu (94 tras API + WebSocket `/ws`)

### Auth

| Method | Path | Auth | Opis |
|--------|------|------|------|
| POST | `/auth/register` | public | Rejestracja |
| POST | `/auth/login` | public | Logowanie |
| GET | `/auth/username-available` | public | Sprawdź username |
| GET | `/auth/me` | JWT | Aktualny użytkownik |
| POST | `/auth/logout` | JWT | Wyloguj |
| GET | `/auth/sessions` | JWT | Lista sesji |
| DELETE | `/auth/sessions/{id}` | JWT | Usuń sesję |
| POST | `/auth/2fa/setup` | JWT | Setup TOTP |
| POST | `/auth/2fa/enable` | JWT | Włącz 2FA |
| POST | `/auth/2fa/disable` | JWT | Wyłącz 2FA |

### Users

| Method | Path | Auth | Opis |
|--------|------|------|------|
| GET | `/users` | JWT | Lista użytkowników |
| GET | `/users/search` | JWT | Wyszukaj użytkownika |
| GET | `/users/{id}` | JWT | Profil użytkownika |
| PATCH | `/users/me` | JWT | Edytuj profil |
| PATCH | `/users/me/avatar` | JWT | Zmień avatar |
| POST | `/users/me/heartbeat` | JWT | Heartbeat presence |
| GET | `/users/me/export` | JWT | Eksport danych |
| DELETE | `/users/me` | JWT | Usuń konto |
| PATCH | `/users/me/status` | JWT | Zmień status |
| POST | `/users/me/mute_user/{id}` | JWT | Wycisz użytkownika |
| DELETE | `/users/me/mute_user/{id}` | JWT | Wyłącz wyciszenie |

### Contacts

| Method | Path | Auth | Opis |
|--------|------|------|------|
| GET | `/contacts` | JWT | Kontakty |
| GET | `/contacts/invitations` | JWT | Zaproszenia |
| POST | `/contacts/invite` | JWT | Zaproś |
| POST | `/contacts/invitations/{id}/accept` | JWT | Akceptuj |
| POST | `/contacts/invitations/{id}/reject` | JWT | Odrzuć |
| DELETE | `/contacts/invitations/{id}` | JWT | Usuń zaproszenie |
| DELETE | `/contacts/{id}` | JWT | Usuń kontakt |

### Conversations

| Method | Path | Auth | Opis |
|--------|------|------|------|
| GET | `/conversations` | JWT | Lista rozmów |
| POST | `/conversations` | JWT | Utwórz rozmowę |
| GET | `/conversations/{id}` | JWT | Szczegóły |
| PATCH | `/conversations/{id}` | JWT | Edytuj |
| DELETE | `/conversations/{id}` | JWT | Usuń |
| POST | `/conversations/{id}/members` | JWT | Dodaj członka |
| DELETE | `/conversations/{id}/members/{id}` | JWT | Usuń członka |
| POST | `/conversations/{id}/admins/{id}` | JWT | Dodaj admina |
| DELETE | `/conversations/{id}/admins/{id}` | JWT | Usuń admina |
| PATCH | `/conversations/{id}/disappearing` | JWT | Ustaw disappearing |
| GET | `/conversations/{id}/messages` | JWT | Wiadomości |

### Messages

| Method | Path | Auth | Opis |
|--------|------|------|------|
| POST | `/messages` | JWT | Wyślij wiadomość |
| POST | `/messages/{id}/open-once` | JWT | Otwórz jednorazowe |
| POST | `/messages/{id}/screenshot` | JWT | Zgłoś screenshot |
| POST | `/messages/{id}/reactions` | JWT | Dodaj reakcję |
| DELETE | `/messages/{id}` | JWT | Usuń wiadomość |

### Calls (24 endpointy)

Kluczowe:

| Method | Path | Auth | Opis |
|--------|------|------|------|
| POST | `/calls/start` | JWT | Rozpocznij połączenie |
| GET | `/calls/active` | JWT | Aktywne połączenia |
| POST | `/calls/{id}/ring` | JWT | Dzwonienie |
| POST | `/calls/{id}/accept` | JWT | Akceptuj |
| POST | `/calls/{id}/reject` | JWT | Odrzuć |
| POST | `/calls/{id}/end` | JWT | Zakończ |
| POST | `/calls/{id}/offer` | JWT | WebRTC offer |
| POST | `/calls/{id}/answer` | JWT | WebRTC answer |
| POST | `/calls/{id}/ice` | JWT | ICE candidate |
| POST | `/calls/{id}/signals` | JWT | Batch signals |
| GET | `/calls/ice-servers` | JWT | ICE/TURN config |

### Push

| Method | Path | Auth | Opis |
|--------|------|------|------|
| GET | `/push/status` | JWT | Status push |
| POST | `/push/register` | JWT | Rejestruj token |
| GET | `/push/devices` | JWT | Urządzenia |
| POST | `/push/unregister` | JWT | Wyrejestruj |
| POST | `/push/diag` | JWT | Diagnostyka |
| POST | `/push/test` | admin | Test push |

### Admin

| Method | Path | Auth | Opis |
|--------|------|------|------|
| GET | `/admin/users` | admin | Lista użytkowników |
| GET | `/admin/stats` | admin | Statystyki |
| PATCH | `/admin/users/{id}/role` | admin | Zmień rolę |
| DELETE | `/admin/users/{id}` | admin | Usuń użytkownika |
| GET | `/admin/health` | admin | Health systemu |
| POST | `/admin/restart` | admin | Restart backendu |

### Inne

| Method | Path | Auth | Opis |
|--------|------|------|------|
| POST | `/uploads` | JWT | Upload załącznika |
| GET | `/uploads/{id}` | JWT | Pobierz załącznik |
| POST | `/e2ee/keys` | JWT | Zapisz klucz publiczny |
| GET | `/e2ee/users/{id}/key` | JWT | Pobierz klucz publiczny |
| POST | `/ws-ticket` | JWT | Ticket dla WebSocket |
| POST | `/support/report` | JWT | Zgłoś problem |
| GET | `/` | public | Health check |
| GET | `/app-release.apk` | public | Download APK |
| HEAD | `/app-release.apk` | public | Metadata APK |

### WebSocket

- `GET /api/ws` — realtime (messages, presence, call signaling)
