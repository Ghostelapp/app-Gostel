import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { api } from './api';
import {
  clearStoredVoipPushToken,
  getStoredVoipPushToken,
} from './voipPush';

let _channelsConfigured = false;
const PUSH_TOKEN_STORAGE_KEY = 'ghostel_push_token_v1';
const PUSH_DEVICE_ID_STORAGE_KEY = 'ghostel_push_device_id_v1';
const IOS_FCM_RETRY_DELAYS_MS = [0, 300, 900, 1_800, 3_000];

type PushRegistration = {
  token: string;
  token_type: string;
  source: string;
};

type StoredPushState = {
  device_id?: string;
  token?: string;
  tokens?: PushRegistration[];
  platform?: string;
};

function getStoredPushTokens(value: any): string[] {
  if (Array.isArray(value?.tokens)) {
    return value.tokens
      .map((entry: any) => (typeof entry?.token === 'string' ? entry.token : ''))
      .filter(Boolean);
  }
  return typeof value?.token === 'string' && value.token ? [value.token] : [];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStoredPushState(): Promise<StoredPushState | null> {
  const raw = await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getOrCreatePushDeviceId(): Promise<string> {
  const existing = (await AsyncStorage.getItem(PUSH_DEVICE_ID_STORAGE_KEY)) || '';
  if (existing) return existing;
  const generated =
    typeof Crypto.randomUUID === 'function'
      ? Crypto.randomUUID()
      : `ghostel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  await AsyncStorage.setItem(PUSH_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

async function getIosFirebaseToken(diag: Record<string, any>): Promise<string | null> {
  const messaging = require('@react-native-firebase/messaging').default;
  const firebaseAuthStatus = await messaging().requestPermission();
  diag.firebase_permission = firebaseAuthStatus;
  await messaging().registerDeviceForRemoteMessages();
  diag.firebase_remote_registered = true;

  let lastError = '';
  for (let attempt = 0; attempt < IOS_FCM_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = IOS_FCM_RETRY_DELAYS_MS[attempt];
    if (delay > 0) await wait(delay);
    try {
      const apnsToken = await messaging().getAPNSToken?.();
      diag.firebase_apns_ready = !!apnsToken;
      const token = await messaging().getToken();
      if (token) {
        diag.firebase_token_attempt = attempt + 1;
        return token;
      }
    } catch (error: any) {
      lastError = String(error?.message || error).slice(0, 300);
    }
  }

  if (lastError) diag.firebase_token_error = lastError;
  return null;
}

function getExpoProjectId(): string | undefined {
  const c: any = Constants as any;
  return (
    c?.expoConfig?.extra?.eas?.projectId ||
    c?.easConfig?.projectId ||
    c?.manifest?.extra?.eas?.projectId ||
    c?.manifest2?.extra?.expoClient?.extra?.eas?.projectId
  );
}

export async function configureAndroidChannels() {
  if (Platform.OS !== 'android' || _channelsConfigured) return;
  try {
    const Notifications = require('expo-notifications');
    const PRIVATE =
      Notifications.AndroidNotificationVisibility?.PRIVATE ?? 0;
    // Default messages channel — wakes screen + heads-up banner.
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#00d9ff',
      sound: 'message',
      description: 'New chat messages',
      showBadge: true,
      enableLights: true,
      enableVibrate: true,
      lockscreenVisibility: PRIVATE,
    });
    // High-priority calls channel — heads-up, ringtone, long vibration,
    // bypass DND so user always hears it.
    await Notifications.setNotificationChannelAsync('calls', {
      name: 'Incoming calls',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 1000, 500, 1000, 500, 1000],
      lightColor: '#22c55e',
      sound: 'ringtone',
      bypassDnd: true,
      lockscreenVisibility: PRIVATE,
      description: 'Incoming voice/video calls',
      showBadge: true,
      enableLights: true,
      enableVibrate: true,
    });
    // Generic notifications (mentions, system, invites).
    await Notifications.setNotificationChannelAsync('notifications', {
      name: 'Powiadomienia',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 100, 200],
      lightColor: '#00d9ff',
      sound: 'notification',
      description: 'App notifications',
      showBadge: true,
      enableLights: true,
      enableVibrate: true,
      lockscreenVisibility: PRIVATE,
    });
    _channelsConfigured = true;
  } catch {
    /* ignore */
  }
}

export async function registerPushNotificationsAsync(): Promise<string | null> {
  const diag: Record<string, any> = { platform: Platform.OS };
  try {
    if (Platform.OS === 'web') {
      diag.reason = 'web_platform';
      await reportDiag(diag);
      return null;
    }
    const isExpoGo =
      Constants?.appOwnership === 'expo' ||
      Constants?.executionEnvironment === 'storeClient';
    diag.is_expo_go = isExpoGo;

    const Notifications = require('expo-notifications');
    const Device = require('expo-device');
    diag.is_device = Device.isDevice;
    diag.device_model = Device.modelName || Device.deviceName || '';
    diag.os_version = Device.osVersion || '';

    if (!Device.isDevice) {
      diag.reason = 'simulator';
      await reportDiag(diag);
      return null;
    }
    const deviceId = await getOrCreatePushDeviceId();
    diag.device_id_prefix = deviceId.slice(0, 12);

    await configureAndroidChannels();
    diag.channels_configured = _channelsConfigured;

    if (isExpoGo) {
      diag.reason = 'expo_go_unsupported';
      await reportDiag(diag);
      return null;
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let final = existing;
    diag.permission_initial = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      final = status;
    }
    diag.permission_final = final;
    if (final !== 'granted') {
      diag.reason = 'permission_denied';
      await reportDiag(diag);
      return null;
    }

    // Keep both iOS transports registered. Direct FCM is preferred because it
    // can wake the Firebase background handler. Expo Push is an independent
    // APNs fallback when Firebase has no valid Apple push credential.
    let tokenResp: any = null;
    const registrations: PushRegistration[] = [];

    if (Platform.OS === 'ios') {
      const voipToken = await getStoredVoipPushToken().catch(() => null);
      diag.voip_token_ready = !!voipToken;
      if (voipToken) {
        registrations.push({
          token: voipToken,
          token_type: 'voip',
          source: 'pushkit',
        });
      }

      try {
        const firebaseToken = await getIosFirebaseToken(diag);
        if (firebaseToken) {
          registrations.push({
            token: firebaseToken,
            token_type: 'fcm',
            source: 'firebase_messaging',
          });
        }
      } catch (e: any) {
        diag.firebase_token_error = String(e?.message || e).slice(0, 300);
      }

      try {
        const projectId = getExpoProjectId();
        diag.expo_project_id = projectId || '';
        tokenResp = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        const expoToken = tokenResp?.data || null;
        if (expoToken) {
          registrations.push({
            token: expoToken,
            token_type: 'expo',
            source: 'expo_push_service_fallback',
          });
        }
      } catch (e: any) {
        diag.expo_push_token_error = String(e?.message || e).slice(0, 300);
      }
    } else {
      try {
        tokenResp = await Notifications.getDevicePushTokenAsync();
        const deviceToken = tokenResp?.data || null;
        if (deviceToken) {
          registrations.push({
            token: deviceToken,
            token_type: tokenResp?.type || 'fcm',
            source: 'expo_notifications',
          });
        }
      } catch (e: any) {
        diag.expo_device_token_error = String(e?.message || e).slice(0, 300);
      }
    }

    // Fallback for release builds using @react-native-firebase/messaging.
    // This avoids depending solely on expo-notifications for raw FCM token
    // retrieval while the backend sends directly through FCM HTTP v1.
    if (registrations.length === 0) {
      try {
        const messaging = require('@react-native-firebase/messaging').default;
        const firebaseAuthStatus = await messaging().requestPermission();
        diag.firebase_permission = firebaseAuthStatus;
        if (Platform.OS === 'ios') {
          await messaging().registerDeviceForRemoteMessages();
          diag.firebase_remote_registered = true;
        }
        const firebaseToken = await messaging().getToken();
        if (firebaseToken) {
          registrations.push({
            token: firebaseToken,
            token_type: 'fcm',
            source: 'firebase_messaging',
          });
        }
      } catch (e: any) {
        diag.firebase_token_error = String(e?.message || e).slice(0, 300);
      }
    }

    if (registrations.length === 0) {
      diag.reason = 'token_empty';
      diag.token_resp = String(JSON.stringify(tokenResp)).slice(0, 200);
      await reportDiag(diag);
      return null;
    }

    diag.token_source = registrations.map((entry) => entry.source).join('+');
    diag.token_type = registrations.map((entry) => entry.token_type).join('+');
    diag.token_prefix = registrations.map((entry) => entry.token.slice(0, 12)).join(',');
    let registered: PushRegistration[] = [];
    try {
      const previous = await getStoredPushState();
      const currentTokens = new Set(registrations.map((entry) => entry.token));

      for (const entry of registrations) {
        try {
          await api.post('/push/register', {
            token: entry.token,
            platform: Platform.OS,
            token_type: entry.token_type,
            device_id: deviceId,
            device_model: diag.device_model,
            os_version: diag.os_version,
            source: entry.source,
          });
          registered.push(entry);
        } catch (error: any) {
          diag.register_error = [
            diag.register_error,
            `${entry.token_type}:${String(error?.message || error).slice(0, 180)}`,
          ].filter(Boolean).join(';').slice(0, 300);
        }
      }

      if (registered.length === 0) {
        throw new Error(diag.register_error || 'No push transport registered');
      }

      for (const previousToken of getStoredPushTokens(previous)) {
        if (!currentTokens.has(previousToken)) {
          await api.post('/push/unregister', { token: previousToken }).catch(() => {});
        }
      }
      await AsyncStorage.setItem(
        PUSH_TOKEN_STORAGE_KEY,
        JSON.stringify({ device_id: deviceId, tokens: registered, platform: Platform.OS }),
      );
      diag.reason = 'success';
    } catch (e: any) {
      diag.reason = 'register_failed';
      diag.register_error = String(e?.message || e).slice(0, 300);
      await reportDiag(diag);
      return null;
    }
    await reportDiag(diag);
    return registered[0].token;
  } catch (e: any) {
    diag.reason = 'outer_exception';
    diag.error = String(e?.message || e).slice(0, 300);
    await reportDiag(diag);
    return null;
  }
}

export async function unregisterCurrentPushDeviceAsync(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const cached = await getStoredPushState();
    const tokens = getStoredPushTokens(cached);
    if (cached?.device_id) {
      await api.post('/push/unregister', { device_id: cached.device_id });
    } else if (tokens.length === 0) {
      await api.post('/push/unregister', {});
    } else {
      for (const token of tokens) {
        await api.post('/push/unregister', { token });
      }
    }
  } finally {
    await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
    await clearStoredVoipPushToken();
  }
}

async function reportDiag(diag: Record<string, any>) {
  // Best-effort diagnostic report — never throws
  try {
    await api.post('/push/diag', diag);
  } catch {
    /* ignore */
  }
}

export function setNotificationHandler() {
  if (Platform.OS === 'web') return;
  try {
    const Notifications = require('expo-notifications');
    configureAndroidChannels().catch(() => {});
    Notifications.setNotificationHandler({
      handleNotification: async (notification: any) => {
        const data = notification?.request?.content?.data || {};
        const isCall =
          data?.type === 'call:incoming' ||
          data?.type === 'incoming_call' ||
          data?.kind === 'call' ||
          data?.category === 'call';
        // For incoming-call pushes we ALWAYS show the heads-up banner +
        // play the system ringtone — this is what the user sees on the
        // lockscreen when the app is in the background or killed. When the
        // app is in the FOREGROUND the IncomingCallProvider's WS path also
        // plays the in-app ringtone; setting `shouldPlaySound: false` here
        // avoids overlapping ringtones in that single edge case.
        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldSetBadge: true,
          // For calls we let the system play the channel ringtone (the
          // `calls` channel is configured with sound=ringtone +
          // bypassDnd=true on the device). For regular messages we
          // suppress the system sound because we play a short in-app tone
          // ourselves to avoid double sounds when foregrounded.
          shouldPlaySound: isCall,
        };
      },
    });
  } catch {
    /* ignore */
  }
}

/** Subscribe to notification taps and route the user accordingly.
 *  Returns an unsubscribe function. */
export function subscribeToNotificationTaps(
  router: { push: (href: any) => void },
): () => void {
  if (Platform.OS === 'web') return () => {};
  try {
    const Notifications = require('expo-notifications');

    const handleData = (data: any) => {
      if (!data) return;
      const screen = data.screen || data.type;
      if (screen === 'call' && data.call_id) {
        try {
          const { showIncomingCallFromPush } = require('./incomingCallStore');
          showIncomingCallFromPush(data).catch(() => {});
        } catch {
          const conv = data.conversation_id || '';
          const caller = data.caller_id || '';
          router.push(
            `/call/${data.call_id}?role=callee${conv ? `&conversation_id=${conv}` : ''}${caller ? `&caller_id=${caller}` : ''}`,
          );
        }
      } else if (screen === 'chat' && data.conversation_id) {
        router.push(`/chat/${data.conversation_id}`);
      }
    };

    // Handle initial notification that opened the app from a cold start
    Notifications.getLastNotificationResponseAsync()
      .then((resp: any) => {
        if (resp?.notification?.request?.content?.data) {
          handleData(resp.notification.request.content.data);
        }
      })
      .catch(() => {});

    // Subscribe to taps while app is running
    const sub = Notifications.addNotificationResponseReceivedListener(
      (resp: any) => {
        handleData(resp?.notification?.request?.content?.data);
      },
    );
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
