/**
 * In-app sound effects.
 *
 * Plays short .wav assets when the app is in the foreground and the user has
 * sounds enabled. Uses `expo-audio` (Expo SDK 54+).
 *
 *  - playSound('message')      → one-shot short tone
 *  - playSound('notification') → one-shot short tone (same family)
 *  - playSound('sent', 0.3)    → very quiet "swoosh" on outgoing message
 *  - startRingtone()           → LOOPS until stopRingtone() is called
 *
 * Audio is routed through the main media speaker (NOT the earpiece), uses the
 * platform RING/MEDIA audio mode, and plays even when the device is in silent
 * mode (incoming calls and messages should still be heard).
 *
 * Settings: AsyncStorage key `ghostel.sounds.enabled` (default = true).
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type SoundKey = 'message' | 'ringtone' | 'notification' | 'sent';

const STORAGE_KEY = 'ghostel.sounds.enabled';

/** Native-only require — bundlers must inline these on iOS/Android only. */
let FILES: Record<SoundKey, any> = {} as any;
try {
  if (Platform.OS !== 'web') {
    FILES = {
      message: require('../assets/audio/message.wav'),
      notification: require('../assets/audio/notification.wav'),
      ringtone: require('../assets/audio/ringtone.wav'),
      // Reuse notification sound for "sent" feedback at very low volume.
      sent: require('../assets/audio/notification.wav'),
    };
  }
} catch {
  /* missing asset — sounds become no-ops */
}

let _enabled = true;
let _hydrated = false;
let _ringtonePlayer: any = null;
let _ringtoneGeneration = 0;
let _audioModeConfigured = false;

export async function hydrateSoundPrefs(): Promise<boolean> {
  if (_hydrated) return _enabled;
  try {
    const v = await AsyncStorage.getItem(STORAGE_KEY);
    if (v === 'false') _enabled = false;
    if (v === 'true') _enabled = true;
  } catch {
    /* default true */
  }
  _hydrated = true;
  return _enabled;
}

export function areSoundsEnabled(): boolean {
  return _enabled;
}

export async function setSoundsEnabled(v: boolean): Promise<void> {
  _enabled = v;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, v ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

/**
 * Ensure expo-audio's audio mode is set so:
 *   - playback goes through the LOUDSPEAKER (not the earpiece)
 *   - playback is heard even in iOS silent mode
 *   - Android stream type is "media/ring" not "voice call"
 *
 * The critical iOS knob is `allowsRecording: false` — when true, AVAudioSession
 * uses the PlayAndRecord category which defaults to routing through the
 * earpiece. With false, it uses the Playback category → main loudspeaker.
 */
async function ensureAudioMode() {
  if (_audioModeConfigured) return;
  if (Platform.OS === 'web') {
    _audioModeConfigured = true;
    return;
  }
  try {
    const Audio: any = await import('expo-audio');
    if (Audio.setAudioModeAsync) {
      await Audio.setAudioModeAsync({
        playsInSilentMode: true,         // iOS: ring even when phone is on silent
        allowsRecording: false,          // iOS: Playback category → speaker (NOT earpiece)
        shouldRouteThroughEarpiece: false, // Android explicit
        interruptionMode: 'doNotMix',    // grab exclusive audio focus
        shouldPlayInBackground: false,
      });
    }
    _audioModeConfigured = true;
  } catch {
    /* swallow — playback will still work, just maybe via earpiece */
  }
}

/**
 * Reset the cached "configured" flag so the next playSound / startRingtone
 * call re-applies the audio mode. Useful when some other library (e.g.
 * react-native-incall-manager during an active call) may have changed the
 * AVAudioSession category and we need to reclaim speaker routing.
 */
export function resetAudioMode(): void {
  _audioModeConfigured = false;
}

/**
 * Play a short, one-shot sound. Returns once the sound has started playing
 * (not when it finishes). Errors are swallowed silently.
 */
export async function playSound(key: SoundKey, volume = 0.6): Promise<void> {
  await hydrateSoundPrefs();
  if (!_enabled) return;
  if (Platform.OS === 'web') return; // browsers block autoplay
  try {
    await ensureAudioMode();
    const Audio: any = await import('expo-audio');
    const asset = FILES[key];
    if (!asset) return;
    const player = Audio.createAudioPlayer(asset);
    try {
      player.volume = volume;
    } catch {
      /* readonly on some platforms */
    }
    player.play();
    setTimeout(() => {
      try {
        player.remove();
      } catch {
        /* ignore */
      }
    }, 3500);
  } catch {
    /* expo-audio not available — silently skip */
  }
}

/**
 * Start an infinitely-looping ringtone for an incoming call. Stops a previous
 * ringtone first (only one can play at a time). Call `stopRingtone()` when the
 * call is accepted, rejected, or times out.
 */
export async function startRingtone(volume = 0.85): Promise<void> {
  const generation = ++_ringtoneGeneration;
  await hydrateSoundPrefs();
  if (!_enabled) return;
  if (Platform.OS === 'web') return;
  await stopRingtone(false); // ensure previous instance is fully torn down
  if (generation !== _ringtoneGeneration) return;
  try {
    await ensureAudioMode();
    if (generation !== _ringtoneGeneration) return;
    const Audio: any = await import('expo-audio');
    const asset = FILES.ringtone;
    if (!asset) return;
    const player = Audio.createAudioPlayer(asset);
    if (generation !== _ringtoneGeneration) {
      player.remove?.();
      return;
    }
    _ringtonePlayer = player;
    try {
      player.loop = true;
    } catch {
      /* some platforms expose this differently */
    }
    try {
      player.volume = volume;
    } catch {
      /* ignore */
    }
    player.play();
  } catch {
    _ringtonePlayer = null;
  }
}

export async function stopRingtone(invalidatePending = true): Promise<void> {
  if (invalidatePending) _ringtoneGeneration += 1;
  const p = _ringtonePlayer;
  _ringtonePlayer = null;
  if (!p) return;
  try {
    p.pause?.();
  } catch {
    /* ignore */
  }
  try {
    p.remove?.();
  } catch {
    /* ignore */
  }
}
