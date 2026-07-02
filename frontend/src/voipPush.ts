import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { endIncomingCallNative, hydrateIncomingCallNative } from './callkeep';
import { api } from './api';
import {
  cacheTerminatedCallId,
  clearActiveCallState,
  getCachedTerminatedCallStatus,
  isTerminalCallStatus,
  logCallEvent,
  mapBackendCallStatus,
} from './callState';
import {
  clearPendingIncomingCall,
  emitCallControlEvent,
  normalizeIncomingCallPayload,
  showIncomingCallFromPush,
  wasCallLocallyAccepted,
} from './incomingCallStore';

const VOIP_TOKEN_STORAGE_KEY = 'ghostel_voip_push_token_v1';
let initialized = false;

export function shouldPreserveAcceptedCallControlState(
  action: string,
  locallyAccepted: boolean,
): boolean {
  return String(action || '').toLowerCase() === 'accepted' && locallyAccepted;
}

async function rememberVoipToken(token: unknown): Promise<void> {
  const normalized = String(token || '').trim();
  if (!normalized) return;
  await AsyncStorage.setItem(VOIP_TOKEN_STORAGE_KEY, normalized);
}

async function handleVoipNotification(notification: any): Promise<void> {
  const controlCallId = String(notification?.call_id || notification?.uuid || '');
  const controlAction = String(
    notification?.call_control_action || notification?.status || '',
  );
  if (notification?.type === 'call_control' || controlAction) {
    if (!controlCallId) return;
    const normalizedAction = controlAction.toLowerCase();
    const locallyAccepted =
      normalizedAction === 'accepted' && Boolean(await wasCallLocallyAccepted(controlCallId));
    const preserveAcceptedState = shouldPreserveAcceptedCallControlState(
      normalizedAction,
      locallyAccepted,
    );
    logCallEvent('IOS_VOIP_PUSH_RECEIVED', {
      callId: controlCallId,
      pushType: 'call_control',
      action: normalizedAction,
      locallyAccepted,
      preserveAcceptedState,
    });
    if (normalizedAction !== 'accepted') {
      await cacheTerminatedCallId(controlCallId, normalizedAction || 'ENDED').catch(() => {});
    }
    await clearPendingIncomingCall(controlCallId).catch(() => {});
    if (!preserveAcceptedState) {
      endIncomingCallNative(controlCallId);
      await clearActiveCallState(controlCallId).catch(() => {});
    }
    emitCallControlEvent({
      call_id: controlCallId,
      action: normalizedAction,
      actor_id: String(notification?.actor_id || notification?.accepted_by || notification?.ended_by || ''),
    });
    return;
  }

  const call = normalizeIncomingCallPayload(notification);
  if (!call) return;
  logCallEvent('IOS_VOIP_PUSH_RECEIVED', {
    callId: call.id,
    appPlatform: Platform.OS,
  });

  const cachedTerminalStatus = await getCachedTerminatedCallStatus(call.id);
  if (cachedTerminalStatus) {
    logCallEvent('STALE_PUSH_IGNORED', {
      callId: call.id,
      terminalStatus: cachedTerminalStatus,
      source: 'voip_push_cache',
    });
    endIncomingCallNative(call.id);
    await clearPendingIncomingCall(call.id).catch(() => {});
    await clearActiveCallState(call.id).catch(() => {});
    return;
  }

  try {
    const statusResponse = await Promise.race([
      api.get(`/calls/${call.id}/status`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    const status = mapBackendCallStatus((statusResponse as any)?.data?.status);
    if (isTerminalCallStatus(status) || (statusResponse as any)?.data?.ended_at) {
      await cacheTerminatedCallId(call.id, status);
      logCallEvent('STALE_PUSH_IGNORED', {
        callId: call.id,
        terminalStatus: status,
        source: 'voip_push_backend_status',
      });
      endIncomingCallNative(call.id);
      await clearPendingIncomingCall(call.id).catch(() => {});
      await clearActiveCallState(call.id).catch(() => {});
      return;
    }
  } catch {
    /* PushKit completion must stay fast; backend sync remains best-effort. */
  }

  // AppDelegate has already reported this PushKit notification to CallKit.
  // Hydrate the JS-side map so answer/end actions can complete signaling.
  await hydrateIncomingCallNative({
    callId: call.id,
    conversationId: call.conversation_id,
    callerId: call.caller_id,
    callerName: call.caller_name,
  });
  await showIncomingCallFromPush({ ...notification, received_at: Date.now() });
}

export function setupVoipPushNotifications(): void {
  if (Platform.OS !== 'ios' || initialized) return;
  initialized = true;

  try {
    const VoipPushNotification = require('react-native-voip-push-notification').default;
    const onRegister = (token: string) => {
      rememberVoipToken(token).catch(() => {});
    };
    const onNotification = (notification: any) => {
      handleVoipNotification(notification)
        .catch(() => {})
        .finally(() => {
          const uuid = String(notification?.uuid || notification?.call_id || '');
          if (uuid) VoipPushNotification.onVoipNotificationCompleted(uuid);
        });
    };

    VoipPushNotification.addEventListener('register', onRegister);
    VoipPushNotification.addEventListener('notification', onNotification);
    VoipPushNotification.addEventListener('didLoadWithEvents', (events: any[]) => {
      for (const event of Array.isArray(events) ? events : []) {
        if (event?.name === VoipPushNotification.RNVoipPushRemoteNotificationsRegisteredEvent) {
          onRegister(event.data);
        } else if (
          event?.name === VoipPushNotification.RNVoipPushRemoteNotificationReceivedEvent
        ) {
          onNotification(event.data);
        }
      }
    });
    VoipPushNotification.registerVoipToken();
  } catch (error) {
    initialized = false;
    console.warn('[voip-push] setup failed', error);
  }
}

export async function getStoredVoipPushToken(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  const token = await AsyncStorage.getItem(VOIP_TOKEN_STORAGE_KEY);
  return token?.trim() || null;
}

export async function clearStoredVoipPushToken(): Promise<void> {
  await AsyncStorage.removeItem(VOIP_TOKEN_STORAGE_KEY);
}
