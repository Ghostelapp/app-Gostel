import { useCallback, useRef } from 'react';
import { useAudioPlayer } from 'expo-audio';

export function useCallRingback(source: any, enabled: boolean) {
  const player = useAudioPlayer(source);
  const playingRef = useRef(false);

  const startRingback = useCallback(() => {
    if (!enabled || playingRef.current) return;
    try {
      player.loop = true;
      player.volume = 0.8;
      player.play();
      playingRef.current = true;
    } catch {
      /* keep going without ringback */
    }
  }, [enabled, player]);

  const stopRingback = useCallback(() => {
    if (!playingRef.current) return;
    try {
      player.pause();
      player.seekTo(0);
    } catch {
      /* ignore */
    }
    playingRef.current = false;
  }, [player]);

  return { startRingback, stopRingback };
}
