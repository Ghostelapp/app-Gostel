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
import { useRouter } from 'expo-router';
import { Phone, PhoneOff, ShieldCheck } from 'lucide-react-native';
import Avatar from './Avatar';
import { useWebSocket } from './ws';
import { useAuth } from './auth';
import { api } from './api';
import { theme } from './theme';
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
  normalizeIncomingCallPayload,
  savePendingIncomingCall,
  subscribeToIncomingCallEvents,
  type IncomingCallPayload,
} from './incomingCallStore';
import {
  cancelFullScreenIncomingCallNotification,
  consumeInitialNativeIncomingCall,
  showFullScreenIncomingCallNotification,
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
const TERMINAL_CALL_STATUSES = new Set(['ended', 'rejected', 'cancelled', 'missed']);

export default function IncomingCallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const vibratingRef = useRef(false);
  const incomingCallIdRef = useRef<string | null>(null);
  const dismissedCallIdsRef = useRef(new Set<string>());
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

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
    (
      call: IncomingCallPayload,
      { persist = true, notifyNative = true }: ShowIncomingOptions = {},
    ) => {
      if (call.caller_id === user?.id || dismissedCallIdsRef.current.has(call.id)) return;
      if (persist) savePendingIncomingCall(call).catch(() => {});
      if (Platform.OS === 'ios' && AppState.currentState !== 'active') {
        displayIncomingCallNative({
          callId: call.id,
          conversationId: call.conversation_id,
          callerId: call.caller_id,
          callerName: call.caller_name,
        }).catch(() => {});
        return;
      }
      if (incomingCallIdRef.current === call.id) return;
      incomingCallIdRef.current = call.id;
      setIncoming((current) => (current?.id === call.id ? current : call));
      const nativeIosCall = isIncomingCallNativeDisplayed(call.id);
      if (!nativeIosCall) startVibration();
      if (Platform.OS === 'android') {
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
    [user?.id, startVibration],
  );

  const handleNativeCallAction = useCallback(
    async (call: IncomingCallPayload): Promise<boolean> => {
      if (!call.action) return false;
      dismissedCallIdsRef.current.add(call.id);
      if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
      await clearPendingIncomingCall(call.id).catch(() => {});
      await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
      setIncoming((current) => (current?.id === call.id ? null : current));
      stopVibration();
      import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
      if (call.action === 'decline') {
        await api.post(`/calls/${call.id}/end`).catch(() => {});
        return true;
      }
      await api.post(`/calls/${call.id}/accept`).catch(() => {});
      router.push(
        `/call/${call.id}?role=callee&conversation_id=${call.conversation_id}&caller_id=${call.caller_id}`,
      );
      return true;
    },
    [router, stopVibration],
  );

  const onMessage = useCallback(
    (msg: any) => {
      if (msg?.type === 'call:incoming' && msg.data && msg.data.caller_id !== user?.id) {
        showIncoming(msg.data);
      } else if (msg?.type === 'call:ended') {
        const cid = msg.data?.call_id;
        if (cid) dismissedCallIdsRef.current.add(cid);
        if (incomingCallIdRef.current === cid) incomingCallIdRef.current = null;
        setIncoming((cur) => (cur && cur.id === cid ? null : cur));
        clearPendingIncomingCall(cid).catch(() => {});
        // Also clear any pending native CallKeep screen (e.g. caller hung up
        // while OS-level call screen was visible on lockscreen).
        if (cid) {
          cancelFullScreenIncomingCallNotification(cid).catch(() => {});
          try {
            endIncomingCallNative(cid);
          } catch {
            /* ignore */
          }
        }
      } else if (msg?.type === 'call:cancel' || msg?.type === 'call:end') {
        // Caller hung up before we accepted — close modal
        if (msg.call_id) dismissedCallIdsRef.current.add(msg.call_id);
        if (incomingCallIdRef.current === msg.call_id) incomingCallIdRef.current = null;
        setIncoming((cur) => (cur && cur.id === msg.call_id ? null : cur));
        clearPendingIncomingCall(msg.call_id).catch(() => {});
        if (msg.call_id) {
          cancelFullScreenIncomingCallNotification(msg.call_id).catch(() => {});
          try {
            endIncomingCallNative(msg.call_id);
          } catch {
            /* ignore */
          }
        }
      }
    },
    [user?.id, showIncoming]
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
    return subscribeToCallKeepActions(({ callId }) => {
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
        await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
        return;
      }

      try {
        const { data } = await api.get(`/calls/${call.id}`);
        const status = String(data?.status || '').toLowerCase();
        if (data?.ended_at || TERMINAL_CALL_STATUSES.has(status) || status === 'answered') {
          dismissedCallIdsRef.current.add(call.id);
          if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
          setIncoming((current) => (current?.id === call.id ? null : current));
          await clearPendingIncomingCall(call.id).catch(() => {});
          await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
          return;
        }
      } catch (error: any) {
        if (error?.response?.status === 403 || error?.response?.status === 404) {
          dismissedCallIdsRef.current.add(call.id);
          if (incomingCallIdRef.current === call.id) incomingCallIdRef.current = null;
          setIncoming((current) => (current?.id === call.id ? null : current));
          await clearPendingIncomingCall(call.id).catch(() => {});
          await cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
          return;
        }
      }

      if (mounted) showIncoming(call, { persist: false, notifyNative: false });
    };

    const recoverActiveIncomingCall = async () => {
      if (Platform.OS !== 'ios' || AppState.currentState !== 'active') return;
      try {
        const { data } = await api.get('/calls/active-incoming');
        const call = normalizeIncomingCallPayload(data);
        if (!mounted || !call || call.caller_id === user.id) return;

        // The backend is authoritative here. A lifecycle-only CallKit event
        // must not permanently suppress a call that is still ringing.
        dismissedCallIdsRef.current.delete(call.id);
        showIncoming(call, { persist: true, notifyNative: false });
      } catch {
        /* pending storage and WebSocket delivery remain available */
      }
    };

    const restore = async () => {
      const handledNativeIntent = await consumeNativeIntent();
      if (!handledNativeIntent) {
        await restorePendingCall();
        await recoverActiveIncomingCall();
      }
    };

    restore().catch(() => {});
    const unsubIncoming = subscribeToIncomingCallEvents((call) => showIncoming(call));
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        restore().catch(() => {});
      } else if (Platform.OS === 'ios') {
        const current = incomingRef.current;
        if (current) {
          displayIncomingCallNative({
            callId: current.id,
            conversationId: current.conversation_id,
            callerId: current.caller_id,
            callerName: current.caller_name,
          }).catch(() => {});
          stopVibration();
          import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
        }
      }
    });
    // Android delivers notification action taps through MainActivity.onNewIntent.
    // The app can already be active, in which case AppState does not change.
    // Poll the one-shot native intent slot so Answer/Decline is never missed.
    const nativeActionTimer = setInterval(() => {
      consumeNativeIntent().catch(() => {});
    }, 500);
    return () => {
      mounted = false;
      unsubIncoming();
      sub.remove();
      clearInterval(nativeActionTimer);
    };
  }, [user, showIncoming, handleNativeCallAction, stopVibration]);

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
      await api.post(`/calls/${call.id}/accept`);
    } catch {
      /* ignore */
    }
    router.push(`/call/${call.id}?role=callee&conversation_id=${call.conversation_id}&caller_id=${call.caller_id}`);
  };

  const reject = async () => {
    if (!incoming) return;
    const call = incoming;
    dismissedCallIdsRef.current.add(call.id);
    incomingCallIdRef.current = null;
    setIncoming(null);
    clearPendingIncomingCall(call.id).catch(() => {});
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
      await api.post(`/calls/${call.id}/end`);
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
        onRequestClose={reject}
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
                onPress={reject}
                style={[styles.actionBtn, styles.rejectBtn]}
                activeOpacity={0.86}
              >
                <PhoneOff color="#fff" size={30} strokeWidth={2.4} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="accept-call-button"
                onPress={accept}
                style={[styles.actionBtn, styles.acceptBtn]}
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
