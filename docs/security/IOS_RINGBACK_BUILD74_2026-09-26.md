# Outgoing ringback — build 74

The user confirmed repeated calls worked and audio was correct after build 73, but reported missing outgoing ringback. Production diagnostics on September 26 show four calls reaching connected state on both peers without the earlier E2EE/answer failures.

The existing MP3 has a one-second tone followed by a pause, repeated three times; it is not silent. ExpoAudio pauses its players when the app enters background unless its global background mode is enabled. That global mode also changes audio-session configuration, which should remain under CallKit ownership. This is a concrete playback-lifecycle weakness, but no on-device ringback trace established the sole cause of the report.

On iOS, use a dedicated AVAudioPlayer hosted in the existing CallKeep bridge, using the local bundled asset resolved by Expo Asset. It does not call setActive, setCategory or setMode. Start remains after CallKit activation and local call bootstrap. Stop on answer/connection, cleanup, unmount, or native end action. Native stop compares the call UUID so stale cleanup cannot stop a different call. Pending asset resolution is cancelled logically when the call is answered or ended, preventing a delayed tone during the conversation. Android retains the existing ExpoAudio implementation.

Validation: full local regression passed (38 Python + 42 Node + 9 Rust), including delayed-load cancellation, next-call playback, call-scoped cleanup, and native session-ownership checks. TypeScript and diff checks passed. Device audibility and repeated locked-screen calls must be confirmed on the distributed build; tests cannot establish what the user hears.
