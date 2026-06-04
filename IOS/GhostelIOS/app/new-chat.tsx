import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, Search, Check, Users } from 'lucide-react-native';
import Avatar from '../src/Avatar';
import { api, formatApiErrorDetail } from '../src/api';
import { theme } from '../src/theme';

type Contact = {
  id: string;
  name: string;
  email: string;
  title?: string;
  avatar_color?: string;
};

export default function NewChatScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/users');
      setItems(data);
    } catch (e) {
      console.warn(formatApiErrorDetail(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = q
    ? items.filter(
        (c) =>
          c.name.toLowerCase().includes(q.toLowerCase()) ||
          (c.email || '').toLowerCase().includes(q.toLowerCase())
      )
    : items;

  const create = async () => {
    if (selected.size === 0) {
      Alert.alert('Select members', 'Choose at least one teammate.');
      return;
    }
    setCreating(true);
    try {
      const memberIds = Array.from(selected);
      const isGroup = memberIds.length > 1;
      const { data } = await api.post('/conversations', {
        type: isGroup ? 'group' : 'direct',
        member_ids: memberIds,
        name: isGroup ? groupName.trim() || 'New Group' : null,
      });
      router.replace(`/chat/${data.id}`);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setCreating(false);
    }
  };

  const renderItem = ({ item }: { item: Contact }) => {
    const isSelected = selected.has(item.id);
    return (
      <TouchableOpacity
        testID={`select-contact-${item.id}`}
        style={[styles.row, isSelected && styles.rowSelected]}
        onPress={() => toggle(item.id)}
        activeOpacity={0.7}
      >
        <Avatar name={item.name} color={item.avatar_color} size={42} />
        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {item.title || item.email}
          </Text>
        </View>
        <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
          {isSelected && <Check color={theme.colors.background} size={14} strokeWidth={3} />}
        </View>
      </TouchableOpacity>
    );
  };

  const isGroup = selected.size > 1;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="newchat-back-button"
          onPress={() => router.back()}
          style={{ padding: 6 }}
        >
          <ArrowLeft color={theme.colors.textPrimary} size={22} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>New conversation</Text>
          <Text style={styles.sub}>{selected.size} selected</Text>
        </View>
        <TouchableOpacity
          testID="newchat-create-button"
          onPress={create}
          disabled={creating || selected.size === 0}
          style={[
            styles.createBtn,
            (creating || selected.size === 0) && { opacity: 0.4 },
          ]}
          activeOpacity={0.85}
        >
          {creating ? (
            <ActivityIndicator color={theme.colors.background} />
          ) : (
            <Text style={styles.createText}>{isGroup ? 'Create' : 'Start'}</Text>
          )}
        </TouchableOpacity>
      </View>

      {isGroup && (
        <View style={styles.groupNameWrap}>
          <Users color={theme.colors.primary} size={16} />
          <TextInput
            testID="group-name-input"
            value={groupName}
            onChangeText={setGroupName}
            placeholder="Group name (optional)"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
          />
        </View>
      )}

      <View style={styles.searchWrap}>
        <Search color={theme.colors.textSecondary} size={16} />
        <TextInput
          testID="newchat-search-input"
          value={q}
          onChangeText={setQ}
          placeholder="Search teammates"
          placeholderTextColor={theme.colors.textMuted}
          style={styles.input}
        />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          testID="newchat-list"
          data={filtered}
          keyExtractor={(c) => c.id}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.divider} />}
          ListEmptyComponent={
            <Text style={styles.empty}>No teammates found</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '600' },
  sub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  createBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
  },
  createText: { color: theme.colors.background, fontWeight: '700' },
  groupNameWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    height: 44,
    backgroundColor: theme.colors.surface,
    margin: 14,
    marginBottom: 0,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    height: 40,
    backgroundColor: theme.colors.surface,
    margin: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  input: { flex: 1, color: theme.colors.textPrimary, fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowSelected: { backgroundColor: theme.colors.surface },
  body: { flex: 1 },
  name: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  divider: { height: 1, backgroundColor: theme.colors.border, marginLeft: 70 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  empty: {
    color: theme.colors.textSecondary,
    textAlign: 'center',
    padding: 32,
    fontSize: 14,
  },
});
