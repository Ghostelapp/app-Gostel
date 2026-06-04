import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { ChevronLeft, ShieldOff, RotateCcw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import Avatar from '../../src/Avatar';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';

type BlockedUser = {
  id: string;
  name?: string;
  username?: string;
  email?: string;
  avatar_color?: string;
};

export default function BlockedUsersScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [users, setUsers] = useState<BlockedUser[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const fetchList = useCallback(async () => {
    try {
      const { data } = await api.get('/users/me/blocked');
      setUsers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.warn('blocked fetch failed', formatApiErrorDetail(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchList();
  };

  const unblock = async (u: BlockedUser) => {
    Alert.alert(
      t('contacts.unblock'),
      `${t('contacts.unblock')} ${u.name || u.username || u.email || ''}?`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('contacts.unblock'),
          onPress: async () => {
            setBusyIds((s) => new Set(s).add(u.id));
            try {
              await api.delete(`/users/me/blocked/${u.id}`);
              setUsers((prev) => prev.filter((x) => x.id !== u.id));
            } catch (e) {
              Alert.alert(t('common.error'), formatApiErrorDetail(e));
            } finally {
              setBusyIds((s) => {
                const n = new Set(s);
                n.delete(u.id);
                return n;
              });
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: BlockedUser }) => {
    const name = item.name || item.username || item.email || 'Unknown';
    const isBusy = busyIds.has(item.id);
    return (
      <View style={styles.row}>
        <Avatar
          name={name}
          color={item.avatar_color || theme.colors.primaryDark}
          size={42}
        />
        <View style={styles.rowMain}>
          <Text style={styles.rowName} numberOfLines={1}>
            {name}
          </Text>
          {item.username && (
            <Text style={styles.rowSub} numberOfLines={1}>
              @{item.username}
            </Text>
          )}
        </View>
        <TouchableOpacity
          testID={`unblock-${item.id}`}
          onPress={() => unblock(item)}
          disabled={isBusy}
          style={[styles.unblockBtn, isBusy && { opacity: 0.4 }]}
          activeOpacity={0.85}
        >
          <RotateCcw color={theme.colors.primary} size={14} strokeWidth={2.2} />
          <Text style={styles.unblockBtnText}>{t('contacts.unblock')}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity
          testID="back-button"
          onPress={() => router.back()}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <ChevronLeft color={theme.colors.textPrimary} size={26} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('profile.blocked_users')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          renderItem={renderItem}
          contentContainerStyle={
            users.length === 0 ? styles.scrollEmpty : styles.scroll
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <ShieldOff
                  color={theme.colors.primary}
                  size={26}
                  strokeWidth={1.6}
                />
              </View>
              <Text style={styles.emptyTitle}>
                {t('contacts.no_contacts')}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
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
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  scroll: { padding: 12 },
  scrollEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
  },
  rowMain: { flex: 1 },
  rowName: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  rowSub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  unblockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: theme.colors.primaryDark,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  unblockBtnText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  separator: { height: 8 },
  empty: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  emptyTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});
