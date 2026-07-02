import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Phone, PhoneOff, ShieldCheck } from 'lucide-react-native';
import Avatar from './Avatar';
import { useWebSocket } from './ws';
import { useAuth } from './auth';
import { api } from './api';
import { theme } from './theme';
import {
  cacheTerminatedCallId,
  clearActiveCallState,
  getCachedTerminatedCallStatus,
  logCallEvent,
  saveActiveCallState,
} from './callState';
import { callManager } from './callManager';
import {
  answerIncomingCallNative,
  bindCallKeepBridge,
  displayIncomingCallNative,
  endIncomingCallNative,
  isIncomingCallNativeDisplayed,
  subscribeToCallKeepActions,
} from './callkeep';
import {
  clearPendingIncomingCall,
  getPendingIncomingCall,
  markCallLocallyAccepted,
  normalizeIncomingCallPayload,
  savePendingIncomingCall,
  subscribeToCallControlEvents,
  subscribeToIncomingCallEvents,
  wasCallLocallyAccepted,
  type IncomingCallPayload,
} from './incomingCallStore';
import {
  cancelFullScreenIncomingCallNotification,
  consumeAndroidResumeEvent,
  consumeInitialNativeIncomingCall,
  showFullScreenIncomingCallNotification,
  startActiveCallService,
  stopActiveCallService,
} from './androidCallNotification';

type IncomingCall = {
  id: string;
  caller_id: string;
  caller_name: string;
  conversation_id: string;
  mode: string;
};

type ShowIncomingOptions = {
  persist?: boolean;
  notifyNative?: boolean;
};

// Vibration pattern: 0ms wait, vibrate 1s, pause 1s — looped
const VIBRATION_PATTERN = [0, 1000, 1000];
const PENDING_CALL_MAX_AGE_MS = 60_000;
const TERMINAL_CALL_STATUSES = new Set([
  'ended',
  'rejected',
  'declined',
  'cancelled',
  'missed',
  'timeout',
  'failed',
]);
const MOBILE_UNLOCK_ACTION_GUARD_MS = 1_800;

export default function IncomingCallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [callActionsGuarded, setCallActionsGuarded] = useState(false);
  const vibratingRef = useRef(false);
  const incomingRef = useRef<IncomingCall | null>(null);
  const incomingCallIdRef = useRef<string | null>(null);
  const dismissedCallIdsRef = useRef(new Set<string>());
  const locallyAcceptedCallIdsRef = useRef(new Set<string>());
  const pulse = useRef(new Animated.Value(0)).current;
  const actionGuardUntilRef = useRef(0);
  const actionGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

  const guardCallActionsAfterUnlock = useCallback(() => {
    if (Platform.OS === 'web') return;
    const guardUntil = Date.now() + MOBILE_UNLOCK_ACTION_GUARD_MS;
    actionGuardUntilRef.current = guardUntil;
    setCallActionsGuarded(true);
    if (actionGuardTimerRef.current) clearTimeout(actionGuardTimerRef.current);
    actionGuardTimerRef.current = setTimeout(() => {
      if (Date.now() >= actionGuardUntilRef.current) {
        setCallActionsGuarded(false);
      }
    }, MOBILE_UNLOCK_ACTION_GUARD_MS + 50);
  }, []);

  const startVibration = useCallback(() => {
    if (vibratingRef.current) return;
    try {
      Vibration.vibrate(VIBRATION_PATTERN, true);
      vibratingRef.current = true;
    } catch {
      /* ignore */
    }
  }, []);

  const stopVibration = useCallback(() => {
    if (!vibratingRef.current) return;
    try {
      Vibration.cancel();
    } catch {
      /* ignore */
    }
    vibratingRef.current = false;
  }, []);

  const showIncoming = useCallback(
    async (
      call: IncomingCallPayload,
      { persist = true, notifyNative = true }: ShowIncomingOptions = {},
    ) => {
      if (call.caller_id === user?.id || dismissedCallIdsRef.current.has(call.id)) return;
      const cachedTerminalStatus = await getCachedTerminatedCallStatus(call.id);
      if (cachedTerminalStatus) {
        logCallEvent('STALE_PUSH_IGNORED', {
          callId: call.id,
          terminalStatus: cachedTerminalStatus,
          source: 'show_incoming',
        });
        dismissedCallIdsRef.current.add(call.id);
        await clearPendingIncomingCall(call.id).catch(() => {});
        await clearActiveCallState(call.id).catch(() => {});
        try {
          endIncomingCallNative(call.id);
        } catch {
          /* ignore */
        }
        return;
      }
      logCallEvent('CALL_INVITE_RECEIVED', {
        callId: call.id,
        callerId: call.caller_id,
        appState: AppState.currentState,
      });
      if (persist) savePendingIncomingCall(call).catch(() => {});
      saveActiveCallState({
        activeCallId: call.id,
        callStatus: 'INCOMING_RINGING',
        callerId: call.caller_id,
        conversationId: call.conversation_id,
        mode: call.mode,
      }).catch(() => {});
      if (Platform.OS === 'ios' && AppState.currentState !== 'active') {
        logCallEvent('CALLKIT_ACTIVE_CALL_CHECK', {
          callId: call.id,
          nativeDisplayed: isIncomingCallNativeDisplayed(call.id),
          appState: AppState.currentState,
        });
        if (notifyNative) {
          displayIncomingCallNative({
            callId: call.id,
            conversationId: call.conversation_id,
            callerId: call.caller_id,
            callerName: call.caller_name,
          }).catch(() => {});
        }
        return;
      }
      if (incomingCallIdRef.current === call.id) {
        logCallEvent('CALL_UI_ALREADY_VISIBLE_SKIP_DUPLICATE', {
          callId: call.id,
          source: 'showIncoming',
        });
        return;
      }
      guardCallActionsAfterUnlock();
      incomingCallIdRef.current = call.id;
      setIncoming((current) => (current?.id === call.id ? current : call));
      const nativeIosCall = isIncomingCallNativeDisplayed(call.id);
      if (Platform.OS === 'ios') {
        logCallEvent('CALLKIT_ACTIVE_CALL_CHECK', {
          callId: call.id,
          nativeDisplayed: nativeIosCall,
          appState: AppState.currentState,
        });
      }
      if (!nativeIosCall) startVibration();
      if (Platform.OS === 'android') {
        logCallEvent('ANDROID_FOREGROUND_SERVICE_CHECK', {
          callId: call.id,
          phase: 'incoming_ringing',
        });
        if (notifyNative) {
          // Keep one native full-screen call notification alive until the call
          // is answered, rejected or ended. It owns the looping system ringtone.
          showFullScreenIncomingCallNotification({
            call_id: call.id,
            caller_id: call.caller_id,
            caller_name: call.caller_name,
            conversation_id: call.conversation_id,
            mode: call.mode,
          }).catch(() => {});
        }
      } else if (!nativeIosCall) {
        import('./sounds').then((s) => s.startRingtone(0.85)).catch(() => {});
      }
    },
    [user?.id, startVibration, guardCallActionsAfterUnlock],
  );

  const handleNativeCallAction = useCallback(
    async (call: IncomingCallPayload): Promise<boolean> => {
      if (!call.action) return false;
      dismissedCallIdsRef.current.add(call.id);
      if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
      await clearPendingIncomingCall(call.id).catch(() => {});
      await clearActiveCallState(call.id).catch(() => {});
      await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
      locallyAcceptedCallIdsRef.current.add(call.id);
      await markCallLocallyAccepted(call.id).catch(() => {});
      setIncoming((current) => (current?.id === call.id ? null : current));
      stopVibration();
      import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
      if (call.action === 'decline') {
        await cacheTerminatedCallId(call.id, 'DECLINED').catch(() => {});
        await callManager.declineCall(call.id).catch(() => {});
        return true;
      }
      await callManager.acceptCall(call.id).catch(() => {});
      await saveActiveCallState({
        activeCallId: call.id,
        callStatus: 'CONNECTING',
        callerId: call.caller_id,
        conversationId: call.conversation_id,
        mode: call.mode,
      }).catch(() => {});
      router.replace(
        `/call/${call.id}?role=callee&conversation_id=${call.conversation_id}&caller_id=${call.caller_id}`,
      );
      return true;
    },
    [router, stopVibration],
  );

  useEffect(() => {
    callManager.configure({
      userId: user?.id,
      router,
      isIncomingUiVisible: (callId: string) =>
        incomingCallIdRef.current === callId || incomingRef.current?.id === callId,
      restoreIncomingUi: (call, options) => {
        dismissedCallIdsRef.current.delete(call.id);
        showIncoming(call, options);
      },
      restoreActiveCallUi: (call, status, reason) => {
        dismissedCallIdsRef.current.add(call.id);
        if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
        setIncoming((current) => (current?.id === call.id ? null : current));
        clearPendingIncomingCall(call.id).catch(() => {});
        cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
        stopVibration();
        import('./sounds').then((sounds) => sounds.stopRingtone()).catch(() => {});
        if (Platform.OS === 'android') {
          logCallEvent('ANDROID_FOREGROUND_SERVICE_CHECK', {
            callId: call.id,
            phase: status,
            reason,
          });
          startActiveCallService(call.id, call.caller_name).catch(() => {});
        }
        const role = call.caller_id === user?.id ? 'caller' : 'callee';
        const href = `/call/${call.id}?role=${role}&conversation_id=${call.conversation_id}&caller_id=${call.caller_id}`;
        if (!pathnameRef.current.includes(`/call/${call.id}`)) {
          router.replace(href);
        }
      },
      clearCallUi: (callId, reason) => {
        const cid = callId || incomingCallIdRef.current || incomingRef.current?.id || null;
        if (cid) dismissedCallIdsRef.current.add(cid);
        if (!cid || incomingCallIdRef.current === cid) incomingCallIdRef.current = null;
        setIncoming((current) => (!cid || current?.id === cid ? null : current));
        if (cid) {
          clearPendingIncomingCall(cid).catch(() => {});
          cancelFullScreenIncomingCallNotification(cid).catch(() => {});
          try {
            endIncomingCallNative(cid);
          } catch {
            /* ignore */
          }
        }
        if (Platform.OS === 'android') stopActiveCallService().catch(() => {});
        stopVibration();
        import('./sounds').then((sounds) => sounds.stopRingtone()).catch(() => {});
        logCallEvent('LOCAL_CALL_STATE_CLEARED', {
          reason,
          callId: cid,
          source: 'ui_clear',
        });
      },
    });
  }, [user?.id, router, showIncoming, stopVibration]);

  const cleanupTerminalCall = useCallback(
    (callId: string | null | undefined, status: string, reason: string) => {
      const cid = callId || incomingCallIdRef.current || incomingRef.current?.id || null;
      if (cid) {
        dismissedCallIdsRef.current.add(cid);
        cacheTerminatedCallId(cid, status).catch(() => {});
      }
      if (!cid || incomingCallIdRef.current === cid) incomingCallIdRef.current = null;
      setIncoming((current) => (!cid || current?.id === cid ? null : current));
      if (cid) {
        clearPendingIncomingCall(cid).catch(() => {});
        clearActiveCallState(cid).catch(() => {});
        cancelFullScreenIncomingCallNotification(cid).catch(() => {});
        try {
          endIncomingCallNative(cid);
        } catch {
          /* ignore */
        }
      }
      if (Platform.OS === 'android') stopActiveCallService().catch(() => {});
      stopVibration();
      import('./sounds').then((sounds) => sounds.stopRingtone()).catch(() => {});
      logCallEvent('LOCAL_CALL_STATE_CLEARED', {
        reason,
        callId: cid,
        status,
        source: 'terminal_cleanup',
      });
    },
    [stopVibration],
  );

  const onMessage = useCallback(
    (msg: any) => {
      if (msg?.type === 'call:incoming' && msg.data && msg.data.caller_id !== user?.id) {
        callManager.handleIncomingCallInvite(msg.data, 'ws_call_invite').catch(() => {
          showIncoming(msg.data);
        });
      } else if (msg?.type === 'call:accepted') {
        const cid = msg.call_id ?? msg.data?.call_id;
        const acceptedBy = msg.from ?? msg.data?.accepted_by;
        // Stop duplicate ringing on another device using the callee account.
        if (cid && acceptedBy === user?.id) {
          const locallyAccepted = locallyAcceptedCallIdsRef.current.has(cid);
          dismissedCallIdsRef.current.add(cid);
          if (incomingCallIdRef.current === cid) incomingCallIdRef.current = null;
          setIncoming((cur) => (cur?.id === cid ? null : cur));
          clearPendingIncomingCall(cid).catch(() => {});
          if (!locallyAccepted) clearActiveCallState(cid).catch(() => {});
          cancelFullScreenIncomingCallNotification(cid).catch(() => {});
          stopVibration();
          import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
          if (!locallyAccepted) {
            try {
              endIncomingCallNative(cid);
            } catch {
              /* ignore */
            }
          }
        }
      } else if (
        msg?.type === 'call:ended' ||
        msg?.type === 'call:declined' ||
        msg?.type === 'call:cancelled' ||
        msg?.type === 'call:timeout' ||
        msg?.type === 'call:failed' ||
        msg?.event === 'call.declined' ||
        msg?.event === 'call.cancelled' ||
        msg?.event === 'call.ended' ||
        msg?.event === 'call.timeout' ||
        msg?.event === 'call.failed'
      ) {
        cleanupTerminalCall(
          msg.data?.call_id || msg.call_id,
          String(msg.data?.status || 'ended'),
          'ws_call_ended',
        );
      } else if (msg?.type === 'call:cancel' || msg?.type === 'call:end') {
        // Caller hung up before we accepted — close modal
        cleanupTerminalCall(
          msg.call_id,
          msg.type === 'call:cancel' ? 'cancelled' : 'ended',
          'ws_legacy_terminal_event',
        );
      }
    },
    [user?.id, showIncoming, cleanupTerminalCall, stopVibration]
  );

  // Single WebSocket connection — capture the send() handle so reject() can
  // immediately notify the caller without waiting for an HTTP roundtrip.
  const { send: wsSend } = useWebSocket(onMessage, !!user);

  // Bind the WS send handle + router to the CallKeep bridge so that native
  // CallKeep events (Answer/Decline on the lockscreen) can drive the same
  // WebRTC flow. One socket, no duplicate connections.
  useEffect(() => {
    if (!user) return;
    bindCallKeepBridge({ router, wsSend });
    return subscribeToCallKeepActions(({ callId, action }) => {
      if (action === 'answer') {
        locallyAcceptedCallIdsRef.current.add(callId);
        markCallLocallyAccepted(callId).catch(() => {});
        const current = incomingRef.current;
        if (current?.id === callId) {
          saveActiveCallState({
            activeCallId: current.id,
            callStatus: 'CONNECTING',
            callerId: current.caller_id,
            conversationId: current.conversation_id,
            mode: current.mode,
          }).catch(() => {});
        }
      }
      dismissedCallIdsRef.current.add(callId);
      if (incomingCallIdRef.current === callId) incomingCallIdRef.current = null;
      setIncoming((current) => (current?.id === callId ? null : current));
      clearPendingIncomingCall(callId).catch(() => {});
      stopVibration();
      import('./sounds').then((sounds) => sounds.stopRingtone()).catch(() => {});
    });
  }, [user, router, stopVibration, wsSend]);

  useEffect(() => {
    if (!user) return;
    let mounted = true;

    const consumeNativeIntent = async (): Promise<boolean> => {
      const nativeCall = normalizeIncomingCallPayload(await consumeInitialNativeIncomingCall());
      if (mounted && nativeCall) {
        if (!(await handleNativeCallAction(nativeCall))) {
          showIncoming(nativeCall, { notifyNative: false });
        }
        return true;
      }
      return false;
    };

    const restorePendingCall = async () => {
      const call = await getPendingIncomingCall();
      if (!mounted || !call || dismissedCallIdsRef.current.has(call.id)) return;

      const receivedAt = Number(call.received_at || 0);
      if (receivedAt > 0 && Date.now() - receivedAt > PENDING_CALL_MAX_AGE_MS) {
        dismissedCallIdsRef.current.add(call.id);
        if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
        setIncoming((current) => (current?.id === call.id ? null : current));
        await clearPendingIncomingCall(call.id).catch(() => {});
        await clearActiveCallState(call.id).catch(() => {});
        await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
        return;
      }

      try {
        const { data } = await api.get(`/calls/${call.id}`);
        const status = String(data?.status || '').toLowerCase();
        if (data?.ended_at || TERMINAL_CALL_STATUSES.has(status) || status === 'answered') {
          if (data?.ended_at || TERMINAL_CALL_STATUSES.has(status)) {
            await cacheTerminatedCallId(call.id, status || 'ENDED').catch(() => {});
            try {
              endIncomingCallNative(call.id);
            } catch {
              /* ignore */
            }
          }
          dismissedCallIdsRef.current.add(call.id);
          if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
          setIncoming((current) => (current?.id === call.id ? null : current));
          await clearPendingIncomingCall(call.id).catch(() => {});
          await clearActiveCallState(call.id).catch(() => {});
          await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
          return;
        }
      } catch (error: any) {
        if (error?.response?.status === 403 || error?.response?.status === 404) {
          dismissedCallIdsRef.current.add(call.id);
          if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
          setIncoming((current) => (current?.id === call.id ? null : current));
          await clearPendingIncomingCall(call.id).catch(() => {});
          await clearActiveCallState(call.id).catch(() => {});
          await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
          return;
        }
      }

      if (mounted) showIncoming(call, { persist: false, notifyNative: false });
    };

    const recoverActiveIncomingCall = async (reason: string) => {
      if (Platform.OS === 'web' || AppState.currentState !== 'active') return;
      await callManager.handleAppForeground(reason);
    };

    const restore = async (reason = 'provider_restore') => {
      const handledNativeIntent = await consumeNativeIntent();
      if (!handledNativeIntent) await restorePendingCall();
      await recoverActiveIncomingCall(reason);
    };

    restore('provider_mount').catch(() => {});
    const unsubIncoming = subscribeToIncomingCallEvents((call) => {
      callManager.handlePushReceived(call).catch(() => showIncoming(call));
    });
    const unsubControl = subscribeToCallControlEvents(({ call_id, action }) => {
      if (!call_id) return;
      const normalizedAction = String(action || '').toLowerCase();
      (async () => {
        const locallyAccepted =
          normalizedAction === 'accepted' &&
          (locallyAcceptedCallIdsRef.current.has(call_id) ||
            Boolean(await wasCallLocallyAccepted(call_id)));
        const preserveAcceptedState = normalizedAction === 'accepted' && locallyAccepted;
        logCallEvent('CALL_CONTROL_EVENT_RECEIVED', {
          callId: call_id,
          action: normalizedAction,
          locallyAccepted,
          preserveAcceptedState,
        });
        if (normalizedAction !== 'accepted') {
          cacheTerminatedCallId(call_id, normalizedAction || 'ENDED').catch(() => {});
        }
        dismissedCallIdsRef.current.add(call_id);
        if (incomingCallIdRef.current === call_id) incomingCallIdRef.current = null;
        setIncoming((current) => (current?.id === call_id ? null : current));
        clearPendingIncomingCall(call_id).catch(() => {});
        if (!preserveAcceptedState) {
          clearActiveCallState(call_id).catch(() => {});
        }
        cancelFullScreenIncomingCallNotification(call_id).catch(() => {});
        stopVibration();
        import('./sounds').then((sounds) => sounds.stopRingtone()).catch(() => {});
        if (!preserveAcceptedState) {
          try {
            endIncomingCallNative(call_id);
          } catch {
            /* ignore */
          }
        }
      })().catch(() => {});
    });
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        callManager.handleAppBackground();
      }
      if (state === 'active') {
        logCallEvent('APP_STATE_CHANGED_ACTIVE', {
          source: 'app_state',
          appState: state,
        });
        // The final passcode/keypad touch can otherwise land on a newly
        // rendered Answer/Decline button as the OS dismisses its lock screen.
        guardCallActionsAfterUnlock();
        restore('app_state_active')
          .catch(() => {})
          .finally(() => {
            logCallEvent('WEBSOCKET_RECONNECT_AFTER_RESUME', {
              source: 'app_state',
            });
          });
      }
    });
    // Android delivers notification action taps through MainActivity.onNewIntent.
    // The app can already be active, in which case AppState does not change.
    // Poll the one-shot native intent slot so Answer/Decline is never missed.
    const nativeActionTimer = setInterval(() => {
      consumeNativeIntent().catch(() => {});
      consumeAndroidResumeEvent()
        .then((event) => {
          if (!event) return;
          logCallEvent('APP_STATE_CHANGED_ACTIVE', {
            source: 'activity_resume',
            incomingWindowActive: Boolean(event.incoming_call_window_active),
          });
          guardCallActionsAfterUnlock();
          callManager
            .handleAppForeground('activity_resume')
            .catch(() => {})
            .finally(() => {
              logCallEvent('WEBSOCKET_RECONNECT_AFTER_RESUME', {
                source: 'activity_resume',
              });
            });
        })
        .catch(() => {});
    }, 500);
    return () => {
      mounted = false;
      unsubIncoming();
      unsubControl();
      sub.remove();
      clearInterval(nativeActionTimer);
    };
  }, [
    user,
    showIncoming,
    handleNativeCallAction,
    stopVibration,
    guardCallActionsAfterUnlock,
  ]);

  // Stop vibration AND ringtone whenever incoming clears
  useEffect(() => {
    if (!incoming) {
      stopVibration();
      import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
    }
  }, [incoming, stopVibration]);

  useEffect(() => {
    if (!incoming) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [incoming, pulse]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (actionGuardTimerRef.current) clearTimeout(actionGuardTimerRef.current);
      stopVibration();
      import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
    };
  }, [stopVibration]);

  const accept = async () => {
    if (!incoming) return;
    const call = incoming;
    dismissedCallIdsRef.current.add(call.id);
    incomingCallIdRef.current = null;
    setIncoming(null);
    locallyAcceptedCallIdsRef.current.add(call.id);
    await markCallLocallyAccepted(call.id).catch(() => {});
    await saveActiveCallState({
      activeCallId: call.id,
      callStatus: 'CONNECTING',
      callerId: call.caller_id,
      conversationId: call.conversation_id,
      mode: call.mode,
    }).catch(() => {});
    clearPendingIncomingCall(call.id).catch(() => {});
    cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
    stopVibration();
    if (Platform.OS === 'ios') {
      // Keep CallKit and its AVAudioSession alive through device unlock.
      await answerIncomingCallNative(call.id).catch(() => false);
    } else {
      try {
        endIncomingCallNative(call.id);
      } catch {
        /* ignore */
      }
    }
    try {
      await callManager.acceptCall(call.id);
    } catch {
      /* ignore */
    }
    router.replace(`/call/${call.id}?role=callee&conversation_id=${call.conversation_id}&caller_id=${call.caller_id}`);
  };

  const reject = async (source: 'button' | 'modal_request_close' = 'button') => {
    if (!incoming) return;
    const call = incoming;
    const guardRemainingMs = actionGuardUntilRef.current - Date.now();
    if (Platform.OS !== 'web' && source === 'button' && guardRemainingMs > 0) {
      api.post(`/calls/${call.id}/diag`, {
        reason: 'incoming_call_action_ignored_after_unlock',
        status: 'ringing',
        source,
        app_state: AppState.currentState,
        guard_remaining_ms: guardRemainingMs,
      }).catch(() => {});
      return;
    }
    api.post(`/calls/${call.id}/diag`, {
      reason: 'incoming_call_reject_requested',
      status: 'ringing',
      source,
      app_state: AppState.currentState,
    }).catch(() => {});
    dismissedCallIdsRef.current.add(call.id);
    incomingCallIdRef.current = null;
    setIncoming(null);
    clearPendingIncomingCall(call.id).catch(() => {});
    clearActiveCallState(call.id).catch(() => {});
    cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
    stopVibration();
    // Clear any native CallKeep call that's still showing for this id.
    try {
      endIncomingCallNative(call.id);
    } catch {
      /* ignore */
    }
    // 1) Immediately notify the caller over the existing WebSocket so their
    //    /call/[id] screen reacts in real time (no HTTP roundtrip latency).
    try {
      wsSend({
        type: 'call:reject',
        to: call.caller_id,
        call_id: call.id,
        conversation_id: call.conversation_id,
      });
    } catch {
      /* ignore — fall through to HTTP */
    }
    // 2) Server records the rejection + also broadcasts call:ended as a backup
    //    so any other devices (e.g. the caller using a second phone) clean up.
    try {
      await callManager.declineCall(call.id);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      {children}
      <Modal
        visible={!!incoming}
        transparent={false}
        animationType="fade"
        onRequestClose={() => {
          // iOS can request a modal close during system UI transitions. Only
          // the explicit red button may reject an iOS call.
          if (Platform.OS !== 'ios') reject('modal_request_close');
        }}
      >
        <View style={styles.screen}>
          <View style={styles.topGlow} />
          <View style={styles.bottomGlow} />
          <View style={styles.header}>
            <View style={styles.securePill}>
              <ShieldCheck color={theme.colors.primary} size={14} strokeWidth={2.5} />
              <Text style={styles.secureText}>Secure ghostel.app call</Text>
            </View>
            <Text style={styles.statusText}>Incoming audio call</Text>
          </View>

          <View style={styles.callerArea}>
            <View style={styles.avatarStage}>
              <Animated.View
                style={[
                  styles.pulseRing,
                  {
                    opacity: pulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.42, 0],
                    }),
                    transform: [
                      {
                        scale: pulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.88, 1.26],
                        }),
                      },
                    ],
                  },
                ]}
              />
              <Animated.View
                style={[
                  styles.pulseRingSmall,
                  {
                    opacity: pulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.32, 0.06],
                    }),
                    transform: [
                      {
                        scale: pulse.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.94, 1.1],
                        }),
                      },
                    ],
                  },
                ]}
              />
            <Avatar
              name={incoming?.caller_name || 'Unknown'}
                size={124}
              color={theme.colors.primary}
            />
            </View>
            <Text style={styles.name} numberOfLines={2}>
              {incoming?.caller_name || 'Caller'}
            </Text>
            <Text style={styles.sub}>is calling you in ghostel.app</Text>
          </View>

          <View style={styles.actionsWrap}>
            <View style={styles.actions}>
              <TouchableOpacity
                testID="reject-call-button"
                onPress={() => reject('button')}
                disabled={callActionsGuarded}
                accessibilityState={{ disabled: callActionsGuarded }}
                style={[
                  styles.actionBtn,
                  styles.rejectBtn,
                  callActionsGuarded && styles.guardedAction,
                ]}
                activeOpacity={0.86}
              >
                <PhoneOff color="#fff" size={30} strokeWidth={2.4} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="accept-call-button"
                onPress={accept}
                disabled={callActionsGuarded}
                accessibilityState={{ disabled: callActionsGuarded }}
                style={[
                  styles.actionBtn,
                  styles.acceptBtn,
                  callActionsGuarded && styles.guardedAction,
                ]}
                activeOpacity={0.86}
              >
                <Phone color="#fff" size={30} strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
            <View style={styles.actionLabels}>
              <Text style={styles.actionLabel}>Decline</Text>
              <Text style={styles.actionLabel}>Answer</Text>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 72,
    paddingBottom: 52,
    overflow: 'hidden',
  },
  topGlow: {
    position: 'absolute',
    top: -120,
    left: -80,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: '#004b66',
    opacity: 0.55,
  },
  bottomGlow: {
    position: 'absolute',
    right: -90,
    bottom: -110,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#00533f',
    opacity: 0.5,
  },
  header: {
    alignItems: 'center',
    width: '100%',
  },
  securePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: '#101c28',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secureText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 18,
  },
  callerArea: {
    alignItems: 'center',
    width: '100%',
  },
  avatarStage: {
    width: 190,
    height: 190,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 30,
  },
  pulseRing: {
    position: 'absolute',
    width: 190,
    height: 190,
    borderRadius: 95,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: '#00384d',
  },
  pulseRingSmall: {
    position: 'absolute',
    width: 156,
    height: 156,
    borderRadius: 78,
    backgroundColor: theme.colors.primaryDark,
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 38,
  },
  sub: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    marginTop: 10,
    textAlign: 'center',
  },
  actionsWrap: {
    width: '100%',
    maxWidth: 360,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 26,
  },
  actionBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  rejectBtn: {
    backgroundColor: theme.colors.error,
  },
  acceptBtn: {
    backgroundColor: theme.colors.success,
  },
  guardedAction: {
    opacity: 0.55,
  },
  actionLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 38,
    marginTop: 14,
  },
  actionLabel: {
    width: 76,
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
});
