import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from './api';

let _channelsConfigured = false;

export async function configureAndroidChannels() {
  if (Platform.OS !== 'android' || _channelsConfigured) return;
  try {
    const Notifications = require('expo-notifications');
    const PUBLIC =
      Notifications.AndroidNotificationVisibility?.PUBLIC ?? 1;
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
      lockscreenVisibility: PUBLIC,
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
      lockscreenVisibility: PUBLIC,
      description: 'Incoming voice/video calls',
      showBadge: true,
      enableLights: true,
      enableVibrate: true,
    });
    // Generic notifications (mentions, system, AI, invites).
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
      lockscreenVisibility: PUBLIC,
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

    // Direct FCM — get raw device push token (FCM on Android, APNs on iOS).
    // This bypasses Expo Push API entirely; backend will send via FCM HTTP v1
    // using the Service Account credentials we host server-side.
    let tokenResp: any = null;
    try {
      tokenResp = await Notifications.getDevicePushTokenAsync();
    } catch (e: any) {
      diag.expo_device_token_error = String(e?.message || e).slice(0, 300);
    }
    let token = tokenResp?.data;
    let tokenType = tokenResp?.type || (Platform.OS === 'ios' ? 'apns' : 'fcm');

    // Fallback for Android release builds using @react-native-firebase/messaging.
    // This avoids depending solely on expo-notifications for raw FCM token
    // retrieval while the backend sends directly through FCM HTTP v1.
    if (!token && Platform.OS === 'android') {
      try {
        const messaging = require('@react-native-firebase/messaging').default;
        const firebaseAuthStatus = await messaging().requestPermission();
        diag.firebase_permission = firebaseAuthStatus;
        token = await messaging().getToken();
        tokenType = 'fcm';
        diag.token_source = 'firebase_messaging';
      } catch (e: any) {
        diag.firebase_token_error = String(e?.message || e).slice(0, 300);
      }
    } else {
      diag.token_source = 'expo_notifications';
    }

    if (!token) {
      diag.reason = 'token_empty';
      diag.token_resp = String(JSON.stringify(tokenResp)).slice(0, 200);
      await reportDiag(diag);
      return null;
    }

    diag.reason = 'success';
    diag.token_type = tokenType;
    diag.token_prefix = String(token).slice(0, 30);
    try {
      // Send raw FCM/APNs token + type so backend knows how to send.
      await api.post('/push/register', {
        token,
        platform: Platform.OS,
        token_type: tokenType,
        device_model: diag.device_model,
        os_version: diag.os_version,
        source: diag.token_source,
      });
    } catch (e: any) {
      diag.reason = 'register_failed';
      diag.register_error = String(e?.message || e).slice(0, 300);
      await reportDiag(diag);
      return null;
    }
    await reportDiag(diag);
    return token;
  } catch (e: any) {
    diag.reason = 'outer_exception';
    diag.error = String(e?.message || e).slice(0, 300);
    await reportDiag(diag);
    return null;
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
