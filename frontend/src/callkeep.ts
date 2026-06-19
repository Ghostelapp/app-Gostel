/**
 * iOS CallKit integration. Android uses its own full-screen notification
 * implementation and never enters this module's native call path.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import {
  activateWebRtcAudioSession,
  deactivateWebRtcAudioSession,
} from './webrtcAudioSession';

let initialized = false;
let setupPromise: Promise<boolean> | null = null;
const activeCalls = new Map<string, IncomingCallInfo>();
const displayedCalls = new Set<string>();
const answeredCalls = new Set<string>();
const appHandledAnswers = new Set<string>();
const suppressedEndEvents = new Set<string>();
const actionListeners = new Set<(action: CallKeepAction) => void>();

const ACTIVE_CALL_PREFIX = 'ghostel_active_call_v1:';
const PENDING_ANSWERED_CALL_KEY = 'ghostel_pending_answered_call_v1';

type RouterLike = { push: (href: any) => void; replace?: (href: any) => void };
let router: RouterLike | null = null;
let wsSend: ((msg: any) => void) | null = null;

export type IncomingCallInfo = {
  callId: string;
  conversationId: string;
  callerId: string;
  callerName: string;
  callerAvatar?: string | null;
};

export type CallKeepAction = {
  callId: string;
  action: 'answer' | 'end';
};

const callKeepOptions = {
  ios: {
    appName: 'ghostel.app',
    supportsVideo: false,
    includesCallsInRecents: false,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
    audioSession: {
      categoryOptions: 0x4,
      mode: 'AVAudioSessionModeVoiceChat',
    },
  },
  android: {
    selfManaged: false,
  },
};

export function bindCallKeepBridge(opts: {
  router: RouterLike;
  wsSend: (msg: any) => void;
}): void {
  if (Platform.OS !== 'ios') return;
  router = opts.router;
  wsSend = opts.wsSend;
  flushPendingAnsweredCall().catch(() => {});
}

export function subscribeToCallKeepActions(
  listener: (action: CallKeepAction) => void,
): () => void {
  actionListeners.add(listener);
  return () => actionListeners.delete(listener);
}

export function isIncomingCallNativeDisplayed(callId: string): boolean {
  return Platform.OS === 'ios' && displayedCalls.has(normalizeCallId(callId));
}

function emitCallKeepAction(action: CallKeepAction): void {
  for (const listener of actionListeners) {
    try {
      listener(action);
    } catch {
      /* one consumer must not block the others */
    }
  }
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
  activeCalls.set(key, info);
  await AsyncStorage.setItem(activeCallKey(info.callId), JSON.stringify(info));
}

async function getIncomingCallInfo(callId: string): Promise<IncomingCallInfo | null> {
  const key = normalizeCallId(callId);
  if (!key) return null;
  const cached = activeCalls.get(key);
  if (cached) return cached;

  const raw = await AsyncStorage.getItem(activeCallKey(callId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IncomingCallInfo;
    if (parsed.callId && parsed.conversationId && parsed.callerId) {
      activeCalls.set(key, parsed);
      return parsed;
    }
  } catch {
    await AsyncStorage.removeItem(activeCallKey(callId));
  }
  return null;
}

async function forgetIncomingCall(callId: string): Promise<void> {
  const key = normalizeCallId(callId);
  if (!key) return;
  activeCalls.delete(key);
  displayedCalls.delete(key);
  await AsyncStorage.removeItem(activeCallKey(callId));
}

async function clearPendingIncomingCall(callId: string): Promise<void> {
  try {
    const store = require('./incomingCallStore');
    await store.clearPendingIncomingCall(callId);
  } catch {
    /* best-effort state cleanup */
  }
}

async function routeOrDeferAnsweredCall(info: IncomingCallInfo): Promise<void> {
  const href = callHref(info);
  if (router && AppState.currentState === 'active') {
    router.push(href);
    return;
  }
  await AsyncStorage.setItem(PENDING_ANSWERED_CALL_KEY, href);
}

async function flushPendingAnsweredCall(): Promise<void> {
  if (!router || AppState.currentState !== 'active') return;
  const href = await AsyncStorage.getItem(PENDING_ANSWERED_CALL_KEY);
  if (!href) return;
  await AsyncStorage.removeItem(PENDING_ANSWERED_CALL_KEY);
  router.push(href);
}

async function handleAnswerCall(callUUID: string): Promise<void> {
  const key = normalizeCallId(callUUID);
  if (!key) return;
  const info = await getIncomingCallInfo(callUUID);
  if (!info) return;

  answeredCalls.add(key);
  await clearPendingIncomingCall(info.callId);
  emitCallKeepAction({ callId: info.callId, action: 'answer' });

  // answerIncomingCall() also emits answerCall. The in-app answer button owns
  // API and navigation, so consume that duplicate native event.
  if (appHandledAnswers.delete(key)) return;

  // Persist the destination before any network request. iOS may suspend the
  // JavaScript runtime while the user is entering the device passcode; the
  // AppState listener can then finish routing as soon as the app is active.
  await routeOrDeferAnsweredCall(info);

  try {
    wsSend?.({
      type: 'call:accept',
      to: info.callerId,
      call_id: info.callId,
      conversation_id: info.conversationId,
    });
  } catch {
    /* the API call below remains authoritative */
  }
  try {
    const { api } = require('./api');
    api.post(`/calls/${info.callId}/accept`).catch(() => {});
  } catch {
    /* the persisted signaling path can still connect the call */
  }
}

async function handleEndCall(callUUID: string): Promise<void> {
  const key = normalizeCallId(callUUID);
  if (!key) return;

  if (suppressedEndEvents.delete(key)) {
    answeredCalls.delete(key);
    appHandledAnswers.delete(key);
    await forgetIncomingCall(callUUID);
    return;
  }

  const info = await getIncomingCallInfo(callUUID);
  const wasAnswered = answeredCalls.has(key);
  answeredCalls.delete(key);
  appHandledAnswers.delete(key);
  await forgetIncomingCall(callUUID);
  await clearPendingIncomingCall(callUUID);
  if (!info) return;
  emitCallKeepAction({ callId: info.callId, action: 'end' });

  try {
    wsSend?.({
      type: wasAnswered ? 'call:end' : 'call:reject',
      to: info.callerId,
      call_id: info.callId,
      conversation_id: info.conversationId,
    });
  } catch {
    /* the server update below remains authoritative */
  }
  try {
    const { api } = require('./api');
    await api.post(`/calls/${info.callId}/end`);
  } catch {
    /* best-effort server record */
  }
}

export async function setupCallKeep(): Promise<boolean> {
  if (initialized) return true;
  if (Platform.OS !== 'ios') return false;
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    try {
      const RNCallKeep = require('react-native-callkeep').default;
      await RNCallKeep.setup(callKeepOptions);

      RNCallKeep.addEventListener(
        'answerCall',
        ({ callUUID }: { callUUID: string }) => {
          handleAnswerCall(callUUID).catch(() => {});
        },
      );
      RNCallKeep.addEventListener(
        'endCall',
        ({ callUUID }: { callUUID: string }) => {
          handleEndCall(callUUID).catch(() => {});
        },
      );
      RNCallKeep.addEventListener('didActivateAudioSession', () => {
        activateWebRtcAudioSession();
      });
      RNCallKeep.addEventListener('didDeactivateAudioSession', () => {
        deactivateWebRtcAudioSession();
      });

      AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        flushPendingAnsweredCall().catch(() => {});
        if (answeredCalls.size > 0) activateWebRtcAudioSession();
      });

      initialized = true;

      // Replay a CallKit action made before the JavaScript bridge was ready.
      try {
        const events = await RNCallKeep.getInitialEvents?.();
        for (const event of Array.isArray(events) ? events : []) {
          const name = String(event?.name || '');
          const callUUID = String(event?.data?.callUUID || '');
          if (!callUUID) continue;
          if (name.includes('PerformAnswerCallAction')) {
            await handleAnswerCall(callUUID);
          } else if (name.includes('PerformEndCallAction')) {
            await handleEndCall(callUUID);
          }
        }
        RNCallKeep.clearInitialEvents?.();
      } catch {
        /* live event listeners remain available */
      }
      return true;
    } catch (error) {
      console.warn('[callkeep] setup failed', error);
      setupPromise = null;
      return false;
    }
  })();

  return setupPromise;
}

export async function displayIncomingCallNative(
  info: IncomingCallInfo,
): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const key = normalizeCallId(info.callId);
  if (!key || displayedCalls.has(key)) return !!key;
  displayedCalls.add(key);

  try {
    if (!(await setupCallKeep())) throw new Error('CallKeep unavailable');
    const RNCallKeep = require('react-native-callkeep').default;
    await rememberIncomingCall(info);
    await RNCallKeep.displayIncomingCall(
      info.callId,
      info.callerId,
      info.callerName,
      'generic',
      false,
    );
    return true;
  } catch (error) {
    displayedCalls.delete(key);
    console.warn('[callkeep] displayIncomingCall failed', error);
    return false;
  }
}

export async function answerIncomingCallNative(callId: string): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  const key = normalizeCallId(callId);
  if (!key) return false;

  try {
    if (!(await setupCallKeep())) return false;
    const RNCallKeep = require('react-native-callkeep').default;
    answeredCalls.add(key);
    appHandledAnswers.add(key);
    await clearPendingIncomingCall(callId);
    await RNCallKeep.answerIncomingCall(callId);
    setTimeout(() => appHandledAnswers.delete(key), 5_000);
    return true;
  } catch {
    appHandledAnswers.delete(key);
    return false;
  }
}

/** End CallKit UI without treating the resulting native event as a rejection. */
export function endIncomingCallNative(callId: string): void {
  if (Platform.OS !== 'ios') return;
  const key = normalizeCallId(callId);
  if (!key) return;

  try {
    const RNCallKeep = require('react-native-callkeep').default;
    suppressedEndEvents.add(key);
    RNCallKeep.endCall(callId);
    forgetIncomingCall(callId).catch(() => {});
    answeredCalls.delete(key);
    appHandledAnswers.delete(key);
    setTimeout(() => suppressedEndEvents.delete(key), 5_000);
  } catch {
    suppressedEndEvents.delete(key);
  }
}

export function markCallActive(callId: string): void {
  if (Platform.OS !== 'ios') return;
  const key = normalizeCallId(callId);
  if (key) answeredCalls.add(key);
  activateWebRtcAudioSession();
}
