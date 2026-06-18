import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Bell, ChevronLeft, RefreshCcw, Smartphone, Trash2 } from 'lucide-react-native';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';

type PushDevice = {
  id: string;
  platform: string;
  token_type: string;
  token_prefix: string;
  token_suffix: string;
  device_model: string;
  os_version: string;
  source: string;
  registered_at: string;
};

export default function PushDevicesScreen() {
  const router = useRouter();
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [lastDiag, setLastDiag] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/push/devices');
      setDevices(Array.isArray(data?.devices) ? data.devices : []);
      setLastDiag(data?.last_diag || null);
    } catch (e) {
      Alert.alert('Could not load devices', formatApiErrorDetail(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const testPush = async (kind: 'message' | 'call') => {
    setBusy(`test-${kind}`);
    try {
      const { data } = await api.post('/push/test', { kind });
      Alert.alert(data?.sent ? 'Test sent' : 'Test result', JSON.stringify(data, null, 2).slice(0, 900));
    } catch (e) {
      Alert.alert('Push test failed', formatApiErrorDetail(e));
    } finally {
      setBusy(null);
    }
  };

  const removeDevice = (device: PushDevice) => {
    Alert.alert('Remove device?', `${device.device_model || device.platform || 'Device'} will stop receiving calls and push notifications for this account.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setBusy(device.id);
          try {
            await api.post('/push/unregister', { device_id: device.id });
            await load();
          } catch (e) {
            Alert.alert('Could not remove device', formatApiErrorDetail(e));
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  };

  const removeAll = () => {
    Alert.alert('Remove all devices?', 'This account will stop receiving push notifications until you open the app again on a phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove all',
        style: 'destructive',
        onPress: async () => {
          setBusy('all');
          try {
            await api.post('/push/unregister', {});
            await load();
          } catch (e) {
            Alert.alert('Could not remove devices', formatApiErrorDetail(e));
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft color={theme.colors.textPrimary} size={26} />
        </TouchableOpacity>
        <Text style={styles.title}>Push devices</Text>
        <TouchableOpacity onPress={load} style={styles.backBtn}>
          <RefreshCcw color={theme.colors.textPrimary} size={20} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.colors.primary} />}
      >
        <View style={styles.hero}>
          <Smartphone color={theme.colors.primary} size={28} />
          <Text style={styles.heroTitle}>{devices.length} registered device(s)</Text>
          <Text style={styles.heroText}>
            Remove old phones here if calls still ring after logout. Opening the app again will register the current phone.
          </Text>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => testPush('message')} disabled={!!busy}>
            {busy === 'test-message' ? <ActivityIndicator color={theme.colors.background} /> : <Bell color={theme.colors.background} size={17} />}
            <Text style={styles.actionText}>Test message</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => testPush('call')} disabled={!!busy}>
            {busy === 'test-call' ? <ActivityIndicator color={theme.colors.background} /> : <Bell color={theme.colors.background} size={17} />}
            <Text style={styles.actionText}>Test call</Text>
          </TouchableOpacity>
        </View>

        {devices.map((device) => (
          <View key={device.id} style={styles.card}>
            <View style={styles.cardTop}>
              <View style={styles.deviceIcon}>
                <Smartphone color={theme.colors.primary} size={20} />
              </View>
              <View style={styles.deviceMain}>
                <Text style={styles.deviceTitle}>{device.device_model || device.platform || 'Device'}</Text>
                <Text style={styles.deviceMeta}>
                  {[device.platform, device.token_type, device.source].filter(Boolean).join(' / ')}
                </Text>
              </View>
              <TouchableOpacity style={styles.trashBtn} onPress={() => removeDevice(device)} disabled={!!busy}>
                {busy === device.id ? <ActivityIndicator color={theme.colors.error} /> : <Trash2 color={theme.colors.error} size={18} />}
              </TouchableOpacity>
            </View>
            <Text style={styles.tokenText}>
              {device.token_prefix}...{device.token_suffix}
            </Text>
            {!!device.os_version && <Text style={styles.smallText}>OS: {device.os_version}</Text>}
            {!!device.registered_at && <Text style={styles.smallText}>Registered: {device.registered_at}</Text>}
          </View>
        ))}

        {!loading && devices.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No push devices</Text>
            <Text style={styles.emptyText}>Grant notification permission and reopen the app to register this phone.</Text>
          </View>
        )}

        {!!lastDiag && (
          <View style={styles.diag}>
            <Text style={styles.diagTitle}>Last push diagnostic</Text>
            <Text style={styles.diagText}>{JSON.stringify(lastDiag, null, 2).slice(0, 1200)}</Text>
          </View>
        )}

        {devices.length > 0 && (
          <TouchableOpacity style={styles.removeAll} onPress={removeAll} disabled={!!busy}>
            {busy === 'all' ? <ActivityIndicator color={theme.colors.error} /> : <Trash2 color={theme.colors.error} size={18} />}
            <Text style={styles.removeAllText}>Remove all devices</Text>
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
    marginBottom: 14,
  },
  heroTitle: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: '900' },
  heroText: { color: theme.colors.textMuted, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  actionBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  actionText: { color: theme.colors.background, fontWeight: '900' },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 12,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  deviceIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: 'rgba(0,217,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceMain: { flex: 1 },
  deviceTitle: { color: theme.colors.textPrimary, fontWeight: '900' },
  deviceMeta: { color: theme.colors.textMuted, marginTop: 3, fontSize: 12 },
  trashBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  tokenText: { color: theme.colors.primary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 12 },
  smallText: { color: theme.colors.textMuted, marginTop: 5, fontSize: 12 },
  empty: {
    padding: 24,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
  },
  emptyTitle: { color: theme.colors.textPrimary, fontWeight: '900', fontSize: 18 },
  emptyText: { color: theme.colors.textMuted, textAlign: 'center', marginTop: 6 },
  diag: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    marginTop: 4,
  },
  diagTitle: { color: theme.colors.textPrimary, fontWeight: '800', marginBottom: 6 },
  diagText: { color: theme.colors.textMuted, fontSize: 12 },
  removeAll: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  removeAllText: { color: theme.colors.error, fontWeight: '900' },
});
