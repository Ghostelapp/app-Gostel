# ghostel.app — PRD

## Iteration 4 (Current) — Admin panel + Voice fix + Real logo

### Delivered
- **Admin panel** (`/admin` tab, admin role only)
  - Stats strip: total users, online, messages, 2FA enabled, push-ready.
  - Users list with role / 2FA / push badges; change role inline (admin/moderator/user/guest); soft-delete account (cannot self-delete / self-demote; deleting a user also pulls them from every conversation's `member_ids`).
  - Non-admins see a polite "Admin access required" lock screen; tab itself is hidden via `href: null`.
- **Voice recording** rewritten on top of **`expo-audio`** (SDK 54 supported API; replaces deprecated `expo-av.Audio.Recording` that was silently failing on iOS Expo Go).
- **Logo swap** — login screen renders the real `ghostel.app.jpg` via `<Image>` on iOS/Android and falls back to the cyan-shield circle on web (avoids react-native-web Image-constructor crash).
- **demo@ghostel.app** seeded automatically (`Demo@2026!`).

## Iteration 3 — Rebrand + reliability
Silentel → **ghostel.app** across app.json (name/slug/icon/splash/bundle), backend (`ghostel_db`, `admin@ghostel.app`), every screen. 5-second polling fallback merges with WebSocket so reconnect gaps no longer lose messages.

## Iteration 2 — File + voice + calls + push
Uploads, voice messages, WebRTC voice calls (signaling), Expo Push pipeline (works only in EAS dev builds — Expo Go ≥ SDK 53 doesn't support remote push).

## Iteration 1 — MVP
JWT + TOTP 2FA, 1-on-1 and group chats, reactions, search, presence.

## Test Coverage
- Backend: **52 pytest cases** (auth, conv, msg, uploads, push, calls, WS, admin) — all green.
- Frontend: tabs, admin gating, login, chat composer, call screen, 2FA flow — all verified.

## Known Constraints
- Push banners require an EAS dev build (Emergent publish button) — Expo Go cannot deliver remote push since SDK 53.
- Native WebRTC voice requires `react-native-webrtc` (dev build only).
- True per-device Signal-protocol E2EE is not yet implemented (UI flags messages encrypted; TLS in transit + AES at rest).

## Roadmap
- Multi-tenancy (workspaces, white-label, audit log, SSO) — biggest remaining lift.
- Native dev build via Emergent publish button to unlock push + native WebRTC + real audio recorder testing.


## Iteration 3 (Current) — Rebrand + Reliability fixes

### Delivered
- **Rebrand to ghostel.app** — app name, splash, login screen, app.json (icon, splash, slug, bundle ID), backend (DB name `ghostel_db`, default admin `admin@ghostel.app`, log lines).
- **Voice recording resilience** — web `MediaRecorder` now picks a browser-supported MIME type (opus → webm → mp4 → ogg fallback chain); helpful errors surfaced to the user; native `expo-av` path wraps every step in a try/catch with descriptive messages.
- **Real-time messaging fallback** — chat screen now combines WebSocket push with a 5-second polling refresh that merges by message ID. WebSocket reconnect gaps no longer cause missed messages.
- **Push noise removed** — `expo-notifications` registration now silently no-ops in Expo Go (where remote push was removed in SDK 53) and when no EAS project ID is configured. To actually receive push banners, build with EAS Build (Emergent publish button).

### Iteration 2
- File uploads + voice messages + WebRTC calls + push notifications pipeline (see prior PRD).

### Iteration 1
- JWT + TOTP 2FA auth, 1-on-1 and group chats, reactions, search, presence.

## Architecture
- FastAPI + Motor + WebSocket (`/api/ws`) + Expo Push HTTP fan-out.
- Expo Router + AsyncStorage JWT + axios; polling + WebSocket dual-channel for messages.

## Test Coverage (current)
- Backend: 32 / 32 pytest cases (auth, uploads, push, calls, WebSocket, signaling). All green.
- Frontend: login screen verified after rebrand on web preview.

## Known Constraints
- Expo Go (SDK 53+) does not support remote push notifications — use an EAS dev build to enable banners on real devices.
- Native voice calls require a development build with `react-native-webrtc`.
- True per-device Signal-protocol E2EE not yet implemented (UI flags messages as encrypted).


## Iteration 2 (Current Release) — File + Voice + Calls + Push

### Newly Delivered
- **File attachments** (images & documents up to 8 MB) — base64 in MongoDB `attachments` collection; rich image preview, file-card bubble, encrypted indicator.
- **Voice messages** — hold-to-record using browser MediaRecorder (web) / `expo-av` (native); animated waveform bubble + play/pause; duration shown.
- **WebRTC voice calls** — backend WebSocket signaling (`/api/ws`), `/api/calls/start` + `/end` endpoints; outgoing/incoming Call screen with mute & end; global `IncomingCallProvider` shows an accept/reject modal anywhere in the app.
- **Expo Push Notifications** — frontend registers Expo push token after login; backend stores per-user token and pushes title/preview on every new message and incoming call.
- **Live messaging** — message-list updates instantly through the WebSocket (no more 4 s polling).
- **Security hardening** — push fan-out now filters by conversation members only; `POST /calls/{id}/end` rejects non-participants.

### Iteration 1 (MVP)
- JWT auth (email + bcrypt) with optional TOTP 2FA.
- 1-on-1 and group chats, emoji reactions, message search, read receipts, presence.
- Expo Router tabs (Chats / Contacts / Calls / Profile), 2FA settings screen.
- Admin + demo users seeded; AsyncStorage-based Bearer auth.

## Architecture
- **Backend**: FastAPI + Motor (MongoDB). UUID IDs. Indexes on users, conversations, messages, attachments, calls. Singleton WebSocket manager dispatches per-user broadcasts. Expo Push delivered via `httpx.AsyncClient` to `https://exp.host/--/api/v2/push/send`.
- **Frontend**: Expo Router, AsyncStorage JWT, axios with interceptor, `useWebSocket` hook with auto-reconnect, platform-aware voice recorder & WebRTC peer connection.

## Test Coverage
- **Backend**: 32 / 32 pytest cases pass (iter 1: 18, iter 2: 14).
- **Frontend**: all key flows verified by automated testing agent on web preview (login, chat list, send/react, attach modal, voice button visibility, call screen routing).

## Known Constraints (Not Bugs)
- Native voice calls require a development build with `react-native-webrtc`; Expo Go can only run the web preview path for true audio.
- Push notifications require a real device + Expo project; web preview won't show the banner.
- True per-device Signal-protocol E2EE is not implemented — TLS in transit + AES at rest + encrypted flag in UI.

## Out of Scope / Roadmap
- File uploads via S3/MinIO (replace base64 storage above ~2 MB).
- HD video calls (mediasoup SFU), screen sharing.
- Multi-tenancy + admin panel + audit log + SSO (SAML 2.0, OIDC).
- Brute-force lockout, CORS hardening, FastAPI lifespan migration.

## Business Enhancement
Per-seat SaaS pricing tied to Voice add-on: chat free, Voice & HD Video at $9/user/mo. Admin dashboard manages seats, audit, and white-label. Converts the security pitch into recurring revenue while keeping chat as DAU driver.
