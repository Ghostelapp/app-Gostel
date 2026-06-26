import { NativeModules, Platform } from 'react-native';

type NativeCallNotification = {
  showIncomingCall?: (data: Record<string, string>) => Promise<boolean>;
  cancelIncomingCall?: (callId: string) => Promise<boolean>;
  consumeInitialIncomingCall?: () => Promise<Record<string, string> | null>;
  getCapabilities?: () => Promise<AndroidCallCapabilities>;
  openSettings?: (kind: AndroidSettingsKind) => Promise<boolean>;
  startActiveCall?: (callId: string, peerName: string) => Promise<boolean>;
  stopActiveCall?: () => Promise<boolean>;
  consumeResumeEvent?: () => Promise<Record<string, string | boolean | number> | null>;
};

export type AndroidCallCapabilities = {
  notificationsEnabled: boolean;
  fullScreenIntentAllowed: boolean;
  batteryUnrestricted: boolean;
};

export type AndroidSettingsKind =
  | 'app'
  | 'fullScreen'
  | 'callChannel'
  | 'battery';

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

export async function consumeAndroidResumeEvent(): Promise<Record<string, string | boolean | number> | null> {
  const mod = getModule();
  if (!mod?.consumeResumeEvent) return null;
  return mod.consumeResumeEvent();
}

export async function getAndroidCallCapabilities(): Promise<AndroidCallCapabilities | null> {
  const mod = getModule();
  if (!mod?.getCapabilities) return null;
  return mod.getCapabilities();
}

export async function openAndroidSettings(kind: AndroidSettingsKind): Promise<boolean> {
  const mod = getModule();
  if (!mod?.openSettings) return false;
  return Boolean(await mod.openSettings(kind));
}

export async function startActiveCallService(callId: string, peerName: string): Promise<void> {
  const mod = getModule();
  if (!mod?.startActiveCall) return;
  await mod.startActiveCall(callId, peerName);
}

export async function stopActiveCallService(): Promise<void> {
  const mod = getModule();
  if (!mod?.stopActiveCall) return;
  await mod.stopActiveCall();
}
