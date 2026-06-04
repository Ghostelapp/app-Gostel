import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  PhoneCall,
  Trash2,
  X,
} from 'lucide-react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useTranslation } from 'react-i18next';
import Avatar from '../../src/Avatar';
import { useAuth } from '../../src/auth';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';
import { useBadges } from '../../src/badges';

type CallRow = {
  id: string;
  conversation_id: string;
  caller_id: string;
  caller_name: string;
  member_ids: string[];
  mode: 'audio' | 'video';
  status: 'ringing' | 'answered' | 'ended' | 'missed';
  started_at: string;
  answered_at?: string | null;
  ended_at?: string | null;
  duration_sec?: number;
  direction: 'incoming' | 'outgoing';
  participants?: ContactInfo[];
};

type ContactInfo = { id: string; name: string; username?: string; avatar_color?: string };

function formatRelative(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return 'yesterday';
    if (diffDay < 7) return `${diffDay}d`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function CallsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { t } = useTranslation();
  const { refresh: refreshBadges } = useBadges();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [contactsMap, setContactsMap] = useState<Record<string, ContactInfo>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [callingBackId, setCallingBackId] = useState<string | null>(null);
  const openSwipeRef = useRef<any>(null);

  const fetchCalls = useCallback(async () => {
    try {
      const { data } = await api.get('/calls');
      const list = Array.isArray(data) ? (data as CallRow[]) : [];
      setCalls(list);
      // Also resolve contact info (names) for peer ids
      const peerIds = new Set<string>();
      for (const c of list) {
        for (const m of c.member_ids || []) {
          if (m !== user?.id) peerIds.add(m);
        }
      }
      if (peerIds.size > 0) {
        try {
          const { data: contacts } = await api.get('/contacts');
          const dict: Record<string, ContactInfo> = {};
          if (Array.isArray(contacts)) {
            for (const c of contacts) {
              if (c?.id) dict[c.id] = c;
            }
          }
          setContactsMap(dict);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.warn('calls fetch failed', formatApiErrorDetail(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  // Initial load + refresh when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      fetchCalls();
      // Mark missed as seen — clear the badge
      (async () => {
        try {
          await api.post('/calls/missed/seen');
          await refreshBadges();
        } catch {
          /* ignore */
        }
      })();
    }, [fetchCalls, refreshBadges])
  );

  useEffect(() => {
    fetchCalls();
  }, [fetchCalls]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchCalls();
  };

  const deleteOne = async (callId: string) => {
    // Optimistic remove
    setCalls((prev) => prev.filter((c) => c.id !== callId));
    try {
      await api.delete(`/calls/${callId}`);
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
      fetchCalls();
    }
  };

  const handleClearAll = () => {
    if (calls.length === 0) return;
    Alert.alert(t('calls.clear_history'), t('calls.confirm_clear_all'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete('/calls');
            setCalls([]);
          } catch (e) {
            Alert.alert(t('common.error'), formatApiErrorDetail(e));
          }
        },
      },
    ]);
  };

  const openCallRow = async (call: CallRow, isMissed: boolean) => {
    if (!isMissed) {
      router.push(`/chat/${call.conversation_id}`);
      return;
    }
    if (callingBackId) return;
    setCallingBackId(call.id);
    try {
      const { data } = await api.post('/calls/start', {
        conversation_id: call.conversation_id,
        mode: call.mode || 'audio',
      });
      router.push(`/call/${data.id}?role=caller&conversation_id=${call.conversation_id}`);
    } catch (e) {
      Alert.alert(t('calls.call_failed'), formatApiErrorDetail(e));
    } finally {
      setCallingBackId(null);
    }
  };

  const renderRightActions = (callId: string) => {
    function CallDeleteAction() {
      return (
      <TouchableOpacity
        testID={`delete-call-${callId}`}
        style={styles.deleteAction}
        onPress={() => deleteOne(callId)}
        activeOpacity={0.85}
      >
        <Trash2 color="#fff" size={22} strokeWidth={2} />
        <Text style={styles.deleteActionText}>{t('common.delete')}</Text>
      </TouchableOpacity>
      );
    }

    return CallDeleteAction;
  };

  const renderItem = ({ item }: { item: CallRow }) => {
    // Find peer (the other member in 1-on-1; for group, show conversation name placeholder)
    const peerId =
      (item.member_ids || []).find((m) => m !== user?.id) || item.caller_id;
    const participantMap = Object.fromEntries(
      (item.participants || []).map((p) => [p.id, p] as const)
    );
    const peer = participantMap[peerId] || contactsMap[peerId];
    const caller = participantMap[item.caller_id] || contactsMap[item.caller_id];
    const direction = item.direction;
    const displayName =
      direction === 'incoming'
        ? caller?.name || (caller?.username ? `@${caller.username}` : null) || item.caller_name || peer?.name
        : peer?.name || (peer?.username ? `@${peer.username}` : null) || item.caller_name;
    const fallbackName = item.caller_name || t('calls.unknown_caller');
    const rowName = displayName || fallbackName;
    const isMissed =
      direction === 'incoming' &&
      (item.status === 'missed' || (!item.answered_at && !!item.ended_at));
    const duration = formatDuration(item.duration_sec);
    const subtitle = isMissed
      ? t('calls.missed_callback')
      : duration
        ? `${direction === 'incoming' ? t('calls.incoming') : t('calls.outgoing')} • ${duration}`
        : direction === 'incoming'
          ? t('calls.incoming')
          : t('calls.outgoing');
    const Icon = isMissed
      ? PhoneMissed
      : direction === 'incoming'
        ? PhoneIncoming
        : PhoneOutgoing;
    const iconColor = isMissed
      ? theme.colors.error
      : direction === 'incoming'
        ? theme.colors.success
        : theme.colors.primary;

    return (
      <Swipeable
        renderRightActions={renderRightActions(item.id)}
        rightThreshold={40}
        overshootRight={false}
      >
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => openCallRow(item, isMissed)}
          style={styles.row}
          testID={`call-row-${item.id}`}
        >
          <Avatar
            name={rowName}
            color={peer?.avatar_color || theme.colors.primaryDark}
            size={44}
          />
          <View style={styles.rowMain}>
            <View style={styles.rowTopLine}>
              <Text
                style={[
                  styles.rowName,
                  isMissed && { color: theme.colors.error },
                ]}
                numberOfLines={1}
              >
                {rowName}
              </Text>
              <Text style={styles.rowTime}>{formatRelative(item.started_at)}</Text>
            </View>
            <View style={styles.rowSubLine}>
              <Icon color={iconColor} size={13} strokeWidth={2.2} />
              <Text
                style={[
                  styles.rowSub,
                  isMissed && { color: theme.colors.error },
                ]}
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            </View>
          </View>
          {isMissed ? (
            <View style={styles.callbackIcon}>
              {callingBackId === item.id ? (
                <ActivityIndicator color={theme.colors.success} size="small" />
              ) : (
                <PhoneCall color={theme.colors.success} size={18} strokeWidth={2.4} />
              )}
            </View>
          ) : null}
        </TouchableOpacity>
      </Swipeable>
    );
  };

  const empty = useMemo(
    () => (
      <View style={styles.empty}>
        <View style={styles.emptyIcon}>
          <PhoneCall color={theme.colors.primary} size={28} strokeWidth={1.6} />
        </View>
        <Text style={styles.emptyTitle}>{t('calls.no_history')}</Text>
      </View>
    ),
    [t]
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{t('calls.title')}</Text>
          <Text style={styles.sub}>{t('calls.history')}</Text>
        </View>
        {calls.length > 0 && (
          <TouchableOpacity
            testID="clear-history-button"
            onPress={handleClearAll}
            style={styles.clearBtn}
            activeOpacity={0.8}
          >
            <X color={theme.colors.error} size={16} strokeWidth={2.2} />
            <Text style={styles.clearBtnText}>{t('common.clear_all')}</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={calls}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          contentContainerStyle={calls.length === 0 ? styles.scrollEmpty : styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={empty}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
  },
  sub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  clearBtnText: {
    color: theme.colors.error,
    fontSize: 12,
    fontWeight: '600',
  },
  scroll: { paddingVertical: 6 },
  scrollEmpty: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: theme.colors.background,
  },
  rowMain: { flex: 1 },
  rowTopLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowName: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  rowTime: {
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
  },
  rowSubLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 3,
  },
  rowSub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  callbackIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginLeft: 74,
  },
  deleteAction: {
    backgroundColor: theme.colors.error,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    flexDirection: 'row',
    gap: 6,
  },
  deleteActionText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  empty: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyIcon: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: theme.colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
});
