# AUTH_AND_ROLES.md

## System autentykacji

### JWT Access Token

- Algorytm: **HS256**
- Sekret: `JWT_SECRET` z `.env`
- Zawiera: `user_id`, `username`, `role`, `jti`, `exp`
- Przechowywany w: `expo-secure-store` (mobile) / localStorage (web)
- Wysyłany w headerze: `Authorization: Bearer <token>`

### Refresh Sessions

- Osobna kolekcja w MongoDB
- Każda sesja ma unikalny `jti`
- Możliwość wylogowania z pojedynczej sesji lub wszystkich
- Przechowywanie IP i info o urządzeniu

### 2FA TOTP

- Biblioteka: **pyotp**
- Użytkownik może skonfigurować TOTP (`/auth/2fa/setup`)
- Włączyć/wyłączyć 2FA (`/auth/2fa/enable`, `/auth/2fa/disable`)
- Przy logowaniu wymagany kod TOTP jeśli włączony

### Role użytkowników

| Rola | Uprawnienia |
|------|-------------|
| `admin` | Pełny dostęp, panel admina, health, restart |
| `moderator` | Zarządzanie użytkownikami (częściowe) |
| `user` | Standardowy użytkownik |
| `guest` | Ograniczony użytkownik |

### Middleware auth

- `require_user` — wymaga ważnego JWT
- `require_admin` — wymaga roli `admin`
- `require_ws_ticket` — weryfikuje ticket WebSocket

### Autoryzacja endpointów

- Większość endpointów pod `/api/*` wymaga `require_user`
- Endpointy `/api/admin/*` wymagają `require_admin`
- `/app-release.apk` i `/` są publiczne
- WebSocket wymaga ticketu uzyskanego przez `POST /ws-ticket`

### Bezpieczeństwo

- Hasła hashowane bcrypt
- JWT z krótkim czasem życia
- Rate limiting na logowaniu i rejestracji
- CORS skonfigurowany przez `CORS_ORIGINS`
- Brak hardcoded secrets w kodzie (wszystko w `.env`)
