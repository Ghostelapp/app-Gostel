import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import {
  ChevronRight,
  LogOut,
  Shield,
  KeyRound,
  Bell,
  CircleDot,
  Lock,
  AtSign,
  Copy,
  Globe,
  Check,
  ShieldOff,
  Camera,
  Download,
  Smartphone,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import Avatar from '../../src/Avatar';
import { useAuth } from '../../src/auth';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme, statusColor } from '../../src/theme';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import type { AppLang } from '../../src/i18n';
import { pickRawImage, type RawPickedImage } from '../../src/photoPicker';
import AvatarCropperModal from '../../src/AvatarCropperModal';
import { exportMyData } from '../../src/exportData';
import { usePinLock } from '../../src/pinLock';
import { areSoundsEnabled, setSoundsEnabled, hydrateSoundPrefs } from '../../src/sounds';

export default function ProfileScreen() {
  const { user, logout, refreshUser } = useAuth();
  const router = useRouter();
  const { t } = useTranslation();
  const { lang, setLang } = useLanguage();
  const { pinSet, forceClearForLogout } = usePinLock();
  const [savingStatus, setSavingStatus] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [soundsOn, setSoundsOn] = useState<boolean>(true);
  const [cropTarget, setCropTarget] = useState<RawPickedImage | null>(null);

  // Hydrate sound preference once on mount.
  React.useEffect(() => {
    hydrateSoundPrefs().then(setSoundsOn);
  }, []);

  const toggleSounds = async () => {
    const next = !areSoundsEnabled();
    await setSoundsEnabled(next);
    setSoundsOn(next);
  };

  const STATUS_OPTIONS: { key: 'online' | 'busy' | 'away' | 'offline'; label: string }[] = [
    { key: 'online', label: 'Online' },
    { key: 'busy', label: 'Busy' },
    { key: 'away', label: 'Away' },
    { key: 'offline', label: 'Offline' },
  ];

  if (!user) return null;

  const setStatus = async (s: 'online' | 'busy' | 'away' | 'offline') => {
    setSavingStatus(true);
    try {
      await api.patch('/users/me/status', { status: s });
      await refreshUser();
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setSavingStatus(false);
    }
  };

  const handleLangChange = async (l: AppLang) => {
    if (l === lang) return;
    await setLang(l);
  };

  const handlePhoto = async () => {
    if (savingPhoto) return;
    if (user.avatar) {
      Alert.alert(
        t('photo.title'),
        undefined,
        [
          {
            text: t('profile.change_photo'),
            onPress: async () => savePhoto(),
          },
          {
            text: t('profile.remove_photo'),
            style: 'destructive',
            onPress: async () => removePhoto(),
          },
          { text: t('common.cancel'), style: 'cancel' },
        ],
      );
    } else {
      await savePhoto();
    }
  };

  const savePhoto = async () => {
    try {
      const raw = await pickRawImage(t as any);
      if (!raw) return;
      // Open the cropper modal; actual upload happens in onCropped below.
      setCropTarget(raw);
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    }
  };

  const uploadCroppedAvatar = async (dataUri: string) => {
    try {
      setSavingPhoto(true);
      setCropTarget(null);
      await api.patch('/users/me/avatar', { avatar: dataUri });
      await refreshUser();
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setSavingPhoto(false);
    }
  };

  const removePhoto = async () => {
    try {
      setSavingPhoto(true);
      await api.patch('/users/me/avatar', { avatar: '' });
      await refreshUser();
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setSavingPhoto(false);
    }
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportMyData(t as any);
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteAccount = () => {
    if (deletingAccount) return;
    Alert.alert(t('profile.delete_account'), t('profile.delete_account_confirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.delete_account_confirm_button'),
        style: 'destructive',
        onPress: async () => {
          try {
            setDeletingAccount(true);
            await api.delete('/users/me');
            await forceClearForLogout();
            await logout();
          } catch (e) {
            Alert.alert(t('common.error'), formatApiErrorDetail(e));
          } finally {
            setDeletingAccount(false);
          }
        },
      },
    ]);
  };

  const showPushDevices = async () => {
    try {
      const { data } = await api.get('/push/devices');
      const devices = Array.isArray(data?.devices) ? data.devices : [];
      if (!devices.length) {
        Alert.alert(t('profile.push_devices'), t('profile.no_push_devices'));
        return;
      }
      const body = devices
        .map((d: any, idx: number) => {
          const model = d.device_model || d.platform || 'device';
          const token = `${d.token_prefix || ''}…${d.token_suffix || ''}`;
          const meta = [d.platform, d.token_type, d.source].filter(Boolean).join(' / ');
          const registered = d.registered_at ? `\n${d.registered_at}` : '';
          return `${idx + 1}. ${model}\n${meta}\n${token}${registered}`;
        })
        .join('\n\n');
      Alert.alert(`${t('profile.push_devices')} (${devices.length})`, body.slice(0, 1600));
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.headerCard}>
          <TouchableOpacity
            testID="profile-photo"
            onPress={handlePhoto}
            activeOpacity={0.8}
            disabled={savingPhoto}
            style={{ position: 'relative' }}
          >
            <Avatar
              name={user.name}
              size={84}
              color={user.avatar_color}
              status={user.status}
              showStatus
              photo={user.avatar}
            />
            <View style={styles.cameraBadge}>
              {savingPhoto ? (
                <ActivityIndicator color={theme.colors.background} size="small" />
              ) : (
                <Camera color={theme.colors.background} size={14} strokeWidth={2.5} />
              )}
            </View>
          </TouchableOpacity>
          <Text style={styles.name}>{user.name}</Text>
          {!!user.title && <Text style={styles.title}>{user.title}</Text>}
          {user.username ? (
            <TouchableOpacity
              style={styles.usernamePill}
              onPress={() => {
                if (Platform.OS === 'web' && (navigator as any)?.clipboard) {
                  (navigator as any).clipboard.writeText(`@${user.username}`);
                  Alert.alert('Copied', `@${user.username} copied to clipboard.`);
                } else {
                  Alert.alert(
                    'Your username',
                    `@${user.username}\n\nShare this with others so they can invite you to chat.`,
                  );
                }
              }}
              testID="profile-username-pill"
            >
              <AtSign color={theme.colors.primary} size={13} strokeWidth={2.5} />
              <Text style={styles.usernameText}>{user.username}</Text>
              <Copy color={theme.colors.textMuted} size={12} strokeWidth={2} />
            </TouchableOpacity>
          ) : null}
          <Text style={styles.email}>{user.email}</Text>

          {user.role === 'admin' && (
            <View style={styles.roleBadge}>
              <Shield color={theme.colors.primary} size={11} strokeWidth={2} />
              <Text style={styles.roleText}>Administrator</Text>
            </View>
          )}
        </View>

        <Text style={styles.sectionLabel}>Status</Text>
        <View style={styles.statusGrid}>
          {STATUS_OPTIONS.map((opt) => {
            const active = user.status === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                testID={`status-${opt.key}`}
                style={[styles.statusChip, active && styles.statusChipActive]}
                onPress={() => setStatus(opt.key)}
                disabled={savingStatus}
                activeOpacity={0.8}
              >
                <CircleDot color={statusColor(opt.key)} size={12} strokeWidth={2.5} />
                <Text style={[styles.statusText, active && styles.statusTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.sectionLabel}>{t('common.language')}</Text>
        <View style={styles.menuCard}>
          <TouchableOpacity
            testID="lang-en"
            style={styles.menuRow}
            onPress={() => handleLangChange('en')}
            activeOpacity={0.7}
          >
            <View style={styles.menuIcon}>
              <Globe color={theme.colors.primary} size={18} strokeWidth={1.8} />
            </View>
            <Text style={styles.menuLabel}>English</Text>
            {lang === 'en' && (
              <Check color={theme.colors.primary} size={20} strokeWidth={2.5} />
            )}
          </TouchableOpacity>
          <Divider />
          <TouchableOpacity
            testID="lang-pl"
            style={styles.menuRow}
            onPress={() => handleLangChange('pl')}
            activeOpacity={0.7}
          >
            <View style={styles.menuIcon}>
              <Globe color={theme.colors.primary} size={18} strokeWidth={1.8} />
            </View>
            <Text style={styles.menuLabel}>Polski</Text>
            {lang === 'pl' && (
              <Check color={theme.colors.primary} size={20} strokeWidth={2.5} />
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>Security</Text>
        <View style={styles.menuCard}>
          <MenuRow
            icon={<Smartphone color={theme.colors.primary} size={18} strokeWidth={1.8} />}
            label={t('profile.app_lock')}
            value={pinSet ? t('common.on') : t('common.off')}
            valueColor={pinSet ? theme.colors.success : theme.colors.textMuted}
            onPress={() => router.push('/settings/app-lock')}
            testID="menu-app-lock"
          />
          <Divider />
          <MenuRow
            icon={<KeyRound color={theme.colors.primary} size={18} strokeWidth={1.8} />}
            label={t('profile.two_factor')}
            value={user.two_factor_enabled ? t('common.enabled') : t('common.disabled')}
            valueColor={user.two_factor_enabled ? theme.colors.success : theme.colors.textMuted}
            onPress={() => router.push('/settings/two-factor')}
            testID="menu-2fa"
          />
          <Divider />
          <MenuRow
            icon={<Lock color={theme.colors.primary} size={18} strokeWidth={1.8} />}
            label={t('common.privacy')}
            value=""
            onPress={() => router.push('/settings/privacy')}
            testID="menu-privacy"
          />
          <Divider />
          <MenuRow
            icon={<ShieldOff color={theme.colors.warning} size={18} strokeWidth={1.8} />}
            label={t('profile.blocked_users')}
            value=""
            onPress={() => router.push('/settings/blocked-users')}
            testID="menu-blocked"
          />
          <Divider />
          <MenuRow
            icon={<Bell color={theme.colors.primary} size={18} strokeWidth={1.8} />}
            label={t('onboarding.perm_notifications')}
            value={user.push_registered ? t('common.enabled') : t('onboarding.perm_denied')}
            valueColor={user.push_registered ? theme.colors.success : theme.colors.warning}
            onPress={async () => {
              Alert.alert(
                t('profile.test_push_title'),
                t('profile.test_push_body'),
                [
                  {
                    text: t('profile.push_devices'),
                    onPress: showPushDevices,
                  },
                  {
                    text: t('profile.test_push_message'),
                    onPress: async () => {
                      try {
                        const { data } = await api.post('/push/test', { kind: 'message' });
                        Alert.alert(
                          data?.sent ? t('profile.test_push_sent') : t('profile.test_push_failed'),
                          JSON.stringify(data, null, 2).slice(0, 800),
                        );
                      } catch (e) {
                        Alert.alert(t('common.error'), formatApiErrorDetail(e));
                      }
                    },
                  },
                  {
                    text: t('profile.test_push_call'),
                    onPress: async () => {
                      try {
                        const { data } = await api.post('/push/test', { kind: 'call' });
                        Alert.alert(
                          data?.sent ? t('profile.test_push_sent') : t('profile.test_push_failed'),
                          JSON.stringify(data, null, 2).slice(0, 800),
                        );
                      } catch (e) {
                        Alert.alert(t('common.error'), formatApiErrorDetail(e));
                      }
                    },
                  },
                ],
              );
            }}
            testID="menu-notifications"
          />
        </View>

        <Text style={styles.sectionLabel}>{t('common.privacy')}</Text>
        <View style={styles.menuCard}>
          <MenuRow
            icon={
              soundsOn ? (
                <Volume2 color={theme.colors.primary} size={18} strokeWidth={1.8} />
              ) : (
                <VolumeX color={theme.colors.textMuted} size={18} strokeWidth={1.8} />
              )
            }
            label={t('sounds.title')}
            value={soundsOn ? t('common.on') : t('common.off')}
            valueColor={soundsOn ? theme.colors.success : theme.colors.textMuted}
            onPress={toggleSounds}
            testID="menu-sounds"
          />
          <Divider />
          <MenuRow
            icon={
              exporting ? (
                <ActivityIndicator color={theme.colors.primary} size="small" />
              ) : (
                <Download color={theme.colors.primary} size={18} strokeWidth={1.8} />
              )
            }
            label={t('profile.export_data')}
            value=""
            onPress={handleExport}
            testID="menu-export"
          />
          <Divider />
          <MenuRow
            icon={
              deletingAccount ? (
                <ActivityIndicator color={theme.colors.error} size="small" />
              ) : (
                <Trash2 color={theme.colors.error} size={18} strokeWidth={1.8} />
              )
            }
            label={t('profile.delete_account')}
            value={deletingAccount ? t('common.loading') : ''}
            valueColor={theme.colors.error}
            onPress={handleDeleteAccount}
            testID="menu-delete-account"
          />
        </View>

        <TouchableOpacity
          testID="logout-button"
          style={styles.logoutBtn}
          onPress={() => {
            Alert.alert(t('common.sign_out'), 'Are you sure?', [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('common.sign_out'),
                style: 'destructive',
                onPress: async () => {
                  // Disable PIN lock at logout so a new login isn't blocked.
                  await forceClearForLogout();
                  await logout();
                },
              },
            ]);
          }}
          activeOpacity={0.85}
        >
          <LogOut color={theme.colors.error} size={18} strokeWidth={1.8} />
          <Text style={styles.logoutText}>{t('common.sign_out')}</Text>
        </TouchableOpacity>

        <Text style={styles.versionText}>
          Ghostel • v{Constants.expoConfig?.version || '1.3.0'}
        </Text>
      </ScrollView>

      <AvatarCropperModal
        visible={!!cropTarget}
        uri={cropTarget?.uri ?? null}
        width={cropTarget?.width ?? 0}
        height={cropTarget?.height ?? 0}
        onCancel={() => setCropTarget(null)}
        onCropped={uploadCroppedAvatar}
      />
    </SafeAreaView>
  );
}

function MenuRow({
  icon,
  label,
  value,
  valueColor,
  onPress,
  testID,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  valueColor?: string;
  onPress?: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={styles.menuRow}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.menuIcon}>{icon}</View>
      <Text style={styles.menuLabel}>{label}</Text>
      {value ? (
        <Text style={[styles.menuValue, valueColor ? { color: valueColor } : null]}>
          {value}
        </Text>
      ) : null}
      <ChevronRight color={theme.colors.textMuted} size={18} />
    </TouchableOpacity>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  scroll: { padding: 20, paddingBottom: 40 },
  headerCard: {
    backgroundColor: theme.colors.surface,
    padding: 24,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cameraBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: theme.colors.surface,
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 14,
  },
  title: { color: theme.colors.primary, fontSize: 13, marginTop: 4, fontWeight: '600' },
  email: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 4 },
  usernamePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary + '15',
    borderWidth: 1,
    borderColor: theme.colors.primary + '40',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: theme.radius.pill,
    marginTop: 8,
  },
  usernameText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.pill,
    marginTop: 12,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  roleText: {
    color: theme.colors.primary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  sectionLabel: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginTop: 24,
    marginBottom: 10,
    marginLeft: 4,
  },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  statusChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryDark,
  },
  statusText: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: '600' },
  statusTextActive: { color: theme.colors.primary },
  menuCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  },
  menuRow: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14 },
  menuIcon: { width: 28, alignItems: 'center' },
  menuLabel: { flex: 1, color: theme.colors.textPrimary, fontSize: 14, fontWeight: '500' },
  menuValue: { color: theme.colors.textSecondary, fontSize: 12, marginRight: 4 },
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 56 },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    padding: 14,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  logoutText: { color: theme.colors.error, fontSize: 14, fontWeight: '600' },
  versionText: {
    color: theme.colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 24,
    letterSpacing: 0.5,
  },
});
