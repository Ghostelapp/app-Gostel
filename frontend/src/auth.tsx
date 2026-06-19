import React, { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import { api, formatApiErrorDetail } from './api';
import { getStoredToken, removeStoredToken, setStoredToken } from './tokenStorage';
import { registerPushNotificationsAsync, unregisterCurrentPushDeviceAsync } from './push';
import { useHeartbeat } from './presence';
import { registerE2EEKey } from './e2ee';

export type User = {
  id: string;
  email: string;
  username?: string;
  name: string;
  title?: string;
  bio?: string;
  status?: string;
  role?: string;
  two_factor_enabled?: boolean;
  avatar_color?: string;
  avatar?: string | null;
  last_seen?: string | null;
  last_active?: string | null;
  expo_push_token?: string | null;
  push_registered?: boolean;
  e2ee_public_key?: string | null;
  e2ee_key_updated_at?: string | null;
  muted_users?: Record<string, { until: string | null }>;
  muted_conversation_ids?: string[];
  blocked_user_ids?: string[];
  save_call_history?: boolean;
};

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (identifier: string, password: string, totp?: string) => Promise<{ requires_2fa?: boolean }>;
  register: (email: string, password: string, name: string, title?: string, username?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const userId = user?.id;

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      setUser(data);
    } catch {
      setUser(null);
      await removeStoredToken();
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const token = await getStoredToken();
        if (token) {
          await refreshUser();
        }
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshUser]);

  // Register device capabilities once a user is authenticated.
  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    let registrationInFlight = false;
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const registerPush = async () => {
      if (cancelled || registrationInFlight) return;
      registrationInFlight = true;
      try {
        await registerPushNotificationsAsync();
      } catch {
        /* registration is retried below */
      } finally {
        registrationInFlight = false;
      }
    };
    const schedulePushRegistration = (delayMs: number) => {
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        registerPush();
      }, delayMs);
      retryTimers.add(timer);
    };

    registerPush();
    registerE2EEKey(userId).catch(() => {});

    // APNs may expose its device token a few seconds after the first iOS app
    // launch. Retry once, then refresh registration whenever the app becomes
    // active so an Expo fallback cannot remain the call channel indefinitely.
    if (Platform.OS === 'ios') {
      schedulePushRegistration(10_000);
    }
    const appStateSub = Platform.OS === 'ios'
      ? AppState.addEventListener('change', (state) => {
          if (state === 'active') schedulePushRegistration(1_000);
        })
      : null;

    let tokenRefreshUnsub: (() => void) | null = null;
    try {
      const messaging = require('@react-native-firebase/messaging').default;
      tokenRefreshUnsub = messaging().onTokenRefresh(() => {
        registerPush();
      });
    } catch {
      /* Firebase messaging is unavailable in Expo Go/web */
    }

    return () => {
      cancelled = true;
      retryTimers.forEach(clearTimeout);
      retryTimers.clear();
      appStateSub?.remove();
      tokenRefreshUnsub?.();
    };
  }, [userId]);

  // Periodically ping /heartbeat while in foreground to keep `last_active` fresh.
  useHeartbeat(!!user, 60_000);

  const login = async (identifier: string, password: string, totp?: string) => {
    try {
      const { data } = await api.post('/auth/login', {
        identifier,
        password,
        totp_code: totp,
      });
      if (data?.requires_2fa) {
        return { requires_2fa: true };
      }
      await setStoredToken(data.access_token);
      setUser(data.user);
      return {};
    } catch (e) {
      throw new Error(formatApiErrorDetail(e));
    }
  };

  const register = async (email: string, password: string, name: string, title?: string, username?: string) => {
    try {
      const { data } = await api.post('/auth/register', { email, password, name, title, username });
      await setStoredToken(data.access_token);
      setUser(data.user);
    } catch (e) {
      throw new Error(formatApiErrorDetail(e));
    }
  };

  const logout = async () => {
    try {
      await unregisterCurrentPushDeviceAsync();
    } catch {
      // Push unregister is best-effort; auth logout must still run.
    }
    try {
      await api.post('/auth/logout');
    } catch {
      // Local logout must still succeed when the network is unavailable.
    }
    await removeStoredToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
