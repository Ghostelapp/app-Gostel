import { Platform } from 'react-native';

export function activateWebRtcAudioSession(): void {
  if (Platform.OS !== 'ios') return;
  try {
    // react-native-webrtc requires this when CallKit owns AVAudioSession.
    // Without it, WebRTC tracks can stay live while iOS routes no audible audio.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWebRTC } = require('./webrtc');
    const WebRTC = getWebRTC();
    WebRTC?.RTCAudioSession?.audioSessionDidActivate?.();
  } catch {
    /* best-effort iOS audio bridge */
  }
}

export function deactivateWebRtcAudioSession(): void {
  if (Platform.OS !== 'ios') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWebRTC } = require('./webrtc');
    const WebRTC = getWebRTC();
    WebRTC?.RTCAudioSession?.audioSessionDidDeactivate?.();
  } catch {
    /* best-effort iOS audio bridge */
  }
}
