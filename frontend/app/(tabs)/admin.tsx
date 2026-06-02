import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Shield,
  Trash2,
  ChevronDown,
  Users as UsersIcon,
  MessageSquare,
  Activity,
  Bell,
  Lock,
} from 'lucide-react-native';
import Avatar from '../../src/Avatar';
import { api, formatApiErrorDetail } from '../../src/api';
import { useAuth } from '../../src/auth';
import { theme, statusColor } from '../../src/theme';

type AdminUser = {
  id: string;
  email: string;
  name: string;
  title?: string;
  role: string;
  status?: string;
  two_factor_enabled?: boolean;
  push_registered?: boolean;
  avatar_color?: string;
  last_seen?: string;
};

type Stats = {
  users: number;
  conversations: number;
  messages: number;
  online: number;
  two_factor_enabled: number;
  push_ready: number;
};

const ROLES = ['admin', 'moderator', 'user', 'guest'];

export default function AdminScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/stats'),
      ]);
      setUsers(u.data);
      setStats(s.data);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
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

  const changeRole = async (target: AdminUser, role: string) => {
    try {
      const { data } = await api.patch(`/admin/users/${target.id}/role`, { role });
      setUsers((prev) => prev.map((u) => (u.id === data.id ? data : u)));
      setEditing(null);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    }
  };

  const deleteUser = (target: AdminUser) => {
    Alert.alert(
      'Delete account',
      `Permanently delete ${target.name} (${target.email})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete(`/admin/users/${target.id}`);
              setUsers((prev) => prev.filter((u) => u.id !== target.id));
              await load();
            } catch (e) {
              Alert.alert('Error', formatApiErrorDetail(e));
            }
          },
        },
      ]
    );
  };

  if (!user || user.role !== 'admin') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.locked}>
          <Lock color={theme.colors.warning} size={32} strokeWidth={1.5} />
          <Text style={styles.lockedTitle}>Admin access required</Text>
          <Text style={styles.lockedSub}>
            Your role does not allow access to the administration console.
          </Text>
          <TouchableOpacity
            testID="admin-back-button"
            onPress={() => router.replace('/(tabs)/chats')}
            style={styles.lockedBtn}
            activeOpacity={0.85}
          >
            <Text style={styles.lockedBtnText}>Back to chats</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const renderUser = ({ item }: { item: AdminUser }) => (
    <View style={styles.row}>
      <Avatar
        name={item.name}
        color={item.avatar_color}
        status={item.status}
        showStatus
        size={40}
      />
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {item.email}
        </Text>
        <View style={styles.badges}>
          <View
            style={[
              styles.badge,
              {
                borderColor:
                  item.role === 'admin'
                    ? theme.colors.primary
                    : item.role === 'moderator'
                    ? theme.colors.warning
                    : theme.colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                {
                  color:
                    item.role === 'admin'
                      ? theme.colors.primary
                      : item.role === 'moderator'
                      ? theme.colors.warning
                      : theme.colors.textSecondary,
                },
              ]}
            >
              {item.role}
            </Text>
          </View>
          {item.two_factor_enabled && (
            <View style={[styles.badge, { borderColor: theme.colors.success }]}>
              <Text style={[styles.badgeText, { color: theme.colors.success }]}>2FA</Text>
            </View>
          )}
          {item.push_registered && (
            <View style={[styles.badge, { borderColor: theme.colors.primaryDark }]}>
              <Text style={[styles.badgeText, { color: theme.colors.primary }]}>PUSH</Text>
            </View>
          )}
        </View>
      </View>
      <TouchableOpacity
        testID={`edit-role-${item.id}`}
        style={styles.actionBtn}
        onPress={() => setEditing(item)}
        activeOpacity={0.7}
      >
        <ChevronDown color={theme.colors.textSecondary} size={18} />
      </TouchableOpacity>
      {item.id !== user.id && (
        <TouchableOpacity
          testID={`delete-user-${item.id}`}
          style={[styles.actionBtn, { backgroundColor: '#3a1f1f' }]}
          onPress={() => deleteUser(item)}
          activeOpacity={0.7}
        >
          <Trash2 color={theme.colors.error} size={16} />
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Admin</Text>
          <View style={styles.subRow}>
            <Shield color={theme.colors.primary} size={11} strokeWidth={2.5} />
            <Text style={styles.sub}>Workspace administration console</Text>
          </View>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          testID="admin-users-list"
          data={users}
          keyExtractor={(u) => u.id}
          renderItem={renderUser}
          ListHeaderComponent={
            stats ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.statsRow}
              >
                <StatCard
                  icon={<UsersIcon color={theme.colors.primary} size={18} />}
                  label="Members"
                  value={stats.users}
                />
                <StatCard
                  icon={<Activity color={theme.colors.success} size={18} />}
                  label="Online"
                  value={stats.online}
                />
                <StatCard
                  icon={<MessageSquare color={theme.colors.warning} size={18} />}
                  label="Messages"
                  value={stats.messages}
                />
                <StatCard
                  icon={<Shield color={theme.colors.primary} size={18} />}
                  label="2FA"
                  value={stats.two_factor_enabled}
                />
                <StatCard
                  icon={<Bell color={theme.colors.primary} size={18} />}
                  label="Push"
                  value={stats.push_ready}
                />
              </ScrollView>
            ) : null
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}

      <Modal
        visible={!!editing}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <TouchableOpacity
          style={styles.modalBg}
          activeOpacity={1}
          onPress={() => setEditing(null)}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>
              Change role for {editing?.name}
            </Text>
            {ROLES.map((r) => (
              <TouchableOpacity
                key={r}
                testID={`role-${r}`}
                style={[
                  styles.modalRow,
                  editing?.role === r && styles.modalRowActive,
                ]}
                onPress={() => editing && changeRole(editing, r)}
              >
                <Text
                  style={[
                    styles.modalText,
                    editing?.role === r && { color: theme.colors.primary, fontWeight: '700' },
                  ]}
                >
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <View style={styles.statCard}>
      {icon}
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { color: theme.colors.textPrimary, fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  sub: { color: theme.colors.primary, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  statsRow: { paddingHorizontal: 20, paddingVertical: 12, gap: 10 },
  statCard: {
    backgroundColor: theme.colors.surface,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: theme.radius.lg,
    minWidth: 96,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  statValue: {
    color: theme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    marginTop: 8,
  },
  statLabel: {
    color: theme.colors.textSecondary,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
    backgroundColor: theme.colors.background,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: '600' },
  rowSub: { color: theme.colors.textSecondary, fontSize: 12 },
  badges: { flexDirection: 'row', gap: 6, marginTop: 4 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
  },
  badgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sep: { height: 1, backgroundColor: theme.colors.border, marginLeft: 70 },
  modalBg: { flex: 1, backgroundColor: '#00000099', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 32,
  },
  modalTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600', marginBottom: 12 },
  modalRow: {
    padding: 14,
    borderRadius: theme.radius.md,
  },
  modalRowActive: { backgroundColor: theme.colors.background },
  modalText: { color: theme.colors.textPrimary, fontSize: 14 },
  locked: { flex: 1, padding: 32, alignItems: 'center', justifyContent: 'center', gap: 12 },
  lockedTitle: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '600' },
  lockedSub: { color: theme.colors.textSecondary, fontSize: 13, textAlign: 'center' },
  lockedBtn: {
    marginTop: 14,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: theme.radius.md,
  },
  lockedBtnText: { color: theme.colors.background, fontWeight: '700' },
});
