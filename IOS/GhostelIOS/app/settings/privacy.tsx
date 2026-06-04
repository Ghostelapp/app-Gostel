import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, ShieldOff, History } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';

export default function PrivacyScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveCallHistory, setSaveCallHistory] = useState(true);
  const [blockedCount, setBlockedCount] = useState(0);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [privRes, blkRes] = await Promise.allSettled([
        api.get('/users/me/privacy'),
        api.get('/users/me/blocked'),
      ]);
      if (privRes.status === 'fulfilled') {
        setSaveCallHistory(Boolean(privRes.value.data?.save_call_history ?? true));
      }
      if (blkRes.status === 'fulfilled' && Array.isArray(blkRes.value.data)) {
        setBlockedCount(blkRes.value.data.length);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const toggleSaveCallHistory = async (next: boolean) => {
    setSaving(true);
    const prev = saveCallHistory;
    setSaveCallHistory(next);
    try {
      await api.patch('/users/me/privacy', { save_call_history: next });
    } catch (e) {
      setSaveCallHistory(prev);
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity
          testID="back-button"
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <ChevronLeft color={theme.colors.textPrimary} size={26} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('common.privacy')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.sectionLabel}>{t('profile.privacy_settings')}</Text>
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.rowIcon}>
                <History color={theme.colors.primary} size={18} strokeWidth={1.8} />
              </View>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>{t('profile.save_call_history')}</Text>
                <Text style={styles.rowSub}>{t('profile.save_call_history_desc')}</Text>
              </View>
              <Switch
                testID="toggle-save-call-history"
                value={saveCallHistory}
                onValueChange={toggleSaveCallHistory}
                disabled={saving}
                trackColor={{ false: '#3a3f47', true: theme.colors.primaryDark }}
                thumbColor={saveCallHistory ? theme.colors.primary : '#a0a4a8'}
              />
            </View>
          </View>

          <Text style={styles.sectionLabel}>{t('contacts.blocked_users')}</Text>
          <View style={styles.card}>
            <TouchableOpacity
              testID="open-blocked-users"
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => router.push('/settings/blocked-users')}
            >
              <View style={styles.rowIcon}>
                <ShieldOff color={theme.colors.warning} size={18} strokeWidth={1.8} />
              </View>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>{t('profile.blocked_users')}</Text>
                <Text style={styles.rowSub}>
                  {blockedCount === 0
                    ? t('contacts.no_contacts')
                    : `${blockedCount}`}
                </Text>
              </View>
              <ChevronRight color={theme.colors.textMuted} size={18} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  scroll: { padding: 16 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: 14,
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.8,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1 },
  rowLabel: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  rowSub: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
});
