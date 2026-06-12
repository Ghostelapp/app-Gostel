import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import {
  AlertCircle,
  BatteryCharging,
  Bell,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Images,
  Mic,
  PhoneCall,
  Settings,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../../src/theme';
import {
  getAndroidCallCapabilities,
  openAndroidSettings,
} from '../../src/androidCallNotification';

type PermissionState = 'granted' | 'denied' | 'unknown';
type PermissionKey = 'notifications' | 'microphone' | 'camera' | 'photos';

const initialPermissions: Record<PermissionKey, PermissionState> = {
  notifications: 'unknown',
  microphone: 'unknown',
  camera: 'unknown',
  photos: 'unknown',
};

export default function PermissionsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [permissions, setPermissions] = useState(initialPermissions);
  const [fullScreenAllowed, setFullScreenAllowed] = useState<boolean | null>(null);
  const [batteryUnrestricted, setBatteryUnrestricted] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<PermissionKey | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = { ...initialPermissions };
      const Notifications = await import('expo-notifications');
      const ImagePicker = await import('expo-image-picker');
      const Audio = await import('expo-audio');
      const [notifications, microphone, camera, photos, capabilities] =
        await Promise.all([
          Notifications.getPermissionsAsync(),
          Audio.getRecordingPermissionsAsync(),
          ImagePicker.getCameraPermissionsAsync(),
          Platform.OS === 'android'
            ? Promise.resolve({ granted: true })
            : ImagePicker.getMediaLibraryPermissionsAsync(),
          getAndroidCallCapabilities().catch(() => null),
        ]);
      next.notifications = notifications.granted ? 'granted' : 'denied';
      next.microphone = microphone.granted ? 'granted' : 'denied';
      next.camera = camera.granted ? 'granted' : 'denied';
      next.photos = photos.granted ? 'granted' : 'denied';
      setPermissions(next);
      setFullScreenAllowed(capabilities?.fullScreenIntentAllowed ?? null);
      setBatteryUnrestricted(capabilities?.batteryUnrestricted ?? null);
    } catch {
      // The system settings button remains available even if one native
      // permission module is unavailable in this build.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const requestPermission = async (key: PermissionKey) => {
    setRequesting(key);
    try {
      if (key === 'notifications') {
        const Notifications = await import('expo-notifications');
        const result = await Notifications.requestPermissionsAsync();
        if (result.granted) {
          const { registerPushNotificationsAsync } = await import('../../src/push');
          await registerPushNotificationsAsync();
        }
      } else if (key === 'microphone') {
        const Audio = await import('expo-audio');
        await Audio.requestRecordingPermissionsAsync();
      } else {
        const ImagePicker = await import('expo-image-picker');
        if (key === 'camera') await ImagePicker.requestCameraPermissionsAsync();
        else if (Platform.OS !== 'android') await ImagePicker.requestMediaLibraryPermissionsAsync();
      }
      await refresh();
    } finally {
      setRequesting(null);
    }
  };

  const statusText = (granted: boolean | null) => {
    if (granted === null) return t('permissions.not_available');
    return granted ? t('permissions.allowed') : t('permissions.needs_attention');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft color={theme.colors.textPrimary} size={26} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('permissions.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.intro}>{t('permissions.intro')}</Text>

          <Text style={styles.sectionLabel}>{t('permissions.app_access')}</Text>
          <View style={styles.card}>
            <PermissionRow
              icon={Bell}
              label={t('onboarding.perm_notifications')}
              value={statusText(permissions.notifications === 'granted')}
              granted={permissions.notifications === 'granted'}
              busy={requesting === 'notifications'}
              onPress={() => requestPermission('notifications')}
            />
            <Divider />
            <PermissionRow
              icon={Mic}
              label={t('onboarding.perm_microphone')}
              value={statusText(permissions.microphone === 'granted')}
              granted={permissions.microphone === 'granted'}
              busy={requesting === 'microphone'}
              onPress={() => requestPermission('microphone')}
            />
            <Divider />
            <PermissionRow
              icon={Camera}
              label={t('onboarding.perm_camera')}
              value={statusText(permissions.camera === 'granted')}
              granted={permissions.camera === 'granted'}
              busy={requesting === 'camera'}
              onPress={() => requestPermission('camera')}
            />
            <Divider />
            <PermissionRow
              icon={Images}
              label={t('onboarding.perm_photos')}
              value={statusText(permissions.photos === 'granted')}
              granted={permissions.photos === 'granted'}
              busy={requesting === 'photos'}
              onPress={() => requestPermission('photos')}
            />
          </View>

          {Platform.OS === 'android' ? (
            <>
              <Text style={styles.sectionLabel}>{t('permissions.calls_section')}</Text>
              <View style={styles.card}>
                <PermissionRow
                  icon={PhoneCall}
                  label={t('permissions.full_screen_calls')}
                  value={statusText(fullScreenAllowed)}
                  granted={fullScreenAllowed === true}
                  onPress={() => openAndroidSettings('fullScreen')}
                />
                <Divider />
                <PermissionRow
                  icon={Bell}
                  label={t('permissions.call_channel')}
                  value={t('permissions.open_settings')}
                  granted={fullScreenAllowed === true}
                  onPress={() => openAndroidSettings('callChannel')}
                />
                <Divider />
                <PermissionRow
                  icon={BatteryCharging}
                  label={t('permissions.battery')}
                  value={
                    batteryUnrestricted
                      ? t('permissions.unrestricted')
                      : t('permissions.optimized')
                  }
                  granted={batteryUnrestricted === true}
                  onPress={() => openAndroidSettings('battery')}
                />
              </View>
            </>
          ) : null}

          <TouchableOpacity
            style={styles.systemButton}
            onPress={() => {
              if (Platform.OS === 'android') {
                openAndroidSettings('app').catch(() => Linking.openSettings());
              } else {
                Linking.openSettings();
              }
            }}
          >
            <Settings color={theme.colors.primary} size={18} />
            <Text style={styles.systemButtonText}>{t('permissions.all_permissions')}</Text>
            <ChevronRight color={theme.colors.textMuted} size={18} />
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function PermissionRow({
  icon: Icon,
  label,
  value,
  granted,
  busy,
  onPress,
}: {
  icon: any;
  label: string;
  value: string;
  granted: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.icon}>
        <Icon color={theme.colors.primary} size={18} strokeWidth={1.8} />
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, { color: granted ? theme.colors.success : theme.colors.warning }]}>
          {value}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator color={theme.colors.primary} size="small" />
      ) : granted ? (
        <CheckCircle2 color={theme.colors.success} size={19} />
      ) : (
        <AlertCircle color={theme.colors.warning} size={19} />
      )}
      <ChevronRight color={theme.colors.textMuted} size={17} />
    </TouchableOpacity>
  );
}

function Divider() {
  return <View style={styles.divider} />;
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
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: '700' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, paddingBottom: 40 },
  intro: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
  sectionLabel: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: 20,
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
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 11,
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1 },
  rowLabel: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: '600' },
  rowValue: { fontSize: 11, marginTop: 3, fontWeight: '600' },
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 59 },
  systemButton: {
    minHeight: 52,
    marginTop: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.colors.surface,
  },
  systemButtonText: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});
