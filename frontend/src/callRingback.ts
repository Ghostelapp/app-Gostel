import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { useAudioPlayer } from 'expo-audio';
import { createIosRingback } from './iosRingback';

export function useCallRingback(source: any, enabled: boolean, callId: string) {
  // Pausing ExpoAudio otherwise deactivates AVAudioSession after 100 ms,
  // including the session CallKit just activated for the answered call.
  const player = useAudioPlayer(Platform.OS === 'ios' ? null : source, { keepAudioSessionActive: Platform.OS === 'ios' });
  const iosRingback = useMemo(() => createIosRingback(source, callId), [source, callId]);
  useEffect(() => () => { if (Platform.OS === 'ios') iosRingback.stop(); }, [iosRingback]);
  const playingRef = useRef(false);

  const startRingback = useCallback(() => {
    if (!enabled || playingRef.current) return;
    if (Platform.OS === 'ios') {
      void iosRingback.start();
      return;
    }
    try {
      player.loop = true;
      player.volume = 0.8;
      player.play();
      playingRef.current = true;
    } catch {
      /* keep going without ringback */
    }
  }, [enabled, player, iosRingback]);

  const stopRingback = useCallback(() => {
    if (Platform.OS === 'ios') {
      iosRingback.stop();
      return;
    }
    if (!playingRef.current) return;
    try {
      player.pause();
      player.seekTo(0);
    } catch {
      /* ignore */
    }
    playingRef.current = false;
  }, [player, iosRingback]);

  return { startRingback, stopRingback };
}
