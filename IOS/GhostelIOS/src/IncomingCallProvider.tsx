import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Modal,
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
import { bindCallKeepBridge, endIncomingCallNative } from './callkeep';
import {
  clearPendingIncomingCall,
  consumePendingIncomingCall,
  normalizeIncomingCallPayload,
  subscribeToIncomingCallEvents,
  type IncomingCallPayload,
} from './incomingCallStore';
import {
  cancelFullScreenIncomingCallNotification,
  consumeInitialNativeIncomingCall,
} from './androidCallNotification';

type IncomingCall = {
  id: string;
  caller_id: string;
  caller_name: string;
  conversation_id: string;
  mode: string;
};

// Vibration pattern: 0ms wait, vibrate 1s, pause 1s — looped
const VIBRATION_PATTERN = [0, 1000, 1000];

export default function IncomingCallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const vibratingRef = useRef(false);
  const pulse = useRef(new Animated.Value(0)).current;

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
    (call: IncomingCallPayload) => {
      if (call.caller_id === user?.id) return;
      setIncoming((current) => (current?.id === call.id ? current : call));
      startVibration();
      import('./sounds').then((s) => s.startRingtone(0.85)).catch(() => {});
    },
    [user?.id, startVibration],
  );

  const onMessage = useCallback(
    (msg: any) => {
      if (msg?.type === 'call:incoming' && msg.data && msg.data.caller_id !== user?.id) {
        showIncoming(msg.data);
      } else if (msg?.type === 'call:ended') {
        const cid = msg.data?.call_id;
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
  }, [user, router, wsSend]);

  useEffect(() => {
    if (!user) return;
    let mounted = true;
    const consume = async () => {
      const call = await consumePendingIncomingCall();
      if (mounted && call) {
        showIncoming(call);
        return;
      }
      const nativeCall = normalizeIncomingCallPayload(await consumeInitialNativeIncomingCall());
      if (mounted && nativeCall) showIncoming(nativeCall);
    };
    consume().catch(() => {});
    const unsubIncoming = subscribeToIncomingCallEvents((call) => showIncoming(call));
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        consume().catch(() => {});
      }
    });
    return () => {
      mounted = false;
      unsubIncoming();
      sub.remove();
    };
  }, [user, showIncoming]);

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
    setIncoming(null);
    clearPendingIncomingCall(call.id).catch(() => {});
    cancelFullScreenIncomingCallNotification(call.id).catch(() => {});
    stopVibration();
    // If the OS already showed a native CallKeep screen for this call (e.g.
    // from a background push), clear it now — we're handling it in-app.
    try {
      endIncomingCallNative(call.id);
    } catch {
      /* ignore */
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
              <Text style={styles.secureText}>Secure Ghostel call</Text>
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
            <Text style={styles.sub}>is calling you in Ghostel</Text>
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
