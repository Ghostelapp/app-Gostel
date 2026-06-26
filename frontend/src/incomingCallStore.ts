import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, Platform } from 'react-native';
import { saveActiveCallState } from './callState';

export type IncomingCallPayload = {
  id: string;
  caller_id: string;
  caller_name: string;
  conversation_id: string;
  mode: string;
  action?: 'answer' | 'decline' | '';
  received_at?: number;
};

const PENDING_INCOMING_CALL_KEY = 'ghostel_pending_incoming_call_v1';
const LOCALLY_ACCEPTED_CALLS_KEY = 'ghostel_locally_accepted_calls_v1';
const INCOMING_CALL_EVENT = 'ghostel:incoming-call';
const CALL_CONTROL_EVENT = 'ghostel:call-control';
const LOCALLY_ACCEPTED_TTL_MS = 10 * 60 * 1000;

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
    action: ['answer', 'decline'].includes(String(data.action || ''))
      ? data.action
      : '',
    received_at: Number.isFinite(Number(data.received_at))
      ? Number(data.received_at)
      : undefined,
  };
}

export async function savePendingIncomingCall(data: any): Promise<IncomingCallPayload | null> {
  const call = normalizeIncomingCallPayload(data);
  if (!call) return null;
  const storedCall = {
    ...call,
    received_at: call.received_at || Date.now(),
  };
  await AsyncStorage.setItem(PENDING_INCOMING_CALL_KEY, JSON.stringify(storedCall));
  return storedCall;
}

export async function getPendingIncomingCall(): Promise<IncomingCallPayload | null> {
  const raw = await AsyncStorage.getItem(PENDING_INCOMING_CALL_KEY);
  if (!raw) return null;
  try {
    return normalizeIncomingCallPayload(JSON.parse(raw));
  } catch {
    await AsyncStorage.removeItem(PENDING_INCOMING_CALL_KEY);
    return null;
  }
}

export async function consumePendingIncomingCall(): Promise<IncomingCallPayload | null> {
  const call = await getPendingIncomingCall();
  if (!call) return null;
  await AsyncStorage.removeItem(PENDING_INCOMING_CALL_KEY);
  return call;
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
  if (call) {
    await saveActiveCallState({
      activeCallId: call.id,
      callStatus: 'INCOMING_RINGING',
      callerId: call.caller_id,
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: String(data.created_at || data.createdAt || ''),
      expiresAt: String(data.expires_at || data.expiresAt || ''),
    }).catch(() => {});
  }
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

async function getLocallyAcceptedCalls(): Promise<Record<string, number>> {
  const raw = await AsyncStorage.getItem(LOCALLY_ACCEPTED_CALLS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const fresh: Record<string, number> = {};
    for (const [callId, acceptedAt] of Object.entries(parsed)) {
      const ts = Number(acceptedAt);
      if (callId && Number.isFinite(ts) && now - ts <= LOCALLY_ACCEPTED_TTL_MS) {
        fresh[callId] = ts;
      }
    }
    if (Object.keys(fresh).length !== Object.keys(parsed).length) {
      await AsyncStorage.setItem(LOCALLY_ACCEPTED_CALLS_KEY, JSON.stringify(fresh));
    }
    return fresh;
  } catch {
    await AsyncStorage.removeItem(LOCALLY_ACCEPTED_CALLS_KEY);
    return {};
  }
}

export async function markCallLocallyAccepted(callId: string): Promise<void> {
  if (!callId) return;
  const accepted = await getLocallyAcceptedCalls();
  accepted[callId] = Date.now();
  await AsyncStorage.setItem(LOCALLY_ACCEPTED_CALLS_KEY, JSON.stringify(accepted));
}

export async function wasCallLocallyAccepted(callId: string): Promise<boolean> {
  if (!callId) return false;
  const accepted = await getLocallyAcceptedCalls();
  return Boolean(accepted[callId]);
}

export function emitCallControlEvent(data: {
  call_id: string;
  action?: string;
  actor_id?: string;
}): void {
  if (Platform.OS === 'web' || !data.call_id) return;
  DeviceEventEmitter.emit(CALL_CONTROL_EVENT, data);
}

export function subscribeToCallControlEvents(
  handler: (data: { call_id: string; action?: string; actor_id?: string }) => void,
): () => void {
  if (Platform.OS === 'web') return () => {};
  const sub = DeviceEventEmitter.addListener(CALL_CONTROL_EVENT, handler);
  return () => sub.remove();
}
