import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Vibration } from 'react-native';
import { useRouter } from 'expo-router';
import { Phone, PhoneOff, ShieldCheck } from 'lucide-react-native';
import Avatar from './Avatar';
import { useWebSocket } from './ws';
import { useAuth } from './auth';
import { api } from './api';
import { theme } from './theme';
import { bindCallKeepBridge, endIncomingCallNative } from './callkeep';

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

  const onMessage = useCallback(
    (msg: any) => {
      if (msg?.type === 'call:incoming' && msg.data && msg.data.caller_id !== user?.id) {
        setIncoming(msg.data);
        startVibration();
        // Start a LOOPING in-app ringtone routed through the main speaker.
        // It plays until accept/reject/end clears `incoming`.
        import('./sounds').then((s) => s.startRingtone(0.85)).catch(() => {});
      } else if (msg?.type === 'call:ended') {
        const cid = msg.data?.call_id;
        setIncoming((cur) => (cur && cur.id === cid ? null : cur));
        // Also clear any pending native CallKeep screen (e.g. caller hung up
        // while OS-level call screen was visible on lockscreen).
        if (cid) {
          try {
            endIncomingCallNative(cid);
          } catch {
            /* ignore */
          }
        }
      } else if (msg?.type === 'call:cancel' || msg?.type === 'call:end') {
        // Caller hung up before we accepted — close modal
        setIncoming((cur) => (cur && cur.id === msg.call_id ? null : cur));
        if (msg.call_id) {
          try {
            endIncomingCallNative(msg.call_id);
          } catch {
            /* ignore */
          }
        }
      }
    },
    [user?.id, startVibration]
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

  // Stop vibration AND ringtone whenever incoming clears
  useEffect(() => {
    if (!incoming) {
      stopVibration();
      import('./sounds').then((s) => s.stopRingtone()).catch(() => {});
    }
  }, [incoming, stopVibration]);

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
        transparent
        animationType="fade"
        onRequestClose={reject}
      >
        <View style={styles.bg}>
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <ShieldCheck color={theme.colors.primary} size={12} strokeWidth={2.5} />
              <Text style={styles.statusText}>Encrypted incoming call</Text>
            </View>
            <Avatar
              name={incoming?.caller_name || 'Unknown'}
              size={84}
              color={theme.colors.primary}
            />
            <Text style={styles.name}>{incoming?.caller_name || 'Caller'}</Text>
            <Text style={styles.sub}>is calling you…</Text>

            <View style={styles.actions}>
              <TouchableOpacity
                testID="reject-call-button"
                onPress={reject}
                style={[styles.actionBtn, { backgroundColor: theme.colors.error }]}
              >
                <PhoneOff color="#fff" size={22} strokeWidth={2.4} />
              </TouchableOpacity>
              <TouchableOpacity
                testID="accept-call-button"
                onPress={accept}
                style={[styles.actionBtn, { backgroundColor: theme.colors.success }]}
              >
                <Phone color="#fff" size={22} strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: '#000000bb',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
    marginBottom: 18,
  },
  statusText: { color: theme.colors.primary, fontSize: 11, fontWeight: '600' },
  name: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: '700', marginTop: 14 },
  sub: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 24, marginTop: 22 },
  actionBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
