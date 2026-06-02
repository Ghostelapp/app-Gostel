/**
 * CallHistoryBanner — small inline component that shows the latest few calls
 * inside a conversation. Rendered at the top of the chat message list.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  PhoneOff,
  ChevronDown,
  ChevronUp,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { theme } from './theme';

type Call = {
  id: string;
  caller_id: string;
  status: string;
  mode?: string;
  started_at: string;
  duration_sec?: number | null;
  direction: 'incoming' | 'outgoing';
};

export default function CallHistoryBanner({
  conversationId,
}: {
  conversationId: string;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      // Fetch up to 10 — we'll show 1 by default and expand on demand.
      const { data } = await api.get('/calls', {
        params: { conversation_id: conversationId, limit: 10 },
      });
      setCalls(data || []);
    } catch {
      /* swallow */
    } finally {
      setLoaded(true);
    }
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!loaded || calls.length === 0) return null;

  const visible = expanded ? calls : calls.slice(0, 1);
  const hiddenCount = calls.length - visible.length;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Phone color={theme.colors.primary} size={12} strokeWidth={2.5} />
        <Text style={styles.headerLabel}>{t('chat.call_history_in_chat')}</Text>
        <TouchableOpacity
          onPress={() => router.push('/(tabs)/calls')}
          testID="open-full-calls"
        >
          <Text style={styles.headerLink}>›</Text>
        </TouchableOpacity>
      </View>
      {visible.map((c) => (
        <CallRow key={c.id} call={c} lang={i18n.language} t={t} />
      ))}
      {hiddenCount > 0 && (
        <TouchableOpacity
          style={styles.expandRow}
          onPress={() => setExpanded(true)}
          testID="expand-call-history"
          activeOpacity={0.7}
        >
          <ChevronDown color={theme.colors.textSecondary} size={14} strokeWidth={2} />
          <Text style={styles.expandText}>
            {t('chat.show_more_calls', { count: hiddenCount })}
          </Text>
        </TouchableOpacity>
      )}
      {expanded && calls.length > 1 && (
        <TouchableOpacity
          style={styles.expandRow}
          onPress={() => setExpanded(false)}
          testID="collapse-call-history"
          activeOpacity={0.7}
        >
          <ChevronUp color={theme.colors.textSecondary} size={14} strokeWidth={2} />
          <Text style={styles.expandText}>{t('chat.show_less')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function CallRow({
  call,
  lang,
  t,
}: {
  call: Call;
  lang: string;
  t: (k: string, opts?: any) => string;
}) {
  let Icon = Phone;
  let color: string = theme.colors.primary;
  const missed = call.status === 'missed' || call.status === 'no_answer';
  const rejected = call.status === 'rejected' || call.status === 'cancelled';

  if (missed) {
    Icon = PhoneMissed;
    color = theme.colors.error;
  } else if (rejected) {
    Icon = PhoneOff;
    color = theme.colors.textMuted;
  } else if (call.direction === 'outgoing') {
    Icon = PhoneOutgoing;
    color = theme.colors.primary;
  } else {
    Icon = PhoneIncoming;
    color = theme.colors.success;
  }

  const started = new Date(call.started_at);
  const dateLabel = started.toLocaleDateString(lang, {
    month: 'short',
    day: 'numeric',
  });
  const timeLabel = started.toLocaleTimeString(lang, {
    hour: '2-digit',
    minute: '2-digit',
  });

  const duration =
    call.duration_sec && call.duration_sec > 0
      ? formatDur(call.duration_sec)
      : missed
      ? t('calls.missed')
      : rejected
      ? t('calls.rejected')
      : '';

  return (
    <View style={styles.row} testID={`chat-call-${call.id}`}>
      <Icon color={color} size={16} strokeWidth={2} />
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>
          {call.direction === 'outgoing'
            ? t('calls.outgoing')
            : t('calls.incoming')}
          {duration ? ` · ${duration}` : ''}
        </Text>
        <Text style={styles.rowSub}>
          {dateLabel} · {timeLabel}
        </Text>
      </View>
    </View>
  );
}

function formatDur(sec: number) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  headerLabel: {
    flex: 1,
    color: theme.colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  headerLink: { color: theme.colors.textMuted, fontSize: 18, paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  rowBody: { flex: 1 },
  rowTitle: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: '500' },
  rowSub: { color: theme.colors.textMuted, fontSize: 11, marginTop: 1 },
  expandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    marginTop: 4,
  },
  expandText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
});
