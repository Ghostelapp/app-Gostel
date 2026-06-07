import React, { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { api, formatApiErrorDetail } from './api';
import { getStoredToken, removeStoredToken, setStoredToken } from './tokenStorage';
import { registerPushNotificationsAsync } from './push';
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
      const token = await getStoredToken();
      if (token) {
        await refreshUser();
      }
      setLoading(false);
    })();
  }, [refreshUser]);

  // Register device capabilities once a user is authenticated.
  useEffect(() => {
    if (user) {
      registerPushNotificationsAsync().catch(() => {});
      registerE2EEKey(user.id).catch(() => {});
    }
  }, [user?.id]);

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
