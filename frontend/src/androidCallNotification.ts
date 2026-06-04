import { NativeModules, Platform } from 'react-native';

type NativeCallNotification = {
  showIncomingCall?: (data: Record<string, string>) => Promise<boolean>;
  cancelIncomingCall?: (callId: string) => Promise<boolean>;
  consumeInitialIncomingCall?: () => Promise<Record<string, string> | null>;
};

function getModule(): NativeCallNotification | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.GhostelCallNotification || null;
}

export async function showFullScreenIncomingCallNotification(
  data: Record<string, string>,
): Promise<boolean> {
  const mod = getModule();
  if (!mod?.showIncomingCall) return false;
  return Boolean(await mod.showIncomingCall(data));
}

export async function cancelFullScreenIncomingCallNotification(
  callId?: string | null,
): Promise<void> {
  if (!callId) return;
  const mod = getModule();
  if (!mod?.cancelIncomingCall) return;
  await mod.cancelIncomingCall(callId);
}

export async function consumeInitialNativeIncomingCall(): Promise<Record<string, string> | null> {
  const mod = getModule();
  if (!mod?.consumeInitialIncomingCall) return null;
  return mod.consumeInitialIncomingCall();
}
