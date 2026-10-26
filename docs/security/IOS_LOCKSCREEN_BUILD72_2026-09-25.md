# iOS lock-screen call investigation — build 72

## Production evidence

User reports the same failure on build 71. The latest recorded call at 2026-09-24 22:26 UTC was accepted, then the callee reported `end_reason=Answer failed` roughly 2.4 seconds later. No answer signal was stored and no remote track was attached. The ring timeout was cancelled after acceptance. Existing diagnostics capture a stale empty error message, so they do not establish which operation in the answer handler failed. Build identity was not recorded in those diagnostics; build 71 is based on the user's report.

## Changes

- The installed Expo SecureStore iOS implementation updates only `kSecValueData` for an existing item. Existing JS migrations specifying AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY therefore did not change accessibility. Patch the native update dictionary to apply accessibility for non-biometric items, preserving data and biometric access control. Existing auth/E2EE startup migrations now take effect after opening the updated app while unlocked. This is a concrete defect consistent with locked-only decryption failures, not a device-confirmed root cause yet.
- Record `answer_failed` with the failed stage, bounded error code, storage-unavailable flag and app state. Do not transmit raw exception messages, keys, ciphertext or SDP.
- Production still used VoIP pushes to announce termination. The native PushKit handler reports every such notification as a new incoming call, explaining the briefly returning call screen. Replace only `_send_call_control_push` with the existing locally tested implementation: FCM silent control notifications, no VoIP control pushes, and accepted notifications restricted to other callee sessions. Incoming VoIP call delivery is unchanged.

## Production deployment

One function changed in `/home/ubuntu/apps/app-Gostel/backend/server.py`; backend restarted successfully at 2026-09-24 22:51:03 UTC. API returned HTTP 200. Backup: `/home/ubuntu/ghostel-release-backups/server-before-call-control-20260924T225056Z.py`. Patched file SHA256: `b9c843a69b44550e3bf1b2e785de9728e1a0a33fae8ed23b33442a5819db1ffc`.

Two offline routing tests executed against the actual deployed source passed. Full local regression passed: 38 Python, 40 Node, 9 Rust tests; TypeScript and syntax checks also passed. Node tests include running the real patched Swift update method against a deterministic keychain boundary, checking existing bytes and biometric access remain intact. This is not a physical-device keychain test.

## Outstanding verification

Install build 72 on both phones, open Ghostel once while unlocked to migrate existing items, then repeat locked-screen calls in both directions. Physical-device confirmation remains required. Earlier FCM logs included Invalid APNs credential; subsequent sends succeeded. Firebase-console credential configuration is not verified by these changes.

References: Apple recommends AFTER_FIRST_UNLOCK for background keychain access and network signaling rather than additional VoIP pushes for hangups:
- https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly
- https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit

## Follow-up evidence on September 25

The user clarified that the first locked-screen call succeeded and subsequent attempts failed (a previous test, not a new attempt during this investigation). Production diagnostics show successful connection for call `0ce28cc6` at 23:29:41 UTC on September 24, then callee-side `e2ee_failed` / `E2EE unavailable` for calls `668695ba` and `96286dae` at 23:30:16 and 23:30:28. All three call records require E2EE and contain identical member-key snapshots. This excludes a change in the server call-key snapshots across those three attempts, but does not directly expose the phone's keychain error. The prepared SecureStore migration fix remains relevant. Build 72 archive succeeded and its app signature verified.


Upload numbering: App Store Connect already contained build 72 (uploaded September 24 at 23:23 UTC). Xcode automatically renumbered this archive to **73** during export on September 25. The distributed IPA is `artifacts/testflight/Ghostel-1.4.56-73.ipa`; the local archive remains numbered 72. Use build 73 for the next verification.

Apple accepted build 73: VALID / IN_BETA_TESTING, build ID `2174493a-0764-4abb-aabe-48e47fd72be6`. Upload succeeded; third-party framework dSYM warnings remain.
