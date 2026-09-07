# FEATURES.md

## Mapa funkcji ghostel.app

### 1. Autentykacja

**Status:** działa

- Rejestracja (`POST /auth/register`)
- Logowanie email/username + hasło (`POST /auth/login`)
- JWT access token + sesje refresh
- Wylogowanie z bieżącej lub wszystkich sesji
- 2FA TOTP (setup/enable/disable)
- Sprawdzanie dostępności username

**Frontend:**
- `frontend/app/(auth)/login.tsx`
- `frontend/app/(auth)/register.tsx`
- `frontend/src/auth.tsx`

**Backend:**
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable`
- `GET /auth/me`, `/auth/sessions`
- `DELETE /auth/sessions/{session_id}`

---

### 2. Użytkownicy i profile

**Status:** działa

- Edycja profilu (username, display name, bio, email)
- Avatar (upload + crop)
- Status (online/away/busy/offline)
- Eksport danych użytkownika
- Usuwanie konta
- Wyciszanie użytkowników

**Frontend:**
- `frontend/app/(tabs)/profile.tsx`
- `frontend/app/user/[id].tsx`
- `frontend/src/Avatar.tsx`, `AvatarCropperModal.tsx`

**Backend:**
- `PATCH /users/me`
- `PATCH /users/me/avatar`
- `PATCH /users/me/status`
- `GET /users/me/export`
- `DELETE /users/me`

---

### 3. Kontakty

**Status:** działa

- Lista kontaktów
- Zaproszenia do kontaktów
- Akceptacja/odrzucenie/usunięcie zaproszenia
- Usuwanie kontaktu

**Frontend:**
- `frontend/app/(tabs)/contacts.tsx`

**Backend:**
- `GET /contacts`
- `POST /contacts/invite`
- `POST /contacts/invitations/{id}/accept|reject`
- `DELETE /contacts/invitations/{id}`
- `DELETE /contacts/{user_id}`

---

### 4. Rozmowy (conversations)

**Status:** działa

- Rozmowy 1-1 (tworzone automatycznie z kontaktem)
- Grupy (tworzenie, edycja nazwy/awatara)
- Członkowie i admini grupy
- Wiadomości znikające (disappearing messages)

**Frontend:**
- `frontend/app/(tabs)/chats.tsx`
- `frontend/app/chat/[id].tsx`
- `frontend/app/new-chat.tsx`
- `frontend/app/group-info/[id].tsx`

**Backend:**
- `POST /conversations`
- `GET /conversations`, `/conversations/{id}`
- `PATCH /conversations/{id}`
- `POST /conversations/{id}/members`
- `DELETE /conversations/{id}/members/{user_id}`
- `POST/DELETE /conversations/{id}/admins/{user_id}`
- `PATCH /conversations/{id}/disappearing`

---

### 5. Wiadomości

**Status:** działa

- Tekstowe, głosowe, załączniki
- Reakcje
- Open-once (zdjęcia jednorazowe)
- Screenshot notification
- Wyszukiwanie wiadomości

**Frontend:**
- `frontend/app/chat/[id].tsx`
- `frontend/src/voice.ts`, `upload.ts`

**Backend:**
- `POST /messages`
- `GET /conversations/{id}/messages`
- `POST /messages/{id}/open-once`
- `POST /messages/{id}/screenshot`
- `POST /messages/{id}/reactions`
- `DELETE /messages/{id}`
- `GET /search`

---

### 6. Połączenia głosowe (WebRTC)

**Status:** działa (wymaga natywnych buildów)

- Połączenia 1-1
- CallKit na iOS
- Ringback, dźwięki
- Sygnalizacja przez WS + fallback HTTP
- ICE servers (STUN/TURN/Cloudflare)

**Frontend:**
- `frontend/app/call/[id].tsx`
- `frontend/src/webrtc.ts`, `callManager.ts`, `callState.ts`
- `frontend/src/callkeep.ts`, `IncomingCallProvider.tsx`

**Backend:**
- `POST /calls/start`
- `GET /calls/active`
- `POST /calls/{id}/ring|accept|reject|end`
- `POST /calls/{id}/offer|answer|ice`
- `POST /calls/{id}/signals`
- `GET /calls/ice-servers`

---

### 7. Powiadomienia push

**Status:** działa w natywnych buildach

- FCM dla Android
- APNs VoIP dla iOS (połączenia)
- APNs regular push dla wiadomości
- Rejestracja/dergeistracja tokenów

**Frontend:**
- `frontend/src/push.ts`, `voipPush.ts`, `fcmBackground.ts`

**Backend:**
- `backend/fcm.py`, `backend/apns.py`
- `POST /push/register`, `/push/unregister`
- `GET /push/status`, `/push/devices`

---

### 8. E2EE (UI + backend relay)

**Status:** częściowo działa

- Klucze publiczne użytkowników
- Szyfrowane payloady wiadomości
- Backend tylko przekazuje zaszyfrowane dane

**Frontend:**
- `frontend/src/e2ee.ts`

**Backend:**
- `POST /e2ee/keys`
- `GET /e2ee/users/{user_id}/key`

---

### 9. Panel administracyjny

**Status:** działa

- Stats (użytkownicy, online, wiadomości, 2FA, push)
- Lista użytkowników
- Zmiana roli (admin/moderator/user/guest)
- Usuwanie użytkowników
- Health check systemu
- Restart backendu

**Frontend:**
- `frontend/app/(tabs)/admin.tsx`

**Backend:**
- `GET /admin/users`, `/admin/stats`, `/admin/health`
- `PATCH /admin/users/{id}/role`
- `DELETE /admin/users/{id}`
- `POST /admin/restart`

---

### 10. Ustawienia

**Status:** działa

- Prywatność
- 2FA
- Blokowani użytkownicy
- Powiadomienia push / urządzenia
- Diagnostyka połączeń
- Zgłaszanie problemu
- App lock (PIN)
- Uprawnienia

**Frontend:**
- `frontend/app/settings/*.tsx`
