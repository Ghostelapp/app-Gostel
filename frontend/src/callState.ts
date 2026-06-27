import AsyncStorage from '@react-native-async-storage/async-storage';

export type LocalCallStatus =
  | 'IDLE'
  | 'OUTGOING_RINGING'
  | 'INCOMING_RINGING'
  | 'CONNECTING'
  | 'ACTIVE'
  | 'RECONNECTING'
  | 'ENDED'
  | 'MISSED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'FAILED'
  | 'TIMEOUT';

export type LocalCallState = {
  activeCallId: string;
  callStatus: LocalCallStatus;
  callerId: string;
  calleeId?: string;
  conversationId: string;
  mode: string;
  createdAt?: string;
  expiresAt?: string;
  lastSyncedAt: number;
};

const ACTIVE_CALL_STATE_KEY = 'ghostel_active_call_state_v1';
const RINGING_STALE_STATE_MS = 2 * 60 * 1000;
const ACTIVE_STALE_STATE_MS = 12 * 60 * 60 * 1000;

export function mapBackendCallStatus(status?: string): LocalCallStatus {
  switch (String(status || '').toLowerCase()) {
    case 'ringing':
      return 'INCOMING_RINGING';
    case 'answered':
    case 'connecting':
      return 'CONNECTING';
    case 'active':
      return 'ACTIVE';
    case 'reconnecting':
      return 'RECONNECTING';
    case 'ended':
      return 'ENDED';
    case 'rejected':
    case 'declined':
      return 'DECLINED';
    case 'cancelled':
      return 'CANCELLED';
    case 'missed':
      return 'MISSED';
    case 'timeout':
    case 'timed_out':
      return 'TIMEOUT';
    case 'failed':
      return 'FAILED';
    default:
      return 'IDLE';
  }
}

export function isTerminalCallStatus(status?: string): boolean {
  return [
    'ENDED',
    'MISSED',
    'DECLINED',
    'CANCELLED',
    'FAILED',
    'TIMEOUT',
  ].includes(String(status || '').toUpperCase());
}

export async function saveActiveCallState(state: Omit<LocalCallState, 'lastSyncedAt'>): Promise<void> {
  if (!state.activeCallId) return;
  await AsyncStorage.setItem(
    ACTIVE_CALL_STATE_KEY,
    JSON.stringify({
      ...state,
      lastSyncedAt: Date.now(),
    }),
  );
}

export async function getActiveCallState(): Promise<LocalCallState | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_CALL_STATE_KEY);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as LocalCallState;
    if (!state?.activeCallId || !state?.lastSyncedAt) return null;
    if (isTerminalCallStatus(state.callStatus)) {
      await clearActiveCallState(state.activeCallId);
      return null;
    }
    const staleStateMs = ['INCOMING_RINGING', 'OUTGOING_RINGING'].includes(state.callStatus)
      ? RINGING_STALE_STATE_MS
      : ACTIVE_STALE_STATE_MS;
    if (Date.now() - Number(state.lastSyncedAt) > staleStateMs) {
      await clearActiveCallState(state.activeCallId);
      return null;
    }
    return state;
  } catch {
    await AsyncStorage.removeItem(ACTIVE_CALL_STATE_KEY);
    return null;
  }
}

export async function clearActiveCallState(callId?: string): Promise<void> {
  if (!callId) {
    await AsyncStorage.removeItem(ACTIVE_CALL_STATE_KEY);
    return;
  }
  const current = await getActiveCallState();
  if (!current || current.activeCallId === callId) {
    await AsyncStorage.removeItem(ACTIVE_CALL_STATE_KEY);
  }
}

export function logCallEvent(event: string, data: Record<string, any> = {}): void {
  const safe: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/token|secret|key|sdp|candidate|audio|message/i.test(key)) continue;
    safe[key] = typeof value === 'string' ? value.slice(0, 120) : value;
  }
  console.log(`[call] ${event}`, safe);
}
