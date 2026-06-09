/**
 * src/callkeep.ts — CallKeep integration.
 *
 * `react-native-callkeep` exposes iOS CallKit native incoming-call UI. Android
 * uses our own Firebase full-screen notification implementation instead, so
 * this module returns early there and never requests Telecom permissions.
 *
 * Lifecycle:
 *   1. setupCallKeep() runs once at app boot (called from _layout.tsx).
 *   2. FCM background handler (src/fcmBackground.ts) calls this on iOS when
 *      `displayIncomingCallNative()` when a `type: incoming_call` data push
 *      arrives — this shows the OS-level call screen even if the app is killed.
 *   3. User taps "Answer" on the native screen → CallKeep emits `answerCall`,
 *      which we forward to React Navigation → opens /call/{id}.
 *   4. User taps "Decline" → CallKeep emits `endCall` → we POST /calls/{id}/end
 *      AND send a WS `call:reject` so the caller updates in real time.
 *
 * Android support is intentionally a no-op.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

let _initialized = false;
let _lastPhoneAccountWarningAt = 0;
const _activeCalls = new Map<string, IncomingCallInfo>();
const ACTIVE_CALL_PREFIX = 'ghostel_active_call_v1:';
const PENDING_ANSWERED_CALL_KEY = 'ghostel_pending_answered_call_v1';
type RouterLike = { push: (href: any) => void; replace?: (href: any) => void };
let _router: RouterLike | null = null;
let _wsSend: ((msg: any) => void) | null = null;

export type IncomingCallInfo = {
  callId: string;            // UUID — used as CallKeep callUUID
  conversationId: string;
  callerId: string;
  callerName: string;
  callerAvatar?: string | null;
};

const callKeepOptions = {
  ios: {
    appName: 'ghostel.app',
    supportsVideo: false,
    includesCallsInRecents: false,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
  },
  android: {
    selfManaged: false,
  },
};

/** Provide the router + WebSocket send handle so CallKeep events can act. */
export function bindCallKeepBridge(opts: {
  router: RouterLike;
  wsSend: (msg: any) => void;
}) {
  if (Platform.OS === 'android') return;
  _router = opts.router;
  _wsSend = opts.wsSend;
  flushPendingAnsweredCall().catch(() => {});
}

function normalizeCallId(callId: string): string {
  return String(callId || '').toLowerCase();
}

function activeCallKey(callId: string): string {
  return `${ACTIVE_CALL_PREFIX}${normalizeCallId(callId)}`;
}

function callHref(info: IncomingCallInfo): string {
  return `/call/${info.callId}?role=callee&conversation_id=${info.conversationId}&caller_id=${info.callerId}`;
}

async function rememberIncomingCall(info: IncomingCallInfo): Promise<void> {
  const key = normalizeCallId(info.callId);
  if (!key) return;
  _activeCalls.set(key, info);
  await AsyncStorage.setItem(activeCallKey(info.callId), JSON.stringify(info));
}

async function getIncomingCallInfo(callId: string): Promise<IncomingCallInfo | null> {
  const key = normalizeCallId(callId);
  if (!key) return null;
  const cached = _activeCalls.get(key);
  if (cached) return cached;
  const raw = await AsyncStorage.getItem(activeCallKey(callId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IncomingCallInfo;
    if (parsed.callId && parsed.conversationId && parsed.callerId) {
      _activeCalls.set(key, parsed);
      return parsed;
    }
  } catch {
    /* ignore corrupt cache */
  }
  return null;
}

async function forgetIncomingCall(callId: string): Promise<void> {
  const key = normalizeCallId(callId);
  if (!key) return;
  _activeCalls.delete(key);
  await AsyncStorage.removeItem(activeCallKey(callId));
}

async function routeOrDeferAnsweredCall(info: IncomingCallInfo): Promise<void> {
  const href = callHref(info);
  if (_router) {
    _router.push(href);
    return;
  }
  await AsyncStorage.setItem(PENDING_ANSWERED_CALL_KEY, href);
}

async function flushPendingAnsweredCall(): Promise<void> {
  if (!_router) return;
  const href = await AsyncStorage.getItem(PENDING_ANSWERED_CALL_KEY);
  if (!href) return;
  await AsyncStorage.removeItem(PENDING_ANSWERED_CALL_KEY);
  _router.push(href);
}

/**
 * One-time setup of CallKeep + event listeners. Safe to call multiple times.
 */
export async function setupCallKeep(): Promise<boolean> {
  if (_initialized) return true;
  if (Platform.OS === 'web' || Platform.OS === 'android') return false;
  try {
    const RNCallKeep = require('react-native-callkeep').default;
    await RNCallKeep.setup(callKeepOptions);
    // Safe on iOS CallKit; Android never reaches this branch.
    try {
      RNCallKeep.setAvailable(true);
    } catch {
      /* iOS doesn't support this */
    }

    // ---------- Event handlers ----------
    RNCallKeep.addEventListener('answerCall', async ({ callUUID }: { callUUID: string }) => {
      const info = await getIncomingCallInfo(callUUID);
      if (!info) return;
      // Tell CallKeep we've accepted; navigate to our WebRTC screen.
      try {
        RNCallKeep.setCurrentCallActive(callUUID);
      } catch {
        /* ignore */
      }
      try {
        const { api } = require('./api');
        api.post(`/calls/${info.callId}/accept`).catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        _wsSend?.({
          type: 'call:accept',
          to: info.callerId,
          call_id: info.callId,
          conversation_id: info.conversationId,
        });
      } catch {
        /* ignore */
      }
      await routeOrDeferAnsweredCall(info);
    });

    RNCallKeep.addEventListener('endCall', async ({ callUUID }: { callUUID: string }) => {
      const info = await getIncomingCallInfo(callUUID);
      await forgetIncomingCall(callUUID);
      if (!info) return;
      // User declined or ended before answering → notify caller + server.
      try {
        _wsSend?.({
          type: 'call:reject',
          to: info.callerId,
          call_id: info.callId,
          conversation_id: info.conversationId,
        });
      } catch {
        /* ignore */
      }
      // Best-effort server record.
      try {
        const { api } = require('./api');
        api.post(`/calls/${info.callId}/end`).catch(() => {});
      } catch {
        /* ignore */
      }
    });

    // Fired when user taps the foreground-service notification — opens the app.
    RNCallKeep.addEventListener(
      'didActivateAudioSession',
      () => {
        /* iOS hook — could (re)start incall manager here */
      },
    );

    _initialized = true;
    return true;
  } catch (e) {
    console.warn('[callkeep] setup failed', e);
    return false;
  }
}

/**
 * Show the native OS-level incoming-call screen. Called from the FCM background
 * handler — works even when the app is killed.
 */
export function displayIncomingCallNative(info: IncomingCallInfo): void {
  if (Platform.OS === 'web' || Platform.OS === 'android') return;
  try {
    const RNCallKeep = require('react-native-callkeep').default;
    rememberIncomingCall(info).catch(() => {});
    RNCallKeep.displayIncomingCall(
      info.callId,           // callUUID (must be a valid UUID-like string)
      info.callerId,         // handle (caller "phone number"-like identifier)
      info.callerName,       // localized name shown on the lockscreen
      'generic',             // handleType
      false,                 // hasVideo
    );
  } catch (e) {
    console.warn('[callkeep] displayIncomingCall failed', e);
  }
}

/** Programmatically end a call (e.g. caller cancelled before we answered). */
export function endIncomingCallNative(callId: string): void {
  if (Platform.OS === 'web' || Platform.OS === 'android') return;
  try {
    const RNCallKeep = require('react-native-callkeep').default;
    RNCallKeep.endCall(callId);
    forgetIncomingCall(callId).catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Report the call as connected so OS shows it in the system call log. */
export function markCallActive(callId: string): void {
  if (Platform.OS === 'web' || Platform.OS === 'android') return;
  try {
    const RNCallKeep = require('react-native-callkeep').default;
    RNCallKeep.setCurrentCallActive(callId);
  } catch {
    /* ignore */
  }
}
