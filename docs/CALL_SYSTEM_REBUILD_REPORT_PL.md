# Ghostel - raport przebudowy systemu polaczen

Branch: `fix/rebuild-calling-system`

## 1. Audyt obecnego systemu

Znalezione elementy systemu polaczen:

- Backend: `/calls/start`, `/calls/{id}/ring`, `/accept`, `/decline`, `/cancel`, `/end`, `/timeout`, `/signals`, `/status`, `/active`, wysylka APNs/FCM i WebSocket events.
- iOS/React Native: `src/callkeep.ts`, `src/voipPush.ts`, plugin `plugins/withIosVoipPush.js`, CallKit przez `react-native-callkeep`, tryby tla `voip`, `audio`, `remote-notification`.
- Android native: `GhostelFirebaseMessagingService.kt`, `GhostelCallNotificationModule.kt`, `GhostelActiveCallService.kt`, full-screen notification, foreground service, FCM data messages.
- UI i recovery: `src/IncomingCallProvider.tsx`, `src/callManager.ts`, `src/callState.ts`, ekran WebRTC `app/call/[id].tsx`.
- WebRTC: `react-native-webrtc`, DTLS-SRTP, szyfrowany signaling E2EE w `src/e2ee.ts`.

Glowne problemy:

- Po odblokowaniu telefonu PIN/lock overlay mogl przykryc UI polaczenia, zanim aplikacja zsynchronizowala stan z backendem.
- `/calls/active` odcinal aktywne polaczenia starsze niz 5 minut, wiec resume/unlock mogl nie znalezc trwajacego calla.
- Backend pozostawial status `answered`, mimo ze WebRTC bylo juz polaczone. Klient po resume widzial wtedy `CONNECTING`, nie `ACTIVE`.
- Android przy `accepted` nie zatrzymywal foreground service na innych urzadzeniach tego samego konta.
- Statusy `rejected/declined` byly niespojnie nazywane.
- Push payload i logi mogly zawierac nazwe rozmowcy albo prefiksy tokenow.

## 2. Co zostalo odlaczone lub zastapione

- Odlaczono logike, w ktorej resume/unlock opieral sie tylko na lokalnym stanie UI.
- Zastapiono ja REST sync przez globalny `CallManager` jako pierwszym krokiem po foreground/resume.
- Odlaczono zachowanie, w ktorym `accepted` push zostawial ringing foreground service na innych urzadzeniach.
- Zmieniono backendowe `rejected` na docelowe `declined`; klient nadal rozpoznaje stare `rejected` dla kompatybilnosci.
- Usunieto prywatne dane z call push/logow: brak plaintext nazwy rozmowcy w payloadach call, brak prefiksow tokenow w logach.

Nie usuwano logowania, wiadomosci, kontaktow, profili, E2EE wiadomosci ani rejestracji push tokenow, bo sa wspoldzielone z innymi funkcjami.

## 3. Nowa architektura

`frontend/src/callManager.ts` jest centralnym zrodlem prawdy po stronie aplikacji. Przechowuje:

- `activeCallId`
- `callStatus`
- `callerId`, `calleeId`, `conversationId`
- `createdAt`, `expiresAt`, `answeredAt`, `endedAt`
- `isIncoming`
- `isCallUiVisible`
- `isNativeCallUiActive`
- `lastSyncAt`
- `peerConnectionState`
- `localAudioEnabled`
- `remoteAudioConnected`

CallManager obsluguje:

- start polaczenia wychodzacego z idempotentnym `call_id`,
- incoming invite z WebSocket/push,
- duplicate push/socket dla tego samego `callId`,
- foreground/background,
- sync po unlock/resume przez `/calls/active`,
- restore incoming UI,
- restore active call screen,
- clear terminal state.

## 4. Backend jako source of truth

Rozszerzono backend o:

- idempotency key w `POST /calls/start` przez `call_id`,
- deduplikacje aktywnego polaczenia w tej samej rozmowie,
- nowe pola: `callId`, `conversationId`, `callerId`, `calleeId`, `callType`, `createdAt`, `expiresAt`, `answeredAt`, `endedAt`, `lastUpdatedAt`, `callerDeviceId`, `calleeDeviceId`, `platform`, `pushSentAt`, `lastKnownClientState`,
- `POST /calls/{call_id}/state` do synchronizacji stanu klienta,
- aliasy signalingu: `/offer`, `/answer`, `/ice-candidate`,
- idempotentne zachowanie dla terminalnych `accept/end/timeout`,
- `/calls/active` bez sztucznego odcinania aktywnej rozmowy po 5 minutach.

WebSocket events pozostaja zgodne z obecnym klientem, a nowe/uzupelnione eventy zawieraja takze pola `event`, np. `call.accepted`, `call.state_sync`, `call.timeout`.

## 5. iOS

Zachowane i wzmocnione elementy:

- PushKit/VoIP payload przez `backend/apns.py`,
- CallKit przez `src/callkeep.ts`,
- audio session przez `src/webrtcAudioSession.ts`,
- restore po `AppState active` przez `CallManager.handleAppForeground`.

Naprawa unlock/resume:

- transient `CXEndCallAction` po przejsciu lock screen -> aktywna aplikacja nie konczy juz rozmowy, jezeli call zostal odebrany,
- po foreground wykonywany jest REST sync przed poleganiem na WebSocket,
- PIN lock jest omijany tylko gdy lokalny non-terminal call state wymaga natychmiastowego odtworzenia UI.

## 6. Android

Zachowane i wzmocnione elementy:

- FCM high-priority data message,
- foreground service `GhostelActiveCallService`,
- full-screen call notification,
- notification channel `calls`,
- akcje Accept/Decline,
- `Activity.onResume` -> `CallManager.handleAppForeground`.

Naprawa multi-device:

- `accepted` control push zatrzymuje notification/foreground service na pozostalych urzadzeniach,
- tylko lokalnie odebrane urzadzenie nie sprzata swojego aktywnego call UI po `accepted`.

## 7. WebRTC i E2EE

- Media ida przez WebRTC DTLS-SRTP.
- Backend nie dostaje plaintext audio.
- `/offer`, `/answer`, `/ice-candidate` wymagaja `encrypted=true` i `e2ee_signal`.
- Backend usuwa pola `sdp` i `candidate` przed zapisem fallback signalingu.
- Ekran rozmowy raportuje do backendu status `active/reconnecting` przez `/calls/{id}/state`.
- Dodano bezpieczne logi: `WEBRTC_PEER_CONNECTION_CREATED`, `WEBRTC_ICE_STATE_CHANGED`, `WEBRTC_CONNECTED`, `WEBRTC_FAILED`, `CALL_ENDED_CLEANUP`.

## 8. Prywatnosc i bezpieczenstwo

- Call push zawiera minimalne metadane: `type`, `call_id`, `caller_id`, `conversation_id`, `mode`, `expires_at` oraz opcjonalne `encryptedDisplayName`.
- Usunieto plaintext nazwy rozmowcy z payloadu call push.
- Usunieto prefiksy tokenow APNs/FCM z logow backendu.
- Logi klienta filtrują pola zawierajace `token`, `secret`, `key`, `sdp`, `candidate`, `audio`, `message`.

## 9. Testy wykonane lokalnie

- `python -m py_compile backend/server.py backend/apns.py backend/tests/test_apns_voip.py backend/tests/test_iter2_features.py`
- `npx tsc --noEmit` w `frontend`
- `pytest backend/tests/test_apns_voip.py backend/tests/test_fcm_payloads.py -q`

Nie wykonano testu na prawdziwych urzadzeniach w tym srodowisku. Ten test wymaga fizycznego iPhone'a, Androida, aktywnego APNs/FCM oraz buildow TestFlight/APK.

## 10. Manualny test buga unlock

1. Zainstaluj najnowszy build na Androidzie i iOS.
2. Zaloguj kazde konto tylko na jednym aktywnym telefonie albo sprawdz `/push/devices`, czy stary telefon zostal wyrejestrowany.
3. Zablokuj telefon odbiorcy kodem.
4. Wykonaj incoming call z drugiego telefonu.
5. Nie otwieraj aplikacji recznie. Odblokuj telefon kodem.
6. Oczekiwany wynik: ekran polaczenia nadal jest widoczny.
7. Odbierz z lock screen/full-screen UI.
8. Oczekiwany wynik: rozmowa przechodzi `CONNECTING -> ACTIVE`, drugi telefon przestaje dzwonic.
9. W logach szukaj: `CALL_STATE_SYNC_START`, `ACTIVE_CALL_FOUND_AFTER_UNLOCK`, `RESTORE_INCOMING_CALL_UI` albo `RESTORE_ACTIVE_CALL_UI`, `WEBRTC_CONNECTED`.

## 11. Ryzyka pozostale

- Pelny test produkcyjny wymaga buildow na fizycznych urzadzeniach.
- Jezeli APNs VoIP/PushKit entitlements sa zle ustawione w Apple Developer lub profilu EAS, iOS nie pokaze poprawnie CallKit po ubiciu aplikacji.
- Jezeli TURN credentials sa niewazne, WebRTC moze dojsc tylko do `checking/failed`; logi `WEBRTC_ICE_STATE_CHANGED` i diagnostyka `/calls/{id}/diag` pokaza ten przypadek.
