# DATABASE.md

## Baza danych

**Engine:** MongoDB (AsyncIOMotorClient)
**Nazwa bazy:** `ghostel` (z `.env` `DB_NAME`)

## Kolekcje (wnioskowane z kodu backendu)

### `users`

Główna kolekcja użytkowników.

Pola kluczowe:
- `_id` — ObjectId
- `username` — unikalny, indeksowany
- `email` — unikalny
- `password_hash` — bcrypt
- `role` — `admin`, `moderator`, `user`, `guest`
- `display_name`, `bio`, `avatar_url`
- `status` — online/away/busy/offline
- `last_seen_at`, `created_at`, `updated_at`
- `totp_secret` — dla 2FA
- `two_factor_enabled` — bool
- `push_tokens` — lista tokenów FCM/APNs
- `push_devices` — lista urządzeń
- `e2ee_public_key` — klucz publiczny E2EE
- `muted_user_ids` — wyciszeni użytkownicy
- `deleted_at` — soft delete

### `conversations`

Rozmowy 1-1 i grupowe.

Pola kluczowe:
- `_id`
- `type` — `direct` lub `group`
- `title`, `avatar_url`
- `member_ids` — lista user_id
- `admin_ids` — lista adminów grupy
- `created_by`
- `disappearing_seconds` — czas samozniszczenia
- `last_message_at`, `last_message_preview`
- `created_at`, `updated_at`

### `messages`

Wiadomości.

Pola kluczowe:
- `_id`
- `conversation_id`
- `sender_id`
- `type` — `text`, `voice`, `image`, `file`, `system`
- `content` lub `encrypted_payload`
- `attachment_id`
- `reactions` — mapa user_id → emoji
- `open_once` — bool
- `opened_by` — lista
- `screenshot_by` — lista
- `deleted_at` — soft delete
- `created_at`

### `contacts`

Relacje kontaktów.

Pola kluczowe:
- `_id`
- `user_id`, `contact_id`
- `status` — `accepted`, `pending`
- `created_at`

### `contact_invitations`

Zaproszenia do kontaktów.

Pola kluczowe:
- `_id`
- `from_user_id`, `to_user_id`
- `status` — `pending`, `accepted`, `rejected`
- `created_at`, `responded_at`

### `sessions` / `refresh_sessions`

Sesje refresh tokenów.

Pola kluczowe:
- `_id`
- `user_id`
- `jti` — JWT ID
- `token_hash`
- `device_info`, `ip_address`
- `created_at`, `expires_at`, `revoked_at`

### `uploads` / `attachments`

Metadane załączników.

Pola kluczowe:
- `_id`
- `user_id`
- `conversation_id`
- `filename`, `content_type`, `size`
- `s3_key`, `s3_url`
- `created_at`

### `calls`

Aktywne i historyczne połączenia.

Pola kluczowe:
- `_id`
- `caller_id`, `callee_id`
- `status` — `ringing`, `connecting`, `active`, `ended`, `rejected`, `missed`
- `started_at`, `answered_at`, `ended_at`
- `offer`, `answer`
- `ice_candidates`

### `support_reports`

Zgłoszenia problemów.

Pola kluczowe:
- `_id`
- `user_id`
- `category` — `call`, `push`, `device`, `account`, `bug`, `other`
- `message`
- `created_at`

## Relacje

- `users` ↔ `conversations` via `member_ids`
- `users` ↔ `messages` via `sender_id`
- `users` ↔ `contacts` via `user_id` / `contact_id`
- `conversations` ↔ `messages` via `conversation_id`
- `calls` ↔ `users` via `caller_id` / `callee_id`

## Indeksy (wnioskowane)

- `users.username` — unikalny
- `users.email` — unikalny
- `conversations.member_ids` — dla wyszukiwania rozmów użytkownika
- `messages.conversation_id` + `messages.created_at` — dla paginacji
- `calls.caller_id`, `calls.callee_id`, `calls.status` — dla aktywnych połączeń
