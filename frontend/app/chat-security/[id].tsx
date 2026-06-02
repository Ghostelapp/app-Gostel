import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft,
  KeyRound,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import Avatar from '../../src/Avatar';
import { api, formatApiErrorDetail } from '../../src/api';
import { useAuth } from '../../src/auth';
import {
  E2EEKeyTrustStatus,
  isConversationE2EEReady,
  publicKeyFingerprint,
  syncConversationKeyTrust,
  trustConversationKeys,
} from '../../src/e2ee';
import { theme } from '../../src/theme';

type Member = {
  id: string;
  name: string;
  username?: string;
  avatar?: string | null;
  avatar_color?: string;
  e2ee_public_key?: string | null;
};

type Conversation = {
  id: string;
  type: 'direct' | 'group';
  name: string;
  members: Member[];
  e2ee_ready?: boolean;
};

function memberDisplayName(member: Member | undefined, fallback: string): string {
  return member?.name || member?.username || fallback;
}

export default function ChatSecurityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [trust, setTrust] = useState<E2EEKeyTrustStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [trusting, setTrusting] = useState(false);

  const load = useCallback(
    async (quiet = false) => {
      if (!id) return;
      if (quiet) setRefreshing(true);
      else setLoading(true);
      try {
        const { data } = await api.get(`/conversations/${id}`);
        setConversation(data);
        if (user?.id) {
          const nextTrust = await syncConversationKeyTrust(data, user.id);
          setTrust(nextTrust);
        } else {
          setTrust(null);
        }
      } catch (e) {
        Alert.alert(t('common.error'), formatApiErrorDetail(e));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id, t, user?.id],
  );

  useEffect(() => {
    load();
  }, [load]);

  const memberById = useMemo(() => {
    const map = new Map<string, Member>();
    for (const member of conversation?.members || []) {
      map.set(member.id, member);
    }
    return map;
  }, [conversation?.members]);

  const changedNames = useMemo(
    () =>
      (trust?.changedMemberIds || [])
        .map((memberId) => memberDisplayName(memberById.get(memberId), memberId))
        .join(', '),
    [memberById, trust?.changedMemberIds],
  );

  const missingNames = useMemo(
    () =>
      (trust?.missingMemberIds || [])
        .map((memberId) => memberDisplayName(memberById.get(memberId), memberId))
        .join(', '),
    [memberById, trust?.missingMemberIds],
  );

  const e2eeReady =
    !!conversation &&
    !!user?.id &&
    (isConversationE2EEReady(conversation, user.id) || !!conversation.e2ee_ready);
  const hasChangedKeys = !!trust?.changedMemberIds.length;
  const isTrusted = e2eeReady && trust?.trusted === true && !hasChangedKeys;

  const status = hasChangedKeys ? 'changed' : isTrusted ? 'trusted' : 'pending';
  const StatusIcon =
    status === 'changed' ? ShieldAlert : status === 'trusted' ? ShieldCheck : KeyRound;
  const statusColor =
    status === 'changed'
      ? theme.colors.warning
      : status === 'trusted'
      ? theme.colors.success
      : theme.colors.textSecondary;

  const confirmNewKeys = async () => {
    if (!conversation || !user?.id) return;
    setTrusting(true);
    try {
      const nextTrust = await trustConversationKeys(conversation, user.id);
      setTrust(nextTrust);
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
    } finally {
      setTrusting(false);
    }
  };

  const statusTitle =
    status === 'changed'
      ? t('chat.security_summary_changed')
      : status === 'trusted'
      ? t('chat.security_summary_trusted')
      : t('chat.security_summary_pending');

  const statusBody =
    status === 'changed'
      ? t('chat.security_detail_changed', { names: changedNames })
      : status === 'trusted'
      ? t('chat.security_detail_trusted')
      : missingNames
      ? t('chat.security_detail_missing', { names: missingNames })
      : t('chat.security_detail_pending');

  if (loading) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
        <ActivityIndicator color={theme.colors.primary} />
      </SafeAreaView>
    );
  }

  if (!conversation) {
    return (
      <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
        <Text style={styles.muted}>{t('common.error')}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="chat-security-back"
          onPress={() => router.back()}
          style={styles.iconBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ArrowLeft color={theme.colors.textPrimary} size={22} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('chat.security_title')}</Text>
        <TouchableOpacity
          testID="chat-security-refresh"
          onPress={() => load(true)}
          disabled={refreshing}
          style={styles.iconBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          {refreshing ? (
            <ActivityIndicator color={theme.colors.primary} size="small" />
          ) : (
            <RefreshCw color={theme.colors.textSecondary} size={19} strokeWidth={2} />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.summary}>
          <View style={[styles.statusIcon, { borderColor: statusColor }]}>
            <StatusIcon color={statusColor} size={28} strokeWidth={2.2} />
          </View>
          <View style={styles.summaryText}>
            <Text style={styles.summaryTitle}>{statusTitle}</Text>
            <Text style={styles.summaryBody}>{statusBody}</Text>
          </View>
        </View>

        {hasChangedKeys ? (
          <TouchableOpacity
            testID="chat-security-trust"
            onPress={confirmNewKeys}
            disabled={trusting}
            style={styles.primaryBtn}
            activeOpacity={0.86}
          >
            {trusting ? (
              <ActivityIndicator color={theme.colors.background} size="small" />
            ) : (
              <ShieldCheck color={theme.colors.background} size={17} strokeWidth={2.5} />
            )}
            <Text style={styles.primaryBtnText}>{t('chat.security_trust_new_keys')}</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t('chat.security_members_title')}</Text>
          <Text style={styles.sectionMeta}>
            {conversation.members.length} {t('chat.security_members')}
          </Text>
        </View>

        <View style={styles.memberList}>
          {(conversation.members || []).map((member) => {
            const isMe = member.id === user?.id;
            const hasKey = !!member.e2ee_public_key;
            const changed = (trust?.changedMemberIds || []).includes(member.id);
            const missing = !isMe && (trust?.missingMemberIds || []).includes(member.id);
            const fingerprint =
              trust?.fingerprints[member.id] ||
              publicKeyFingerprint(member.e2ee_public_key) ||
              '';
            const label = isMe
              ? t('chat.security_this_device')
              : changed
              ? t('chat.security_changed')
              : missing || !hasKey
              ? t('chat.security_missing')
              : t('chat.security_trusted');
            const badgeStyle = isMe
              ? styles.badgeSelf
              : changed
              ? styles.badgeChanged
              : missing || !hasKey
              ? styles.badgeMissing
              : styles.badgeTrusted;
            const badgeTextStyle = isMe
              ? styles.badgeTextSelf
              : changed
              ? styles.badgeTextChanged
              : missing || !hasKey
              ? styles.badgeTextMissing
              : styles.badgeTextTrusted;

            return (
              <View key={member.id} style={styles.memberRow} testID={`security-member-${member.id}`}>
                <Avatar
                  name={member.name}
                  color={member.avatar_color}
                  photo={member.avatar}
                  size={42}
                />
                <View style={styles.memberBody}>
                  <View style={styles.memberTop}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {memberDisplayName(member, member.id)}
                    </Text>
                    <View style={[styles.badge, badgeStyle]}>
                      <Text style={[styles.badgeText, badgeTextStyle]}>{label}</Text>
                    </View>
                  </View>
                  {member.username ? (
                    <Text style={styles.username} numberOfLines={1}>
                      @{member.username}
                    </Text>
                  ) : null}
                  <Text style={styles.fingerprintLabel}>{t('chat.security_fingerprint')}</Text>
                  <Text style={styles.fingerprint} numberOfLines={2}>
                    {fingerprint || t('chat.security_no_fingerprint')}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: 10,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 32,
    gap: 16,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 16,
  },
  statusIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
  },
  summaryText: { flex: 1, minWidth: 0 },
  summaryTitle: {
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  summaryBody: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: theme.colors.warning,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryBtnText: {
    color: theme.colors.background,
    fontSize: 14,
    fontWeight: '800',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  sectionMeta: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  memberList: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  memberRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  memberBody: { flex: 1, minWidth: 0 },
  memberTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memberName: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  username: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  fingerprintLabel: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 9,
    textTransform: 'uppercase',
  },
  fingerprint: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 3,
  },
  muted: { color: theme.colors.textSecondary, fontSize: 14 },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderWidth: 1,
    flexShrink: 0,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  badgeTrusted: {
    borderColor: theme.colors.success,
    backgroundColor: `${theme.colors.success}18`,
  },
  badgeTextTrusted: { color: theme.colors.success },
  badgeChanged: {
    borderColor: theme.colors.warning,
    backgroundColor: `${theme.colors.warning}18`,
  },
  badgeTextChanged: { color: theme.colors.warning },
  badgeMissing: {
    borderColor: theme.colors.textMuted,
    backgroundColor: `${theme.colors.textMuted}18`,
  },
  badgeTextMissing: { color: theme.colors.textSecondary },
  badgeSelf: {
    borderColor: theme.colors.primary,
    backgroundColor: `${theme.colors.primary}18`,
  },
  badgeTextSelf: { color: theme.colors.primary },
});
