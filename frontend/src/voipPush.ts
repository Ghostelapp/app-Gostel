import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { hydrateIncomingCallNative } from './callkeep';
import {
  normalizeIncomingCallPayload,
  showIncomingCallFromPush,
} from './incomingCallStore';

const VOIP_TOKEN_STORAGE_KEY = 'ghostel_voip_push_token_v1';
let initialized = false;

async function rememberVoipToken(token: unknown): Promise<void> {
  const normalized = String(token || '').trim();
  if (!normalized) return;
  await AsyncStorage.setItem(VOIP_TOKEN_STORAGE_KEY, normalized);
}

async function handleVoipNotification(notification: any): Promise<void> {
  const call = normalizeIncomingCallPayload(notification);
  if (!call) return;

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
