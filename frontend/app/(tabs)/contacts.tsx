import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Search,
  MessageSquare,
  UserPlus,
  X,
  Check,
  Clock,
  AtSign,
  Trash2,
  Send,
  Phone,
} from 'lucide-react-native';import Avatar from '../../src/Avatar';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';
import { useWebSocket } from '../../src/ws';
import { useTranslation } from 'react-i18next';

type Contact = {
  id: string;
  name: string;
  email: string;
  username?: string;
  title?: string;
  status?: string;
  avatar_color?: string;
  avatar?: string | null;
  last_seen?: string | null;
  last_active?: string | null;
  role?: string;
};

type Invitation = {
  id: string;
  from_user: Contact;
  to_user: Contact;
  status: string;
  created_at: string;
};

type SearchResult = Contact;

export default function ContactsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [incoming, setIncoming] = useState<Invitation[]>([]);
  const [outgoing, setOutgoing] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cRes, iRes] = await Promise.all([
        api.get('/contacts'),
        api.get('/contacts/invitations'),
      ]);
      setContacts(cRes.data);
      setIncoming(iRes.data.incoming || []);
      setOutgoing(iRes.data.outgoing || []);
    } catch (e) {
      console.warn('load contacts', formatApiErrorDetail(e));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        setLoading(true);
        await load();
        setLoading(false);
      })();
    }, [load])
  );

  // Live updates
  useWebSocket(
    useCallback(
      (msg: any) => {
        if (
          msg?.type === 'contact:invite' ||
          msg?.type === 'contact:accepted' ||
          msg?.type === 'contact:rejected' ||
          msg?.type === 'contact:cancelled'
        ) {
          load();
        }
      },
      [load]
    )
  );

  const filtered = q
    ? contacts.filter((c) => {
        const t = q.toLowerCase();
        return (
          (c.name || '').toLowerCase().includes(t) ||
          (c.username || '').toLowerCase().includes(t) ||
          (c.title || '').toLowerCase().includes(t)
        );
      })
    : contacts;

  const openChat = async (contactId: string) => {
    try {
      const { data } = await api.post('/conversations', {
        type: 'direct',
        member_ids: [contactId],
      });
      router.push(`/chat/${data.id}`);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const callContact = async (contactId: string) => {
    try {
      // Find or create direct conversation
      const { data: conv } = await api.post('/conversations', {
        type: 'direct',
        member_ids: [contactId],
      });
      // Start the call
      const { data: call } = await api.post('/calls/start', {
        conversation_id: conv.id,
      });
      router.push(`/call/${call.id}?role=caller&conversation_id=${conv.id}`);
    } catch (e) {
      Alert.alert('Cannot start call', formatApiErrorDetail(e));
    }
  };

  const acceptInvite = async (inv: Invitation) => {
    try {
      await api.post(`/contacts/invitations/${inv.id}/accept`);
      await load();
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const rejectInvite = async (inv: Invitation) => {
    try {
      await api.post(`/contacts/invitations/${inv.id}/reject`);
      await load();
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const cancelInvite = async (inv: Invitation) => {
    try {
      await api.delete(`/contacts/invitations/${inv.id}`);
      await load();
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const removeContact = (contact: Contact) => {
    // Action menu — Block / Remove / Cancel
    Alert.alert(
      contact.name,
      `@${contact.username}`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('contacts.block') + ' ' + (contact.name || ''),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.post(`/users/me/blocked/${contact.id}`);
              await load();
            } catch (e) {
              Alert.alert(t('common.error'), formatApiErrorDetail(e));
            }
          },
        },
        {
          text: t('contacts.remove_from_contacts'),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete(`/contacts/${contact.id}`);
              await load();
            } catch (e) {
              Alert.alert(t('common.error'), formatApiErrorDetail(e));
            }
          },
        },
      ]
    );
  };

  const renderContact = ({ item }: { item: Contact }) => {
    return (
      <TouchableOpacity
        testID={`contact-row-${item.id}`}
        style={styles.row}
        onPress={() => openChat(item.id)}
        onLongPress={() => removeContact(item)}
        activeOpacity={0.7}
      >
        <Avatar
          name={item.name}
          color={item.avatar_color}
          size={48}
          photo={item.avatar}
          status={item.status}
          showStatus
        />
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowName} numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          {item.username ? (
            <Text style={styles.rowSub} numberOfLines={1}>
              @{item.username}
              {item.title ? ` • ${item.title}` : ''}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.chatBtn}
          onPress={() => openChat(item.id)}
          testID={`contact-chat-${item.id}`}
        >
          <MessageSquare color={theme.colors.primary} size={18} strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.callBtn}
          onPress={() => callContact(item.id)}
          testID={`contact-call-${item.id}`}
        >
          <Phone color={theme.colors.success} size={18} strokeWidth={2} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.removeIconBtn}
          onPress={() => removeContact(item)}
          testID={`contact-remove-${item.id}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Trash2 color={theme.colors.error} size={16} strokeWidth={2} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  const renderIncoming = (inv: Invitation) => (
    <View key={inv.id} style={styles.inviteCard}>
      <Avatar
        name={inv.from_user?.name || '?'}
        color={inv.from_user?.avatar_color}
        size={44}
        photo={inv.from_user?.avatar}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {inv.from_user?.name || t('contacts.unknown_user')}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          @{inv.from_user?.username} · {t('contacts.invite_received')}
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.actionBtn, styles.acceptBtn]}
        onPress={() => acceptInvite(inv)}
        testID={`accept-${inv.id}`}
      >
        <Check color="#fff" size={16} strokeWidth={2.5} />
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.actionBtn, styles.rejectBtn]}
        onPress={() => rejectInvite(inv)}
        testID={`reject-${inv.id}`}
      >
        <X color="#fff" size={16} strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );

  const renderOutgoing = (inv: Invitation) => (
    <View key={inv.id} style={styles.outgoingCard}>
      <Clock color={theme.colors.warning} size={16} strokeWidth={2} />
      <View style={styles.rowBody}>
        <Text style={styles.rowSub} numberOfLines={1}>
          {t('contacts.invite_sent')} →{' '}
          <Text style={{ color: theme.colors.textPrimary, fontWeight: '600' }}>
            @{inv.to_user?.username}
          </Text>
        </Text>
      </View>
      <TouchableOpacity
        style={styles.cancelLink}
        onPress={() => cancelInvite(inv)}
        testID={`cancel-${inv.id}`}
      >
        <Text style={styles.cancelLinkText}>{t('common.cancel')}</Text>
      </TouchableOpacity>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{t('contacts.title')}</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setShowAddModal(true)}
          testID="open-add-contact"
        >
          <UserPlus color={theme.colors.background} size={18} strokeWidth={2.5} />
          <Text style={styles.addBtnText}>{t('contacts.add_contact')}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Search color={theme.colors.textMuted} size={16} strokeWidth={2} />
        <TextInput
          testID="contacts-search"
          placeholder={t('common.search') + '…'}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.searchInput}
          value={q}
          onChangeText={setQ}
          autoCapitalize="none"
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        renderItem={renderContact}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListHeaderComponent={
          <View>
            {incoming.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>
                  {t('contacts.pending')} · {incoming.length}
                </Text>
                {incoming.map(renderIncoming)}
              </View>
            )}
            {outgoing.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('contacts.sent_invitations')}</Text>
                {outgoing.map(renderOutgoing)}
              </View>
            )}
            {contacts.length > 0 && (
              <Text style={styles.sectionTitle}>
                {t('contacts.title')} · {contacts.length}
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          q ? null : (
            <View style={styles.emptyWrap}>
              <UserPlus color={theme.colors.textMuted} size={40} strokeWidth={1.5} />
              <Text style={styles.emptyTitle}>{t('contacts.no_contacts')}</Text>
              <Text style={styles.emptyText}>
                {t('contacts.no_contacts_sub')}
              </Text>
            </View>
          )
        }
      />

      <AddContactModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onInvited={load}
      />
    </SafeAreaView>
  );
}

function AddContactModal({
  visible,
  onClose,
  onInvited,
}: {
  visible: boolean;
  onClose: () => void;
  onInvited: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [recentInvited, setRecentInvited] = useState<Set<string>>(new Set());
  const debounceRef = useRef<any>(null);

  useEffect(() => {
    if (!visible) {
      setQ('');
      setResults([]);
      setRecentInvited(new Set());
    }
  }, [visible]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q || q.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get('/users/search', { params: { q } });
        setResults(data);
      } catch (e) {
        console.warn('search', formatApiErrorDetail(e));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [q]);

  const invite = async (u: SearchResult) => {
    setInviting(u.id);
    try {
      await api.post('/contacts/invite', { username: u.username });
      setRecentInvited((prev) => new Set(prev).add(u.id));
      onInvited();
    } catch (e: any) {
      Alert.alert(t('contacts.cannot_invite'), formatApiErrorDetail(e));
    } finally {
      setInviting(null);
    }
  };

  const inviteByExactUsername = async () => {
    const un = q.trim().replace(/^@/, '');
    if (!un) return;
    setInviting('exact');
    try {
      await api.post('/contacts/invite', { username: un });
      onInvited();
      onClose();
      if (Platform.OS !== 'web') {
        Alert.alert(
          t('contacts.invitation_sent'),
          `@${un}`,
        );
      }
    } catch (e) {
      Alert.alert(t('contacts.cannot_invite'), formatApiErrorDetail(e));
    } finally {
      setInviting(null);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={styles.modalContainer} edges={['top']}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalHeader}>
            <TouchableOpacity
              onPress={onClose}
              testID="close-add-contact"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <X color={theme.colors.textPrimary} size={22} strokeWidth={2} />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>{t('contacts.add_contact')}</Text>
            <View style={{ width: 22 }} />
          </View>

          <View style={styles.modalBody}>
            <Text style={styles.modalLabel}>{t('contacts.find_by_username')}</Text>
            <View style={styles.searchWrap}>
              <AtSign color={theme.colors.textMuted} size={16} strokeWidth={2} />
              <TextInput
                testID="add-contact-search"
                placeholder="jan_kowalski"
                placeholderTextColor={theme.colors.textMuted}
                style={styles.searchInput}
                value={q}
                onChangeText={setQ}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              {searching && (
                <ActivityIndicator color={theme.colors.primary} size="small" />
              )}
            </View>

            {results.length === 0 && q.length >= 2 && !searching ? (
              <View style={styles.noResults}>
                <Text style={styles.noResultsText}>
                  {t('chats.no_results_for', { q })}
                </Text>
                <TouchableOpacity
                  style={styles.inviteAnywayBtn}
                  onPress={inviteByExactUsername}
                  disabled={inviting === 'exact'}
                  testID="invite-exact-button"
                >
                  {inviting === 'exact' ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Send color="#fff" size={14} strokeWidth={2.5} />
                      <Text style={styles.inviteAnywayText}>
                        {t('contacts.invite')} @{q.replace(/^@/, '')}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : null}

            <FlatList
              data={results}
              keyExtractor={(u) => u.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const wasInvited = recentInvited.has(item.id);
                return (
                  <View style={styles.row}>
                    <Avatar
                      name={item.name}
                      color={item.avatar_color}
                      size={44}
                      photo={item.avatar}
                    />
                    <View style={styles.rowBody}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        @{item.username}
                        {item.title ? ` • ${item.title}` : ''}
                      </Text>
                    </View>
                    {wasInvited ? (
                      <View style={[styles.inviteBtn, styles.invitedBtn]}>
                        <Check color={theme.colors.success} size={14} strokeWidth={2.5} />
                        <Text style={styles.invitedText}>{t('contacts.invite_sent')}</Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={styles.inviteBtn}
                        onPress={() => invite(item)}
                        disabled={inviting === item.id}
                        testID={`invite-${item.username}`}
                      >
                        {inviting === item.id ? (
                          <ActivityIndicator color="#fff" size="small" />
                        ) : (
                          <>
                            <UserPlus color="#fff" size={14} strokeWidth={2.5} />
                            <Text style={styles.inviteBtnText}>{t('contacts.invite')}</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
                );
              }}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: {
    flex: 1,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: theme.radius.pill,
  },
  addBtnText: {
    color: theme.colors.background,
    fontWeight: '600',
    fontSize: 14,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: theme.colors.textPrimary,
    paddingVertical: 0,
  },
  section: { marginBottom: 4 },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowBody: { flex: 1 },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowName: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  rowSub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  chatBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.success + '20',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  removeIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.error + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  inviteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary + '15',
    borderWidth: 1,
    borderColor: theme.colors.primary + '40',
  },
  outgoingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtn: { backgroundColor: theme.colors.success },
  rejectBtn: { backgroundColor: theme.colors.error },
  cancelLink: { paddingHorizontal: 8, paddingVertical: 4 },
  cancelLinkText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 80,
    gap: 8,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  modalTitle: {
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  modalBody: { flex: 1, paddingTop: 8 },
  modalLabel: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginHorizontal: 16,
    marginTop: 8,
  },
  modalHint: {
    color: theme.colors.textMuted,
    fontSize: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    lineHeight: 16,
  },
  inviteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.pill,
    minWidth: 78,
    justifyContent: 'center',
  },
  inviteBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  invitedBtn: {
    backgroundColor: theme.colors.success + '20',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  invitedText: {
    color: theme.colors.success,
    fontWeight: '600',
    fontSize: 13,
  },
  noResults: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 12,
  },
  noResultsText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  inviteAnywayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radius.pill,
  },
  inviteAnywayText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
});
