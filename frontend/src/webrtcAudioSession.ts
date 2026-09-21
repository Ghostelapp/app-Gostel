import { Platform } from 'react-native';

let active = false;
const activationWaiters = new Set<(ready: boolean) => void>();

/** Call only for CallKit's real didActivateAudioSession event (including replay). */
export function activateWebRtcAudioSession(): void {
  if (Platform.OS !== 'ios' || active) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWebRTC } = require('./webrtc');
    const WebRTC = getWebRTC();
    if (!WebRTC?.RTCAudioSession?.audioSessionDidActivate) return;
    WebRTC.RTCAudioSession.audioSessionDidActivate();
    active = true;
    for (const resolve of activationWaiters) resolve(true);
    activationWaiters.clear();
  } catch {
    /* waiters time out if the native bridge is unavailable */
  }
}

export function waitForWebRtcAudioSession(timeoutMs = 10_000): Promise<boolean> {
  if (Platform.OS !== 'ios' || active) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      activationWaiters.delete(finish);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    activationWaiters.add(finish);
  });
}

/** Call only when CallKit deactivates the session. */
export function deactivateWebRtcAudioSession(): void {
  if (Platform.OS !== 'ios' || !active) return;
  active = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWebRTC } = require('./webrtc');
    getWebRTC()?.RTCAudioSession?.audioSessionDidDeactivate?.();
  } catch {
    /* best-effort native teardown */
  }
}
