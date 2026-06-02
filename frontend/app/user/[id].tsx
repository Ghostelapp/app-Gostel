/**
 * /user/[id].tsx — Public profile of any user.
 *
 * Shows avatar/name/username/bio/status/last seen + relationship actions:
 *   - 💬 Send message
 *   - 📞 Voice call
 *   - 🔕 Mute / 🔔 Unmute (with duration picker)
 *   - 🚫 Block / Unblock
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft,
  MessageSquare,
  Phone,
  Bell,
  BellOff,
  Shield,
  ShieldOff,
  AtSign,
  Clock,
  Check,
  CircleDot,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import Avatar from '../../src/Avatar';
import { theme, statusColor } from '../../src/theme';
import { api, formatApiErrorDetail } from '../../src/api';
import { useAuth } from '../../src/auth';
import { formatLastSeen, isProbablyOnline } from '../../src/presence';

type Profile = {
  id: string;
  name: string;
  username?: string;
  title?: string;
  bio?: string;
  status?: string;
  avatar_color?: string;
  avatar?: string | null;
  last_seen?: string | null;
  last_active?: string | null;
  role?: string;
  created_at?: string | null;
  is_blocked?: boolean;
  is_blocking_me?: boolean;
  is_contact?: boolean;
  muted_until?: string | null;
  muted?: boolean;
};

const MUTE_OPTIONS: { label_key: string; seconds: number | null }[] = [
  { label_key: 'user_profile.mute_for_hour', seconds: 60 * 60 },
  { label_key: 'user_profile.mute_for_8h', seconds: 8 * 60 * 60 },
  { label_key: 'user_profile.mute_for_day', seconds: 24 * 60 * 60 },
  { label_key: 'user_profile.mute_for_week', seconds: 7 * 24 * 60 * 60 },
  { label_key: 'user_profile.mute_forever', seconds: null },
];

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { user: me, refreshUser } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [muteSheet, setMuteSheet] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await api.get(`/users/${id}`);
      setProfile(data);
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const isMe = me?.id === id;
  const isMuted = !!profile?.muted;
  const isBlocked = !!profile?.is_blocked;
  const online = isProbablyOnline(profile?.status, profile?.last_active);
  const presenceText = online
    ? t('presence.online')
    : formatLastSeen(profile?.last_seen, t as any, false);

  const openChat = async () => {
    if (!profile || isMe) return;
    try {
      const { data } = await api.post('/conversations', {
        type: 'direct',
        member_ids: [profile.id],
      });
      router.replace(`/chat/${data.id}`);
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    }
  };

  const startCall = async () => {
    if (!profile) return;
    try {
      const { data: conv } = await api.post('/conversations', {
        type: 'direct',
        member_ids: [profile.id],
      });
      router.push(`/call/new?conversation_id=${conv.id}&direction=outgoing`);
    } catch (e) {
      Alert.alert(t('contacts.cannot_start_call'), formatApiErrorDetail(e));
    }
  };

  const doMute = async (seconds: number | null) => {
    if (!profile) return;
    setMuteSheet(false);
    setActionBusy(true);
    try {
      await api.post(`/users/me/mute_user/${profile.id}`, {
        duration_seconds: seconds,
      });
      await load();
      await refreshUser();
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setActionBusy(false);
    }
  };

  const doUnmute = async () => {
    if (!profile) return;
    setActionBusy(true);
    try {
      await api.delete(`/users/me/mute_user/${profile.id}`);
      await load();
      await refreshUser();
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setActionBusy(false);
    }
  };

  const toggleBlock = async () => {
    if (!profile) return;
    if (isBlocked) {
      setActionBusy(true);
      try {
        await api.delete(`/users/me/blocked/${profile.id}`);
        await load();
        await refreshUser();
      } catch (e) {
        Alert.alert(t('common.error'), formatApiErrorDetail(e));
      } finally {
        setActionBusy(false);
      }
    } else {
      Alert.alert(
        t('user_profile.block_user'),
        t('user_profile.confirm_block'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('user_profile.block_user'),
            style: 'destructive',
            onPress: async () => {
              setActionBusy(true);
              try {
                await api.post(`/users/me/blocked/${profile.id}`);
                await load();
                await refreshUser();
              } catch (e) {
                Alert.alert(t('common.error'), formatApiErrorDetail(e));
              } finally {
                setActionBusy(false);
              }
            },
          },
        ],
      );
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </SafeAreaView>
    );
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.subtle}>{t('common.error')}</Text>
      </SafeAreaView>
    );
  }

  const muteStatusLabel = isMuted
    ? profile.muted_until
      ? t('user_profile.muted_until', {
          when: new Date(profile.muted_until).toLocaleString(i18n.language, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        })
      : t('user_profile.muted_forever')
    : '';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          testID="user-profile-back"
        >
          <ArrowLeft color={theme.colors.textPrimary} size={22} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('user_profile.title')}</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <Avatar
            name={profile.name}
            size={104}
            color={profile.avatar_color}
            status={profile.status}
            showStatus
            photo={profile.avatar}
          />
          <Text style={styles.name}>{profile.name}</Text>
          {!!profile.username && (
            <View style={styles.usernamePill}>
              <AtSign color={theme.colors.primary} size={13} strokeWidth={2.5} />
              <Text style={styles.usernameText}>{profile.username}</Text>
            </View>
          )}
          {!!profile.title && <Text style={styles.title}>{profile.title}</Text>}
          {!!presenceText && (
            <View style={styles.presenceRow}>
              <CircleDot
                color={statusColor(profile.status)}
                size={12}
                strokeWidth={2.5}
              />
              <Text style={styles.presenceText}>{presenceText}</Text>
            </View>
          )}
          {isMuted && (
            <View style={styles.muteBadge}>
              <BellOff color={theme.colors.warning} size={12} strokeWidth={2.5} />
              <Text style={styles.muteBadgeText}>{muteStatusLabel}</Text>
            </View>
          )}
        </View>

        {!isMe && !isBlocked && !profile.is_blocking_me && (
          <View style={styles.actionRow}>
            <ActionButton
              icon={<MessageSquare color={theme.colors.background} size={18} strokeWidth={2.4} />}
              label={t('user_profile.send_message')}
              onPress={openChat}
              testID="user-action-message"
              primary
            />
            <ActionButton
              icon={<Phone color={theme.colors.primary} size={18} strokeWidth={2.4} />}
              label={t('user_profile.voice_call')}
              onPress={startCall}
              testID="user-action-call"
            />
          </View>
        )}

        {!!profile.bio && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t('user_profile.bio_label')}</Text>
            <View style={styles.card}>
              <Text style={styles.bioText}>{profile.bio}</Text>
            </View>
          </View>
        )}

        {!isMe && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t('common.settings')}</Text>
            <View style={styles.menuCard}>
              {/* Mute / unmute */}
              <TouchableOpacity
                style={styles.menuRow}
                disabled={actionBusy}
                onPress={() => (isMuted ? doUnmute() : setMuteSheet(true))}
                testID="toggle-mute"
              >
                <View style={styles.menuIcon}>
                  {isMuted ? (
                    <Bell color={theme.colors.primary} size={18} strokeWidth={1.8} />
                  ) : (
                    <BellOff color={theme.colors.warning} size={18} strokeWidth={1.8} />
                  )}
                </View>
                <Text style={styles.menuLabel}>
                  {isMuted ? t('user_profile.unmute_user') : t('user_profile.mute_user')}
                </Text>
                {actionBusy && <ActivityIndicator color={theme.colors.primary} size="small" />}
              </TouchableOpacity>
              <View style={styles.divider} />
              {/* Block / unblock */}
              <TouchableOpacity
                style={styles.menuRow}
                disabled={actionBusy}
                onPress={toggleBlock}
                testID="toggle-block"
              >
                <View style={styles.menuIcon}>
                  {isBlocked ? (
                    <Shield color={theme.colors.primary} size={18} strokeWidth={1.8} />
                  ) : (
                    <ShieldOff color={theme.colors.error} size={18} strokeWidth={1.8} />
                  )}
                </View>
                <Text
                  style={[
                    styles.menuLabel,
                    !isBlocked && { color: theme.colors.error },
                  ]}
                >
                  {isBlocked ? t('user_profile.unblock_user') : t('user_profile.block_user')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {!!profile.created_at && (
          <View style={styles.section}>
            <View style={styles.metaRow}>
              <Clock color={theme.colors.textMuted} size={12} />
              <Text style={styles.metaText}>
                {t('user_profile.joined_label')}{' '}
                {new Date(profile.created_at).toLocaleDateString(i18n.language, {
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Mute duration sheet */}
      <Modal
        visible={muteSheet}
        animationType="slide"
        transparent
        onRequestClose={() => setMuteSheet(false)}
      >
        <TouchableOpacity
          style={styles.modalBg}
          activeOpacity={1}
          onPress={() => setMuteSheet(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            <Text style={styles.sheetTitle}>{t('user_profile.mute_user')}</Text>
            {MUTE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={String(opt.seconds)}
                style={styles.sheetRow}
                onPress={() => doMute(opt.seconds)}
                testID={`mute-opt-${opt.seconds ?? 'forever'}`}
              >
                <BellOff color={theme.colors.warning} size={18} strokeWidth={1.8} />
                <Text style={styles.sheetRowText}>{t(opt.label_key)}</Text>
              </TouchableOpacity>
            ))}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  testID,
  primary,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  testID?: string;
  primary?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, primary && styles.actionBtnPrimary]}
      onPress={onPress}
      activeOpacity={0.85}
      testID={testID}
    >
      {icon}
      <Text
        style={[
          styles.actionLabel,
          primary && { color: theme.colors.background },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  center: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtle: { color: theme.colors.textSecondary, fontSize: 13 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: { color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700' },
  scroll: { padding: 20, paddingBottom: 60 },
  hero: { alignItems: 'center' },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    marginTop: 14,
    letterSpacing: -0.3,
  },
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
  usernameText: { color: theme.colors.primary, fontSize: 13, fontWeight: '600' },
  title: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    marginTop: 8,
  },
  presenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  presenceText: { color: theme.colors.textSecondary, fontSize: 12 },
  muteBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.warning + '15',
    borderColor: theme.colors.warning + '40',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    marginTop: 10,
  },
  muteBadgeText: {
    color: theme.colors.warning,
    fontSize: 11,
    fontWeight: '600',
  },
  actionRow: { flexDirection: 'row', gap: 10, marginTop: 24 },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionBtnPrimary: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  actionLabel: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  section: { marginTop: 24 },
  sectionLabel: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: theme.colors.surface,
    padding: 16,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bioText: { color: theme.colors.textPrimary, fontSize: 14, lineHeight: 20 },
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
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 56 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 16,
  },
  metaText: { color: theme.colors.textMuted, fontSize: 11 },
  modalBg: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 30 : 20,
  },
  sheetTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  sheetRowText: { color: theme.colors.textPrimary, fontSize: 14 },
});
