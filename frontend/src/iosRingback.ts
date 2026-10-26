import { Asset } from 'expo-asset';
import { NativeModules } from 'react-native';

/** A cancelled asset load must never start a tone after the call is answered. */
export function createIosRingback(source: any, callId: string) {
  let generation = 0;
  let requested = false;
  return {
    async start() {
      if (requested) return;
      requested = true;
      const attempt = ++generation;
      try {
        const asset = await Asset.fromModule(source).downloadAsync();
        if (!requested || attempt !== generation) return;
        await NativeModules.RNCallKeep.startGhostelRingback(callId, asset.localUri || asset.uri);
      } catch {
        if (attempt === generation) requested = false;
        console.warn('[call] RINGBACK_START_FAILED');
      }
    },
    stop() {
      requested = false;
      generation += 1;
      NativeModules.RNCallKeep?.stopGhostelRingback?.(callId);
    },
  };
}
