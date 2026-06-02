/**
 * BadgeProvider — Centralised polling of unread/missed counts to drive
 * notification badges on bottom-tab icons.
 *
 * Polls every 30 seconds while user is authenticated:
 *  - chats: sum of `unread_count` from /api/conversations
 *  - contacts: count of pending received invitations
 *  - calls: count of missed calls (filled once Phase B adds the endpoint)
 *
 * Consumers use `useBadges()` to read current counts.
 * Components can call `refreshBadges()` after sending/receiving relevant
 * mutations to refresh immediately.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import { api } from './api';
import { useAuth } from './auth';
import { useWebSocket } from './ws';

const POLL_MS = 60_000; // safety net poll (WS handles real-time)

type BadgeCounts = {
  chats: number;
  contacts: number;
  calls: number;
};

type BadgeCtx = BadgeCounts & {
  refresh: () => Promise<void>;
  /** Bump a specific badge optimistically (used when receiving WS events
   *  to provide instant visual feedback before refresh resolves). */
  bump: (key: keyof BadgeCounts, delta?: number) => void;
};

const DEFAULT: BadgeCounts = { chats: 0, contacts: 0, calls: 0 };

const BadgeContext = createContext<BadgeCtx>({
  ...DEFAULT,
  refresh: async () => {},
  bump: () => {},
});

export function BadgeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [counts, setCounts] = useState<BadgeCounts>(DEFAULT);
  const timerRef = useRef<any>(null);
  const refreshTimeoutRef = useRef<any>(null);

  const fetchOnce = useCallback(async () => {
    if (!user) {
      setCounts(DEFAULT);
      return;
    }
    const next: BadgeCounts = { chats: 0, contacts: 0, calls: 0 };
    try {
      const { data } = await api.get('/conversations');
      const list = Array.isArray(data) ? data : [];
      let total = 0;
      for (const c of list) {
        const n = Number(c?.unread_count) || 0;
        if (n > 0) total += n;
      }
      next.chats = total;
    } catch {
      /* ignore */
    }
    try {
      const { data } = await api.get('/contacts/invitations');
      const received = Array.isArray(data?.received) ? data.received : [];
      next.contacts = received.length;
    } catch {
      /* ignore */
    }
    try {
      const { data } = await api.get('/calls/missed');
      next.calls = Number(data?.count) || 0;
    } catch {
      next.calls = 0;
    }
    setCounts(next);
    // Mirror unread count onto the system app icon badge (iOS + Android 8+).
    try {
      if (Platform.OS !== 'web') {
        const Notifications = require('expo-notifications');
        const total = next.chats + next.contacts + next.calls;
        Notifications.setBadgeCountAsync?.(total).catch(() => {});
      }
    } catch {
      /* expo-notifications not available */
    }
  }, [user]);

  const refresh = useCallback(async () => {
    await fetchOnce();
  }, [fetchOnce]);

  const bump = useCallback((key: keyof BadgeCounts, delta = 1) => {
    setCounts((prev) => ({ ...prev, [key]: Math.max(0, prev[key] + delta) }));
  }, []);

  // Debounced refresh — multiple WS events in quick succession only trigger one fetch
  const scheduleRefresh = useCallback(
    (delayMs = 400) => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = setTimeout(() => {
        refreshTimeoutRef.current = null;
        fetchOnce();
      }, delayMs);
    },
    [fetchOnce]
  );

  // -------- WebSocket listener — real-time badge updates --------
  const onWsMessage = useCallback(
    (msg: any) => {
      if (!msg || !msg.type || !user) return;
      const senderId = msg.data?.sender_id || msg.data?.caller_id || msg.from;
      // Ignore events we caused ourselves
      if (senderId && senderId === user.id) return;

      switch (msg.type) {
        case 'message': {
          // New message in some conversation — bump chats badge
          bump('chats', 1);
          scheduleRefresh();
          break;
        }
        case 'conversation:update':
        case 'conversation:read':
        case 'messages:read': {
          // Read receipts / conversation changes — refresh to get accurate count
          scheduleRefresh();
          break;
        }
        case 'contact:invite':
        case 'contact:request': {
          bump('contacts', 1);
          scheduleRefresh();
          break;
        }
        case 'contact:accepted':
        case 'contact:declined': {
          scheduleRefresh();
          break;
        }
        case 'call:incoming': {
          // Missed call may be incremented later when call ends without answer.
          // We schedule a refresh — backend will reflect accurate state.
          scheduleRefresh(2_000);
          break;
        }
        case 'call:ended':
        case 'call:end': {
          scheduleRefresh(1_500);
          break;
        }
      }
    },
    [user, bump, scheduleRefresh]
  );

  useWebSocket(onWsMessage, !!user);

  // -------- Background polling (safety net + initial load) --------
  useEffect(() => {
    if (!user) {
      setCounts(DEFAULT);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    fetchOnce();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(fetchOnce, POLL_MS);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [user, fetchOnce]);

  return (
    <BadgeContext.Provider value={{ ...counts, refresh, bump }}>
      {children}
    </BadgeContext.Provider>
  );
}

export function useBadges() {
  return useContext(BadgeContext);
}
