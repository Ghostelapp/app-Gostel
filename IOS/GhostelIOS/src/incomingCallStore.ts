import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, Platform } from 'react-native';

export type IncomingCallPayload = {
  id: string;
  caller_id: string;
  caller_name: string;
  conversation_id: string;
  mode: string;
};

const PENDING_INCOMING_CALL_KEY = 'ghostel_pending_incoming_call_v1';
const INCOMING_CALL_EVENT = 'ghostel:incoming-call';

export function normalizeIncomingCallPayload(data: any): IncomingCallPayload | null {
  if (!data) return null;
  const id = String(data.id || data.call_id || data.message_id || '');
  const caller_id = String(data.caller_id || '');
  const conversation_id = String(data.conversation_id || '');
  if (!id || !caller_id || !conversation_id) return null;
  return {
    id,
    caller_id,
    caller_name: String(data.caller_name || data.sender_name || 'Unknown'),
    conversation_id,
    mode: String(data.mode || 'audio'),
  };
}

export async function savePendingIncomingCall(data: any): Promise<IncomingCallPayload | null> {
  const call = normalizeIncomingCallPayload(data);
  if (!call) return null;
  await AsyncStorage.setItem(PENDING_INCOMING_CALL_KEY, JSON.stringify(call));
  return call;
}

export async function consumePendingIncomingCall(): Promise<IncomingCallPayload | null> {
  const raw = await AsyncStorage.getItem(PENDING_INCOMING_CALL_KEY);
  if (!raw) return null;
  await AsyncStorage.removeItem(PENDING_INCOMING_CALL_KEY);
  try {
    return normalizeIncomingCallPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearPendingIncomingCall(callId?: string): Promise<void> {
  if (!callId) {
    await AsyncStorage.removeItem(PENDING_INCOMING_CALL_KEY);
    return;
  }
  const raw = await AsyncStorage.getItem(PENDING_INCOMING_CALL_KEY);
  if (!raw) return;
  try {
    const current = normalizeIncomingCallPayload(JSON.parse(raw));
    if (current?.id === callId) {
      await AsyncStorage.removeItem(PENDING_INCOMING_CALL_KEY);
    }
  } catch {
    await AsyncStorage.removeItem(PENDING_INCOMING_CALL_KEY);
  }
}

export async function showIncomingCallFromPush(data: any): Promise<IncomingCallPayload | null> {
  const call = await savePendingIncomingCall(data);
  if (call && Platform.OS !== 'web') {
    DeviceEventEmitter.emit(INCOMING_CALL_EVENT, call);
  }
  return call;
}

export function subscribeToIncomingCallEvents(
  handler: (call: IncomingCallPayload) => void,
): () => void {
  if (Platform.OS === 'web') return () => {};
  const sub = DeviceEventEmitter.addListener(INCOMING_CALL_EVENT, handler);
  return () => sub.remove();
}
