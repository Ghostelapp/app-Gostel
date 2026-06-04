/**
 * Platform-aware wrapper around `react-native-incall-manager`.
 *
 * On native (iOS / Android) — returns the real native module which handles:
 *   - Audio routing (speakerphone, earpiece, bluetooth)
 *   - Proximity sensor (turns screen off when phone is at ear)
 *   - Wake lock during active calls
 *   - Audio mode (sets MODE_IN_COMMUNICATION on Android)
 *   - Ringtone / ringback playback (also bypasses media volume)
 *
 * On web — returns a no-op stub so the same code can run.
 */
type InCallManagerAPI = {
  start: (opts?: {
    media?: 'audio' | 'video';
    auto?: boolean;
    ringback?: '' | '_DTMF_' | '_DEFAULT_' | '_BUNDLE_';
  }) => void;
  stop: (opts?: { busytone?: '' | '_DTMF_' | '_DEFAULT_' | '_BUNDLE_' }) => void;
  setKeepScreenOn: (enable: boolean) => void;
  setForceSpeakerphoneOn: (force: boolean | null) => void;
  setSpeakerphoneOn: (enable: boolean) => void;
  setMicrophoneMute: (mute: boolean) => void;
  startRingtone: (
    ringtone: '_DEFAULT_' | '_BUNDLE_',
    vibrate_pattern?: number[],
    ios_category?: string,
    seconds?: number,
  ) => void;
  stopRingtone: () => void;
  startRingback: (ringback: '_DTMF_' | '_DEFAULT_' | '_BUNDLE_') => void;
  stopRingback: () => void;
};

const noopAPI: InCallManagerAPI = {
  start: () => {},
  stop: () => {},
  setKeepScreenOn: () => {},
  setForceSpeakerphoneOn: () => {},
  setSpeakerphoneOn: () => {},
  setMicrophoneMute: () => {},
  startRingtone: () => {},
  stopRingtone: () => {},
  startRingback: () => {},
  stopRingback: () => {},
};

let _cached: InCallManagerAPI | null = null;

export function getInCallManager(): InCallManagerAPI {
  if (_cached) return _cached;
  try {
    // Lazy require so web bundle never resolves the native module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const InCall = require('react-native-incall-manager');
    const mod = InCall?.default ?? InCall;
    if (mod && typeof mod.start === 'function') {
      _cached = mod as InCallManagerAPI;
      return _cached;
    }
  } catch {
    /* ignore — fall through to no-op */
  }
  _cached = noopAPI;
  return _cached;
}
