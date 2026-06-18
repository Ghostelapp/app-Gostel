import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { ChevronLeft, CheckCircle2, AlertCircle, PhoneCall, Send } from 'lucide-react-native';
import { api, BASE_URL, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';
import { getAndroidCallCapabilities } from '../../src/androidCallNotification';

type CheckStatus = 'ok' | 'warn' | 'fail';
type CheckRow = {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

export default function CallDiagnosticsScreen() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [raw, setRaw] = useState<Record<string, any>>({});

  const summary = useMemo(() => {
    if (!checks.length) return 'Not run yet';
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warn = checks.filter((c) => c.status === 'warn').length;
    if (failed) return `${failed} failed, ${warn} warning`;
    if (warn) return `${warn} warning`;
    return 'All basic checks passed';
  }, [checks]);

  const runDiagnostics = useCallback(async () => {
    setRunning(true);
    const next: CheckRow[] = [];
    const diag: Record<string, any> = {
      platform: Platform.OS,
      app_version: Constants.expoConfig?.version || '',
      api_base_url: BASE_URL,
      at: new Date().toISOString(),
    };

    try {
      const started = Date.now();
      const { data } = await api.get('/');
      diag.api_ms = Date.now() - started;
      diag.api_health = data;
      next.push({
        key: 'api',
        label: 'Backend API',
        status: 'ok',
        detail: `${diag.api_ms} ms`,
      });
    } catch (e) {
      diag.api_error = formatApiErrorDetail(e);
      next.push({
        key: 'api',
        label: 'Backend API',
        status: 'fail',
        detail: diag.api_error,
      });
    }

    try {
      const Audio = await import('expo-audio');
      const mic = await Audio.getRecordingPermissionsAsync();
      diag.microphone = mic;
      next.push({
        key: 'microphone',
        label: 'Microphone permission',
        status: mic.granted ? 'ok' : 'fail',
        detail: mic.granted ? 'Granted' : 'Not granted',
      });
    } catch (e: any) {
      diag.microphone_error = String(e?.message || e);
      next.push({
        key: 'microphone',
        label: 'Microphone permission',
        status: 'warn',
        detail: 'Could not read permission state',
      });
    }

    try {
      const Notifications = await import('expo-notifications');
      const push = await Notifications.getPermissionsAsync();
      diag.notifications = push;
      next.push({
        key: 'notifications',
        label: 'Notification permission',
        status: push.granted ? 'ok' : 'warn',
        detail: push.granted ? 'Granted' : 'Not granted',
      });
    } catch (e: any) {
      diag.notifications_error = String(e?.message || e);
      next.push({
        key: 'notifications',
        label: 'Notification permission',
        status: 'warn',
        detail: 'Could not read permission state',
      });
    }

    try {
      const { data } = await api.get('/push/devices');
      const count = Number(data?.count || 0);
      diag.push_devices = data;
      next.push({
        key: 'push_devices',
        label: 'Registered push devices',
        status: count > 0 ? 'ok' : 'warn',
        detail: `${count} device(s)`,
      });
    } catch (e) {
      diag.push_devices_error = formatApiErrorDetail(e);
      next.push({
        key: 'push_devices',
        label: 'Registered push devices',
        status: 'warn',
        detail: diag.push_devices_error,
      });
    }

    try {
      const caps = await getAndroidCallCapabilities();
      diag.android_call_capabilities = caps;
      if (Platform.OS === 'android') {
        next.push({
          key: 'fullscreen',
          label: 'Full-screen call permission',
          status: caps?.fullScreenIntentAllowed ? 'ok' : 'warn',
          detail: caps ? (caps.fullScreenIntentAllowed ? 'Allowed' : 'Needs attention') : 'Unavailable',
        });
        next.push({
          key: 'battery',
          label: 'Battery background mode',
          status: caps?.batteryUnrestricted ? 'ok' : 'warn',
          detail: caps ? (caps.batteryUnrestricted ? 'Unrestricted' : 'May delay calls') : 'Unavailable',
        });
      }
    } catch (e: any) {
      diag.android_call_capabilities_error = String(e?.message || e);
    }

    try {
      const { getWebRTC } = require('../../src/webrtc');
      const WebRTC = getWebRTC();
      diag.webrtc_available = Boolean(WebRTC?.RTCPeerConnection && WebRTC?.mediaDevices?.getUserMedia);
      next.push({
        key: 'webrtc',
        label: 'WebRTC module',
        status: diag.webrtc_available ? 'ok' : 'fail',
        detail: diag.webrtc_available ? 'Available' : 'Missing native WebRTC',
      });
    } catch (e: any) {
      diag.webrtc_error = String(e?.message || e);
      next.push({
        key: 'webrtc',
        label: 'WebRTC module',
        status: 'fail',
        detail: 'Missing native WebRTC',
      });
    }

    setRaw(diag);
    setChecks(next);
    setRunning(false);
  }, []);

  const sendReport = async () => {
    if (!checks.length) {
      Alert.alert('Run diagnostics first', 'Run the checks before sending a report.');
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post('/support/report', {
        category: 'call',
        subject: 'Voice call diagnostics',
        message: `Voice call diagnostic report from the app.\nSummary: ${summary}`,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
        app_version: Constants.expoConfig?.version || '',
        diagnostics: raw,
      });
      Alert.alert('Report sent', data?.ticket_id ? `Ticket: ${data.ticket_id}` : 'Diagnostic report was saved.');
    } catch (e) {
      Alert.alert('Could not send report', formatApiErrorDetail(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft color={theme.colors.textPrimary} size={26} />
        </TouchableOpacity>
        <Text style={styles.title}>Voice diagnostics</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <PhoneCall color={theme.colors.primary} size={28} />
          <Text style={styles.heroTitle}>Check calls before changing code</Text>
          <Text style={styles.heroText}>
            This checks permissions, push registration and WebRTC availability without starting a real call.
          </Text>
          <Text style={styles.summary}>{summary}</Text>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={runDiagnostics} disabled={running}>
          {running ? <ActivityIndicator color={theme.colors.background} /> : <Text style={styles.primaryText}>Run diagnostics</Text>}
        </TouchableOpacity>

        {checks.map((item) => (
          <View key={item.key} style={styles.row}>
            {item.status === 'ok' ? (
              <CheckCircle2 color={theme.colors.success} size={20} />
            ) : (
              <AlertCircle color={item.status === 'fail' ? theme.colors.error : theme.colors.warning} size={20} />
            )}
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{item.label}</Text>
              <Text style={styles.rowDetail}>{item.detail}</Text>
            </View>
          </View>
        ))}

        {checks.length > 0 && (
          <TouchableOpacity style={styles.secondaryBtn} onPress={sendReport} disabled={sending}>
            {sending ? <ActivityIndicator color={theme.colors.primary} /> : <Send color={theme.colors.primary} size={18} />}
            <Text style={styles.secondaryText}>Send diagnostics to support</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  title: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '800' },
  scroll: { padding: 20, paddingBottom: 40 },
  hero: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
    marginBottom: 16,
  },
  heroTitle: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: '900' },
  heroText: { color: theme.colors.textMuted, lineHeight: 20 },
  summary: { color: theme.colors.primary, fontWeight: '800', marginTop: 4 },
  primaryBtn: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  primaryText: { color: theme.colors.background, fontWeight: '900' },
  row: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 10,
  },
  rowText: { flex: 1 },
  rowLabel: { color: theme.colors.textPrimary, fontWeight: '800' },
  rowDetail: { color: theme.colors.textMuted, marginTop: 3 },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  secondaryText: { color: theme.colors.primary, fontWeight: '900' },
});
