import React, { useEffect } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { MessageCircle, Users, PhoneCall, User, Shield } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../src/auth';
import { useBadges } from '../../src/badges';
import { theme } from '../../src/theme';

function formatBadge(n: number): string | undefined {
  if (!n || n <= 0) return undefined;
  if (n > 99) return '99+';
  return String(n);
}

export default function TabsLayout() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { chats, contacts, calls } = useBadges();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/(auth)/login');
    }
  }, [user, loading, router]);

  if (!user) return null;
  const isAdmin = user.role === 'admin';

  const bottomInset = Math.max(insets.bottom, 0);

  // Common badge styling — small red circle with white text
  const badgeStyle = {
    backgroundColor: theme.colors.error,
    color: '#fff',
    fontSize: 10,
    fontWeight: '700' as const,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    lineHeight: 18,
    paddingHorizontal: 5,
  };

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          height: 64 + bottomInset,
          paddingBottom: 10 + bottomInset,
          paddingTop: 8,
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
        tabBarBadgeStyle: badgeStyle,
      }}
    >
      <Tabs.Screen
        name="chats"
        options={{
          title: t('tabs.chats'),
          tabBarIcon: ({ color }) => <MessageCircle color={color} size={22} strokeWidth={1.8} />,
          tabBarButtonTestID: 'tab-chats',
          tabBarBadge: formatBadge(chats),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: t('tabs.contacts'),
          tabBarIcon: ({ color }) => <Users color={color} size={22} strokeWidth={1.8} />,
          tabBarButtonTestID: 'tab-contacts',
          tabBarBadge: formatBadge(contacts),
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: t('tabs.calls'),
          tabBarIcon: ({ color }) => <PhoneCall color={color} size={22} strokeWidth={1.8} />,
          tabBarButtonTestID: 'tab-calls',
          tabBarBadge: formatBadge(calls),
        }}
      />
      <Tabs.Screen
        name="admin"
        options={{
          title: t('tabs.admin'),
          tabBarIcon: ({ color }) => <Shield color={color} size={22} strokeWidth={1.8} />,
          tabBarButtonTestID: 'tab-admin',
          href: isAdmin ? '/(tabs)/admin' : null,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('tabs.profile'),
          tabBarIcon: ({ color }) => <User color={color} size={22} strokeWidth={1.8} />,
          tabBarButtonTestID: 'tab-profile',
        }}
      />
    </Tabs>
  );
}
