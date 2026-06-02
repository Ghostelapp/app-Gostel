import { useCallback, useRef } from 'react';
import { Asset } from 'expo-asset';

function resolveAssetUri(source: any): string | null {
  if (typeof source === 'string') return source;
  if (source?.uri) return source.uri;

  try {
    const asset = Asset.fromModule(source);
    return asset.localUri || asset.uri || null;
  } catch {
    return null;
  }
}

export function useCallRingback(source: any, enabled: boolean) {
  const audioRef = useRef<any>(null);
  const playingRef = useRef(false);

  const startRingback = useCallback(() => {
    if (!enabled || playingRef.current || typeof window === 'undefined') return;
    const AudioCtor = (window as any).Audio;
    if (!AudioCtor) return;

    try {
      if (!audioRef.current) {
        const uri = resolveAssetUri(source);
        if (!uri) return;
        const audio = new AudioCtor(uri);
        audio.loop = true;
        audio.volume = 0.8;
        audioRef.current = audio;
      }
      const result = audioRef.current.play();
      playingRef.current = true;
      result?.catch?.(() => {
        playingRef.current = false;
      });
    } catch {
      playingRef.current = false;
    }
  }, [enabled, source]);

  const stopRingback = useCallback(() => {
    if (!audioRef.current) return;
    try {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    } catch {
      /* ignore */
    }
    playingRef.current = false;
  }, []);

  return { startRingback, stopRingback };
}
