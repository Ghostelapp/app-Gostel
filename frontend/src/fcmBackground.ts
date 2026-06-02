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
 *   3. We then call `displayIncomingCallNative()` which uses CallKeep to show
 *      the OS-level incoming-call screen on the lockscreen.
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
 *     enter the CallKeep path.
 */
import { Platform } from 'react-native';

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
        // Only show the native UI if the data type is a call. Everything else
        // is handled by expo-notifications + our existing in-app UI.
        if (msg?.data?.type === 'incoming_call') {
          // In foreground we rely on the WS flow that's already wired in
          // IncomingCallProvider. Skip showing the native UI to avoid a
          // duplicate "incoming call" screen.
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
  const isCall = d.type === 'incoming_call' || d.type === 'call';
  if (!isCall) return;

  const callId = d.call_id;
  const callerId = d.caller_id;
  const callerName = d.caller_name || d.sender_name || 'Unknown';
  const conversationId = d.conversation_id;
  if (!callId || !callerId || !conversationId) return;

  try {
    const { displayIncomingCallNative, setupCallKeep } = require('./callkeep');
    // Setup is idempotent — safe to call in headless context.
    await setupCallKeep();
    displayIncomingCallNative({
      callId,
      conversationId,
      callerId,
      callerName,
      callerAvatar: d.caller_avatar || null,
    });
  } catch (e) {
    console.warn('[fcm] could not display native call', e);
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
