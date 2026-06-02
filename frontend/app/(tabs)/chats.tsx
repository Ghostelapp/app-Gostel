import React, { useCallback, useState, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Lock,
  Plus,
  Search,
  ShieldCheck,
  BellOff,
  Trash2,
} from 'lucide-react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SharedValue } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import Avatar from '../../src/Avatar';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { decryptMessageForUser, E2EEPayload } from '../../src/e2ee';

type Conversation = {
  id: string;
  type: 'direct' | 'group';
  name: string;
  members: any[];
  last_message?: {
    content: string;
    created_at: string;
    sender_name?: string;
    kind?: string;
    sender_id: string;
    encrypted?: boolean;
    e2ee?: E2EEPayload | null;
    e2ee_decrypted?: boolean;
  } | null;
  unread_count: number;
  encrypted: boolean;
  avatar?: string | null;
};

export default function ChatsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState('');
  const openSwipeRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/conversations');
      const decrypted = await Promise.all(
        (data as Conversation[]).map(async (conv) => ({
          ...conv,
          last_message: conv.last_message
            ? await decryptMessageForUser(conv.last_message, user?.id)
            : conv.last_message,
        })),
      );
      setItems(decrypted);
    } catch (e) {
      console.warn('load conversations', formatApiErrorDetail(e));
    }
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        setLoading(true);
        await load();
        setLoading(false);
      })();
    }, [load])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = q
    ? items.filter((c) => {
        const needle = q.toLowerCase();
        if ((c.name || '').toLowerCase().includes(needle)) return true;
        if ((c.last_message?.content || '').toLowerCase().includes(needle)) return true;
        for (const m of c.members || []) {
          if ((m?.name || '').toLowerCase().includes(needle)) return true;
          if ((m?.username || '').toLowerCase().includes(needle)) return true;
        }
        return false;
      })
    : items;

  const deleteChat = (conv: Conversation) => {
    Alert.alert(
      t('chats.delete_chat'),
      t('chats.delete_chat_confirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            // Optimistic update
            setItems((prev) => prev.filter((c) => c.id !== conv.id));
            try {
              await api.delete(`/conversations/${conv.id}`);
            } catch (e) {
              Alert.alert(t('common.error'), formatApiErrorDetail(e));
              // Re-fetch to restore
              await load();
            }
          },
        },
      ],
    );
  };

  /** Compute mute state for a conversation row. */
  const isConvMuted = (c: Conversation): boolean => {
    const muteIds = user?.muted_conversation_ids || [];
    if (muteIds.includes(c.id)) return true;
    if (c.type === 'direct') {
      const other = c.members.find((m) => m.id !== user?.id);
      const muted = (user?.muted_users || {})[other?.id || ''];
      if (muted) {
        // until == null → forever; else compare to now
        const until = muted.until;
        if (!until || until > new Date().toISOString()) return true;
      }
    }
    return false;
  };

  const renderRightActions = (
    _progress: SharedValue<number>,
    _drag: SharedValue<number>,
    conv: Conversation,
  ) => (
    <View style={styles.swipeAction}>
      <TouchableOpacity
        style={styles.deleteAction}
        onPress={() => deleteChat(conv)}
        testID={`swipe-delete-${conv.id}`}
        activeOpacity={0.85}
      >
        <Trash2 color="#fff" size={20} strokeWidth={2.2} />
        <Text style={styles.deleteText}>{t('common.delete')}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item }: { item: Conversation }) => {
    const other =
      item.type === 'direct'
        ? item.members.find((m) => m.id !== user?.id)
        : null;
    const subtitle = item.last_message
      ? item.last_message.kind === 'voice'
        ? '🎙 ' + (item.last_message.content || 'Voice')
        : item.last_message.kind === 'file'
        ? '📎 ' + (item.last_message.content || 'File')
        : item.last_message.kind === 'image'
        ? '📷 ' + (item.last_message.content || 'Photo')
        : item.last_message.content
      : item.type === 'group'
      ? t('chat.members_count', { count: item.members.length })
      : '';

    const photo =
      item.type === 'direct' ? other?.avatar || null : item.avatar || null;
    const muted = isConvMuted(item);

    return (
      <ReanimatedSwipeable
        renderRightActions={(p, d) => renderRightActions(p, d, item)}
        rightThreshold={40}
        friction={2}
        overshootRight={false}
      >
        <TouchableOpacity
          testID={`chat-list-item-${item.id}`}
          style={styles.row}
          activeOpacity={0.7}
          onPress={() => {
            if (openSwipeRef.current) {
              openSwipeRef.current.close();
              openSwipeRef.current = null;
            }
            router.push(`/chat/${item.id}`);
          }}
        >
          <Avatar
            name={item.name || 'Chat'}
            size={48}
            color={other?.avatar_color || theme.colors.primary}
            status={other?.status}
            showStatus={item.type === 'direct'}
            photo={photo}
          />
          <View style={styles.rowBody}>
            <View style={styles.rowTop}>
              <Text style={styles.rowName} numberOfLines={1}>
                {item.name || 'Conversation'}
              </Text>
              {muted && (
                <BellOff
                  color={theme.colors.textMuted}
                  size={13}
                  strokeWidth={2}
                  testID={`muted-icon-${item.id}`}
                />
              )}
              {item.last_message?.created_at && (
                <Text style={styles.rowTime}>
                  {formatTime(item.last_message.created_at)}
                </Text>
              )}
            </View>
            <View style={styles.rowBottom}>
              <Lock color={theme.colors.primary} size={11} strokeWidth={2} />
              <Text style={styles.rowSub} numberOfLines={1}>
                {subtitle}
              </Text>
              {item.unread_count > 0 && (
                <View style={styles.unreadBadge} testID={`unread-${item.id}`}>
                  <Text style={styles.unreadText}>{item.unread_count}</Text>
                </View>
              )}
            </View>
          </View>
        </TouchableOpacity>
      </ReanimatedSwipeable>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{t('chats.title')}</Text>
          <View style={styles.secureRow}>
            <ShieldCheck color={theme.colors.primary} size={11} strokeWidth={2} />
            <Text style={styles.secureText}>Secure messaging</Text>
          </View>
        </View>
        <TouchableOpacity
          testID="new-chat-button"
          style={styles.newBtn}
          onPress={() => router.push('/new-chat')}
          activeOpacity={0.8}
        >
          <Plus color={theme.colors.background} size={20} strokeWidth={2.5} />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Search color={theme.colors.textSecondary} size={16} />
        <TextInput
          testID="chats-search-input"
          value={q}
          onChangeText={setQ}
          placeholder={t('chats.search_placeholder')}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyCircle}>
            <Lock color={theme.colors.primary} size={28} strokeWidth={1.5} />
          </View>
          <Text style={styles.emptyTitle}>
            {q ? t('chats.no_results_for', { q }) : t('chats.no_chats')}
          </Text>
          {!q && <Text style={styles.emptySub}>{t('chats.no_chats_sub')}</Text>}
          {!q && (
            <TouchableOpacity
              testID="empty-new-chat-button"
              style={styles.emptyBtn}
              onPress={() => router.push('/new-chat')}
              activeOpacity={0.85}
            >
              <Text style={styles.emptyBtnText}>{t('chats.new_chat')}</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          testID="chats-list"
          data={filtered}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const diff = (now.getTime() - d.getTime()) / 86_400_000;
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 8,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  secureRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  secureText: { color: theme.colors.primary, fontSize: 10, letterSpacing: 1 },
  newBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    marginTop: 6,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
  },
  search: {
    flex: 1,
    color: theme.colors.textPrimary,
    paddingVertical: 10,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: theme.colors.background,
    gap: 12,
  },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  rowTime: { color: theme.colors.textMuted, fontSize: 11 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rowSub: { flex: 1, color: theme.colors.textSecondary, fontSize: 12 },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: {
    color: theme.colors.background,
    fontSize: 11,
    fontWeight: '700',
  },
  sep: { height: 1, backgroundColor: theme.colors.border, marginLeft: 76 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.primary + '40',
    marginBottom: 16,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptySub: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 24,
  },
  emptyBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.pill,
  },
  emptyBtnText: { color: theme.colors.background, fontWeight: '700' },
  swipeAction: {
    width: 100,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  deleteAction: {
    flex: 1,
    backgroundColor: theme.colors.error,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  deleteText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
