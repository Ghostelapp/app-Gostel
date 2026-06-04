import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Image,
  FlatList,
  Modal,
  Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Camera,
  Check,
  Crown,
  LogOut,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react-native';
import Avatar from '../../src/Avatar';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { pickImageAsBase64 } from '../../src/upload';

type Member = {
  id: string;
  name: string;
  email: string;
  username?: string;
  title?: string;
  avatar_color?: string;
  role?: string;
};

type Conversation = {
  id: string;
  type: string;
  name: string;
  members: Member[];
  admin_ids?: string[];
  avatar?: string | null;
};

export default function GroupInfoScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);
  const [contacts, setContacts] = useState<Member[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await api.get(`/conversations/${id}`);
      setConv(data);
      setNameDraft(data.name || '');
    } catch (e) {
      console.warn('load conv', formatApiErrorDetail(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const isAdmin = !!(conv && user && (conv.admin_ids || []).includes(user.id));

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === conv?.name) {
      setEditingName(false);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.patch(`/conversations/${id}`, { name: trimmed });
      setConv(data);
      setEditingName(false);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setSaving(false);
    }
  };

  const changeAvatar = async () => {
    if (!isAdmin) return;
    try {
      const result = await pickImageAsBase64({ aspect: [1, 1], allowsEditing: true });
      if (!result) return;
      setSaving(true);
      const dataUri = `data:${result.mime};base64,${result.base64}`;
      // Approx size guard ~150KB
      if (dataUri.length > 200_000) {
        Alert.alert('Image too large', 'Please pick a smaller image (< 150KB).');
        return;
      }
      const { data } = await api.patch(`/conversations/${id}`, { avatar: dataUri });
      setConv(data);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setSaving(false);
    }
  };

  const promote = async (memberId: string) => {
    try {
      const { data } = await api.post(`/conversations/${id}/admins/${memberId}`);
      setConv(data);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const demote = async (memberId: string) => {
    try {
      const { data } = await api.delete(`/conversations/${id}/admins/${memberId}`);
      setConv(data);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const removeMember = (member: Member) => {
    Alert.alert(
      'Remove member?',
      `${member.name} will be removed from the group.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete(`/conversations/${id}/members/${member.id}`);
              await load();
            } catch (e) {
              Alert.alert('Error', formatApiErrorDetail(e));
            }
          },
        },
      ],
    );
  };

  const leaveGroup = () => {
    if (!user) return;
    Alert.alert(
      'Leave group?',
      'You won’t receive new messages from this group.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete(`/conversations/${id}/members/${user.id}`);
              router.replace('/(tabs)/chats');
            } catch (e) {
              Alert.alert('Error', formatApiErrorDetail(e));
            }
          },
        },
      ],
    );
  };

  const openAddMember = async () => {
    try {
      const { data } = await api.get('/contacts');
      setContacts(data);
      setShowAddMember(true);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const addMembers = async (memberIds: string[]) => {
    try {
      const { data } = await api.post(`/conversations/${id}/members`, {
        member_ids: memberIds,
      });
      setConv(data);
      setShowAddMember(false);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  if (loading || !conv) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </SafeAreaView>
    );
  }

  const adminIds = new Set(conv.admin_ids || []);
  const memberCount = (conv.members || []).length;
  const existingMemberIds = new Set((conv.members || []).map((m) => m.id));
  const addableContacts = contacts.filter(
    (c) => !existingMemberIds.has(c.id) && c.role !== 'bot',
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="group-info-back"
          onPress={() => router.back()}
          style={styles.iconBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ArrowLeft color={theme.colors.textPrimary} size={22} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Group info</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={styles.heroSection}>
          <TouchableOpacity
            onPress={changeAvatar}
            disabled={!isAdmin || saving}
            activeOpacity={0.8}
            testID="group-avatar-pick"
          >
            <View style={styles.avatarWrap}>
              {conv.avatar ? (
                <Image source={{ uri: conv.avatar }} style={styles.avatarImg} />
              ) : (
                <Avatar name={conv.name} size={96} color={theme.colors.primary} />
              )}
              {isAdmin && (
                <View style={styles.avatarBadge}>
                  <Camera color="#fff" size={14} strokeWidth={2.5} />
                </View>
              )}
            </View>
          </TouchableOpacity>

          {editingName ? (
            <View style={styles.nameEditRow}>
              <TextInput
                testID="group-name-edit"
                value={nameDraft}
                onChangeText={setNameDraft}
                style={styles.nameInput}
                autoFocus
                maxLength={80}
                placeholderTextColor={theme.colors.textMuted}
              />
              <TouchableOpacity
                onPress={saveName}
                disabled={saving}
                style={styles.saveBtn}
                testID="group-name-save"
              >
                {saving ? (
                  <ActivityIndicator color={theme.colors.background} size="small" />
                ) : (
                  <Check color={theme.colors.background} size={16} strokeWidth={2.5} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setNameDraft(conv.name);
                  setEditingName(false);
                }}
                style={styles.cancelBtnSmall}
              >
                <X color={theme.colors.textSecondary} size={16} strokeWidth={2.5} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => isAdmin && setEditingName(true)}
              disabled={!isAdmin}
              activeOpacity={isAdmin ? 0.6 : 1}
              testID="group-name"
            >
              <Text style={styles.groupName}>{conv.name || 'Unnamed group'}</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.subtitle}>
            {memberCount} {memberCount === 1 ? 'member' : 'members'} • Secure
          </Text>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Members</Text>
            {/* Any group member can add new people (from their contacts). */}
            <TouchableOpacity
              onPress={openAddMember}
              style={styles.addMemberBtn}
              testID="group-add-member"
            >
              <UserPlus color={theme.colors.primary} size={14} strokeWidth={2.5} />
              <Text style={styles.addMemberText}>Add</Text>
            </TouchableOpacity>
          </View>
          {(conv.members || []).map((m) => {
            const memberIsAdmin = adminIds.has(m.id);
            const isMe = m.id === user?.id;
            return (
              <View key={m.id} style={styles.memberRow} testID={`member-${m.id}`}>
                <Avatar name={m.name} color={m.avatar_color} size={42} />
                <View style={styles.memberBody}>
                  <View style={styles.memberNameRow}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {m.name}
                      {isMe ? ' (you)' : ''}
                    </Text>
                    {memberIsAdmin && (
                      <View style={styles.adminBadge}>
                        <Crown color={theme.colors.warning} size={11} strokeWidth={2.5} />
                        <Text style={styles.adminBadgeText}>Admin</Text>
                      </View>
                    )}
                  </View>
                  {m.username ? (
                    <Text style={styles.memberSub}>@{m.username}</Text>
                  ) : null}
                </View>
                {isAdmin && !isMe && m.role !== 'bot' && (
                  <View style={styles.memberActions}>
                    {memberIsAdmin ? (
                      <TouchableOpacity
                        style={styles.memberActionBtn}
                        onPress={() => demote(m.id)}
                        testID={`demote-${m.id}`}
                      >
                        <Text style={styles.memberActionText}>Demote</Text>
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        style={styles.memberActionBtn}
                        onPress={() => promote(m.id)}
                        testID={`promote-${m.id}`}
                      >
                        <Crown color={theme.colors.warning} size={14} strokeWidth={2.5} />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.memberActionBtn, styles.removeBtn]}
                      onPress={() => removeMember(m)}
                      testID={`remove-member-${m.id}`}
                    >
                      <UserMinus color={theme.colors.error} size={14} strokeWidth={2.5} />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </View>

        <View style={styles.section}>
          <TouchableOpacity
            style={styles.leaveBtn}
            onPress={leaveGroup}
            testID="group-leave"
          >
            <LogOut color={theme.colors.error} size={18} strokeWidth={2} />
            <Text style={styles.leaveText}>Leave group</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal
        visible={showAddMember}
        animationType="slide"
        onRequestClose={() => setShowAddMember(false)}
      >
        <AddMemberPicker
          contacts={addableContacts}
          onCancel={() => setShowAddMember(false)}
          onSubmit={addMembers}
        />
      </Modal>
    </SafeAreaView>
  );
}

function AddMemberPicker({
  contacts,
  onCancel,
  onSubmit,
}: {
  contacts: Member[];
  onCancel: () => void;
  onSubmit: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} style={styles.iconBtn} testID="add-member-cancel">
          <X color={theme.colors.textPrimary} size={22} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add members</Text>
        <TouchableOpacity
          style={[
            styles.headerActionBtn,
            selected.size === 0 && { opacity: 0.4 },
          ]}
          disabled={selected.size === 0}
          onPress={() => onSubmit(Array.from(selected))}
          testID="add-member-submit"
        >
          <Text style={styles.headerActionText}>
            Add {selected.size > 0 ? `(${selected.size})` : ''}
          </Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.id);
          return (
            <TouchableOpacity
              style={[styles.memberRow, isSelected && { backgroundColor: theme.colors.surface }]}
              onPress={() => toggle(item.id)}
              activeOpacity={0.7}
              testID={`pick-contact-${item.id}`}
            >
              <Avatar name={item.name} color={item.avatar_color} size={42} />
              <View style={styles.memberBody}>
                <Text style={styles.memberName}>{item.name}</Text>
                {item.username ? (
                  <Text style={styles.memberSub}>@{item.username}</Text>
                ) : null}
              </View>
              <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                {isSelected && (
                  <Check color={theme.colors.background} size={14} strokeWidth={3} />
                )}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            All your contacts are already in this group.
          </Text>
        }
      />
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
  iconBtn: { padding: 4 },
  headerTitle: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
  },
  headerActionText: {
    color: theme.colors.background,
    fontWeight: '700',
    fontSize: 13,
  },
  heroSection: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 16,
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: 12,
  },
  avatarImg: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: theme.colors.surface,
  },
  avatarBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: theme.colors.background,
  },
  groupName: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    marginTop: 4,
  },
  nameEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  nameInput: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '600',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  saveBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnSmall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginTop: 20,
    paddingHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  addMemberBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  addMemberText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  memberBody: { flex: 1 },
  memberNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  memberName: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  memberSub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  adminBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.warning + '20',
  },
  adminBadgeText: {
    color: theme.colors.warning,
    fontSize: 10,
    fontWeight: '700',
  },
  memberActions: { flexDirection: 'row', gap: 6 },
  memberActionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32,
    minHeight: 32,
  },
  memberActionText: {
    color: theme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  removeBtn: { backgroundColor: theme.colors.error + '20' },
  leaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    backgroundColor: theme.colors.error + '15',
    borderWidth: 1,
    borderColor: theme.colors.error + '40',
    borderRadius: theme.radius.lg,
  },
  leaveText: {
    color: theme.colors.error,
    fontSize: 15,
    fontWeight: '600',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  empty: {
    color: theme.colors.textSecondary,
    textAlign: 'center',
    padding: 32,
    fontSize: 14,
  },
});
