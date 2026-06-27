/**
 * src/fcmBackground.ts — FCM background message handler (Android).
 *
 * Imported at top-level by app/_layout.tsx so the handler is registered BEFORE
 * any messages can arrive. When the app is killed/locked, an FCM data-only
 * message with `type: incoming_call` will:
 *
 *   1. Wake the JS engine via the Headless task (registered automatically
 *      by @react-native-firebase/messaging).
 *   2. Be dispatched to the handler below.
 *   3. We then show a ghostel.app call notification on the dedicated `calls`
 *      channel. Tapping it opens the app call screen.
 *
 * Foreground messages are handled here too, but since the user is already in
 * the app we let the in-app WS `call:incoming` flow take precedence (no
 * duplicate UI).
 *
 * SAFETY:
 *   - Wrapped in try/import — silently no-ops on web or if firebase isn't
 *     installed, so we never break the existing notification flow.
 *   - Coexists with `expo-notifications` (we still use that for regular
 *     non-call notifications). Only `type: incoming_call` data messages
 *     enter this call-notification path.
 */
import { AppState, Platform } from 'react-native';

type FcmDataMessage = {
  data?: Record<string, string>;
  notification?: any;
  from?: string;
};

let _bgRegistered = false;
let _fgUnsub: (() => void) | null = null;

export function registerFcmHandlers(): void {
  if (Platform.OS === 'web') return;
  if (_bgRegistered) return;
  try {
    const messaging = require('@react-native-firebase/messaging').default;

    // ----- Background / quit handler -----
    // This MUST be registered at module level (not inside a component).
    messaging().setBackgroundMessageHandler(async (msg: FcmDataMessage) => {
      try {
        await _handleVoipPayload(msg);
      } catch (e) {
        console.warn('[fcm] background handler error', e);
      }
    });

    // ----- Foreground handler -----
    // When the app is OPEN, FCM still delivers the data message. We let our
    // existing WebSocket `call:incoming` flow handle the in-app UI, BUT if the
    // socket happens to be down we use CallKeep as a fallback.
    _fgUnsub = messaging().onMessage(async (msg: FcmDataMessage) => {
      try {
        if (_isCallControlPayload(msg?.data)) {
          await _handleCallControlPayload(msg.data || {});
          return;
        }
        // Only show the native UI if the data type is a call. Everything else
        // is handled by expo-notifications + our existing in-app UI.
        if (msg?.data?.type === 'incoming_call') {
          const { showIncomingCallFromPush } = require('./incomingCallStore');
          await showIncomingCallFromPush(msg.data);
          if (Platform.OS === 'ios' && AppState.currentState !== 'active') {
            await _showIncomingCallKit(msg.data);
          }
        }
      } catch (e) {
        console.warn('[fcm] foreground handler error', e);
      }
    });

    _bgRegistered = true;
  } catch (e) {
    // Firebase Messaging not installed / native module missing. This is
    // expected in Expo Go and in the web bundle. Silently skip.
    console.log('[fcm] handlers not registered:', (e as Error)?.message);
  }
}

async function _handleVoipPayload(msg: FcmDataMessage): Promise<void> {
  const d = msg?.data;
  // Accept both `incoming_call` (new payload) and legacy `call` for backward
  // compatibility with older clients / servers.
  if (!d) return;
  if (_isCallControlPayload(d)) {
    await _handleCallControlPayload(d);
    return;
  }
  const isCall =
    d.type === 'incoming_call' ||
    d.type === 'call' ||
    d.kind === 'call' ||
    d.push_kind === 'call';
  if (!isCall) return;

  const callId = d.call_id;
  const callerId = d.caller_id;
  const callerName = d.caller_name || d.sender_name || 'Unknown';
  const conversationId = d.conversation_id;
  if (!callId || !callerId) return;

  try {
    const { showIncomingCallFromPush } = require('./incomingCallStore');
    await showIncomingCallFromPush({
      ...d,
      call_id: callId,
      caller_id: callerId,
      caller_name: callerName,
      conversation_id: conversationId || '',
    });
  } catch (e) {
    console.warn('[fcm] could not store incoming call', e);
  }

  if (Platform.OS === 'ios') {
    await _showIncomingCallKit({
      ...d,
      call_id: callId,
      caller_id: callerId,
      caller_name: callerName,
      conversation_id: conversationId || '',
    });
    return;
  }

  // Android has a native FirebaseMessagingService that posts the real
  // full-screen call notification. Do not post a second JS notification here:
  // on Samsung devices that duplicate can briefly win as a heads-up banner
  // and make the incoming call feel like a normal top notification.
}

function _isCallControlPayload(data?: Record<string, string>): boolean {
  if (!data) return false;
  return (
    data.type === 'call_control' ||
    data.type === 'call:accepted' ||
    data.type === 'call:ended' ||
    !!data.call_control_action
  );
}

async function _handleCallControlPayload(data: Record<string, string>): Promise<void> {
  const callId = data.call_id || '';
  if (!callId) return;
  const action = data.call_control_action || data.status || data.type;
  let locallyAccepted = false;
  try {
    const {
      clearPendingIncomingCall,
      emitCallControlEvent,
      wasCallLocallyAccepted,
    } = require('./incomingCallStore');
    locallyAccepted = action === 'accepted' && Boolean(await wasCallLocallyAccepted(callId));
    await clearPendingIncomingCall(callId);
    emitCallControlEvent({
      call_id: callId,
      action,
      actor_id: data.actor_id || data.accepted_by || data.ended_by || '',
    });
  } catch {
    /* pending call storage is best-effort */
  }
  try {
    const { cancelFullScreenIncomingCallNotification, stopActiveCallService } = require('./androidCallNotification');
    await cancelFullScreenIncomingCallNotification(callId);
    if (action !== 'accepted' || !locallyAccepted) {
      await stopActiveCallService();
    }
  } catch {
    /* native Android cleanup is best-effort */
  }
  try {
    const { endIncomingCallNative } = require('./callkeep');
    if (action !== 'accepted' || !locallyAccepted) {
      endIncomingCallNative(callId);
    }
  } catch {
    /* native iOS cleanup is best-effort */
  }
  try {
    const sounds = require('./sounds');
    await sounds.stopRingtone?.();
  } catch {
    /* sound cleanup is best-effort */
  }
}

async function _showIncomingCallKit(data: Record<string, string>): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    const { displayIncomingCallNative } = require('./callkeep');
    await displayIncomingCallNative({
      callId: data.call_id,
      conversationId: data.conversation_id || '',
      callerId: data.caller_id,
      callerName: data.caller_name || data.sender_name || 'Unknown',
    });
  } catch (e) {
    console.warn('[fcm] could not display iOS CallKit call', e);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _showIncomingCallPushNotification(data: Record<string, string>): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    try {
      const { showFullScreenIncomingCallNotification } = require('./androidCallNotification');
      const shown = await showFullScreenIncomingCallNotification({
        ...data,
        type: 'incoming_call',
        kind: 'call',
        push_kind: 'call',
        screen: 'call',
      });
      if (shown) return;
    } catch (e) {
      console.warn('[fcm] full-screen call notification unavailable', e);
    }

    const Notifications = require('expo-notifications');
    try {
      const { configureAndroidChannels } = require('./push');
      await configureAndroidChannels();
    } catch {
      /* channels are also configured during app boot */
    }

    const callerName = data.caller_name || data.sender_name || 'ghostel.app';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: data.title || `ghostel.app: ${callerName}`,
        body: data.body || 'Połączenie przychodzące w aplikacji',
        sound: 'ringtone',
        data: {
          ...data,
          type: 'incoming_call',
          kind: 'call',
          push_kind: 'call',
          screen: 'call',
        },
        categoryIdentifier: 'call',
        autoDismiss: false,
        sticky: true,
        priority: Notifications.AndroidNotificationPriority?.MAX,
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[fcm] could not show local call notification', e);
  }
}

export function unregisterFcmHandlers(): void {
  if (_fgUnsub) {
    try {
      _fgUnsub();
    } catch {
      /* ignore */
    }
    _fgUnsub = null;
  }
}
