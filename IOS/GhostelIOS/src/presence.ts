import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { api } from './api';

/**
 * Hook: while the app is in the foreground and user is logged in, ping the server
 * every `intervalMs` to update `last_active`. Stops when app backgrounds or user
 * logs out.
 */
export function useHeartbeat(enabled: boolean, intervalMs = 60_000) {
  const timerRef = useRef<any>(null);
  const stateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (!enabled) return;

    const beat = async () => {
      try {
        await api.post('/users/me/heartbeat');
      } catch {
        /* swallow */
      }
    };

    const start = () => {
      if (timerRef.current) clearInterval(timerRef.current);
      // Fire immediately, then on interval
      beat();
      timerRef.current = setInterval(beat, intervalMs);
    };

    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    if (stateRef.current === 'active') start();

    const sub = AppState.addEventListener('change', (next) => {
      const prev = stateRef.current;
      stateRef.current = next;
      if (next === 'active' && prev !== 'active') start();
      else if (next !== 'active' && prev === 'active') stop();
    });

    return () => {
      stop();
      sub.remove();
    };
  }, [enabled, intervalMs]);
}

/** Format a `last_seen` ISO timestamp as a user-friendly string. */
export function formatLastSeen(
  isoOrNull: string | null | undefined,
  t: (k: string, o?: any) => string,
  isOnline = false,
): string {
  if (isOnline) return t('presence.online');
  if (!isoOrNull) return '';
  const d = new Date(isoOrNull);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);

  if (diffSec < 60) return t('presence.just_now');
  if (diffSec < 60 * 60) {
    const m = Math.floor(diffSec / 60);
    return t('presence.minutes_ago', { count: m });
  }

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return t('presence.last_seen_today', {
      time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) {
    return t('presence.last_seen_yesterday', {
      time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  }

  return t('presence.last_seen_on', {
    date: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
}

/**
 * Treat a user as "online" if their status is "online" AND last_active is
 * within the last 2 minutes. Otherwise we display "last seen at ...".
 */
export function isProbablyOnline(
  status: string | undefined | null,
  lastActiveIso: string | null | undefined,
): boolean {
  if (status !== 'online') return false;
  if (!lastActiveIso) return true; // fallback: trust status
  const d = new Date(lastActiveIso);
  if (Number.isNaN(d.getTime())) return false;
  const diffSec = (Date.now() - d.getTime()) / 1000;
  return diffSec < 120;
}
