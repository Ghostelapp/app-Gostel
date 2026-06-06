import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Lock,
  Send,
  Smile,
  Paperclip,
  ShieldCheck,
  ShieldAlert,
  Mic,
  Phone,
  ImageIcon,
  FileText,
  X,
  Play,
  Pause,
  File as FileIco,
  Timer,
  Check,
  MoreVertical,
  Trash2,
  Copy,
  PhoneCall,
  PhoneMissed,
} from 'lucide-react-native';
import Avatar from '../../src/Avatar';
import CallHistoryBanner from '../../src/CallHistoryBanner';
import { useAuth } from '../../src/auth';
import { api, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';
import {
  pickDocumentForUpload,
  pickImageForUpload,
  uploadCandidate,
  UploadCandidate,
} from '../../src/upload';
import { createVoiceRecorder, formatDuration, VoiceRecorder } from '../../src/voice';
import { useWebSocket } from '../../src/ws';
import { useTranslation } from 'react-i18next';
import { formatLastSeen, isProbablyOnline } from '../../src/presence';
import {
  decryptAttachmentForUser,
  decryptMessageForUser,
  decryptMessagesForUser,
  E2EEAttachmentPayload,
  E2EEPayload,
  encryptAttachmentForConversation,
  encryptTextForConversation,
  E2EEKeyTrustStatus,
  isConversationE2EEReady,
  syncConversationKeyTrust,
  trustConversationKeys,
} from '../../src/e2ee';

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  kind: string;
  reactions?: Record<string, string[]>;
  read_by?: string[];
  created_at: string;
  encrypted?: boolean;
  e2ee?: E2EEPayload | null;
  e2ee_attachment?: E2EEAttachmentPayload | null;
  e2ee_version?: number | null;
  e2ee_decrypted?: boolean;
  attachment_id?: string | null;
  duration_ms?: number | null;
  expires_at?: string | null;
  disappear_seconds?: number | null;
};

type Conversation = {
  id: string;
  type: 'direct' | 'group';
  name: string;
  members: any[];
  encrypted: boolean;
  e2ee_ready?: boolean;
  disappear_seconds?: number | null;
  avatar?: string | null;
};

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🔒'];
const CHAT_POLL_MS = 20_000;
const EXPIRY_TICK_MS = 5_000;

const EMOJI_CATEGORIES: { label: string; icon: string; items: string[] }[] = [
  {
    label: 'Smileys',
    icon: '😀',
    items: [
      '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇',
      '🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑',
      '🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬',
      '🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶',
      '🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮',
      '😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖',
      '😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀',
      '☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻',
    ],
  },
  {
    label: 'Gestures',
    icon: '👍',
    items: [
      '👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇',
      '☝️','✋','🤚','🖐️','🖖','👋','🤛','🤜','👊','✊','🤝','🙏','🤲',
      '🙌','👏','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','👀','👁️',
      '👅','👄','💋','🫶','🫰','🫵','🤌',
    ],
  },
  {
    label: 'Hearts',
    icon: '❤️',
    items: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞',
      '💓','💗','💖','💘','💝','💟','♥️','💌','💐','🌹','🌸','💮','🏵️',
      '🌷','🌺','🌻','🌼','🌱','🌲','🌳','🌴','🌵','🍀','🍃',
    ],
  },
  {
    label: 'Party',
    icon: '🎉',
    items: [
      '🎉','🎊','🎈','🎁','🎂','🍾','🥂','🍷','🍻','🍺','🍸','🍹','🍾',
      '🎆','🎇','✨','⭐','🌟','💫','🔥','💯','💢','💥','💦','💨','🌈',
      '🥳','🤩','😎','💐','🎀','🎗️','🪄','🪅','🪆','🎶','🎵','🎤',
    ],
  },
  {
    label: 'Tech',
    icon: '💻',
    items: [
      '💼','📱','💻','⌨️','🖥️','🖨️','🖱️','📧','📞','📍','🔒','🔓','🔑',
      '🗝️','🔨','⛏️','⚒️','🛠️','⚙️','🧰','🧲','🧪','🧫','🧬','🔬','🔭',
      '📡','💾','💿','📀','💽','📷','📸','📹','🎥','📽️','🎬','📺','📻',
      '🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡',
    ],
  },
];

const DISAPPEAR_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: 'Off', seconds: null },
  { label: '30 seconds', seconds: 30 },
  { label: '5 minutes', seconds: 5 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '8 hours', seconds: 8 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '1 week', seconds: 7 * 24 * 60 * 60 },
];

const E2EE_KEY_BLOCKED = 'E2EE_KEY_BLOCKED';

function disappearLabel(seconds?: number | null): string | null {
  if (!seconds || seconds <= 0) return null;
  const opt = DISAPPEAR_OPTIONS.find((o) => o.seconds === seconds);
  if (opt) return opt.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

function messageSignature(messages: Message[]): string {
  return messages
    .map((m) =>
      [
        m.id,
        m.content,
        m.kind,
        m.attachment_id || '',
        m.duration_ms || '',
        m.expires_at || '',
        JSON.stringify(m.reactions || {}),
        (m.read_by || []).join(','),
      ].join('|'),
    )
    .join('~');
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList>(null);
  const scrollToLatest = useCallback((animated = true) => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
  }, []);

  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recordTimerRef = useRef<any>(null);
  const [disappearSheet, setDisappearSheet] = useState(false);
  const [savingDisappear, setSavingDisappear] = useState(false);
  const [emojiPicker, setEmojiPicker] = useState(false);
  const [emojiCat, setEmojiCat] = useState(0);
  const [tick, setTick] = useState(0);
  const [e2eeTrust, setE2eeTrust] = useState<E2EEKeyTrustStatus | null>(null);
  const lastMessageId = messages[messages.length - 1]?.id;
  const hasExpiringMessages = useMemo(
    () => messages.some((m) => !!m.expires_at),
    [messages],
  );

  // FlatList may need more than one layout pass after decrypting a message,
  // rendering an attachment, or resizing the keyboard. Follow the newest
  // message after those layout passes instead of scrolling too early.
  useEffect(() => {
    if (loading || !lastMessageId) return;
    scrollToLatest(true);
    const short = setTimeout(() => scrollToLatest(true), 80);
    const final = setTimeout(() => scrollToLatest(false), 260);
    return () => {
      clearTimeout(short);
      clearTimeout(final);
    };
  }, [lastMessageId, loading, scrollToLatest]);

  // Update countdown badges only while the current chat actually has expiring messages.
  useEffect(() => {
    if (!hasExpiringMessages) return;
    const t = setInterval(() => setTick((x) => x + 1), EXPIRY_TICK_MS);
    return () => clearInterval(t);
  }, [hasExpiringMessages]);

  // Parse an ISO timestamp. If it lacks timezone info, treat it as UTC
  // (avoids "instantly expired" bug when server returns naive datetimes).
  const parseExpiresAt = (iso: string): number => {
    if (!iso) return 0;
    const hasTz = /Z|[+-]\d{2}:?\d{2}$/.test(iso);
    return new Date(hasTz ? iso : iso + 'Z').getTime();
  };

  // Remove locally any messages whose expires_at has passed
  useEffect(() => {
    setMessages((prev) => {
      const now = Date.now();
      const filtered = prev.filter((m) => {
        if (!m.expires_at) return true;
        return parseExpiresAt(m.expires_at) > now;
      });
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [tick]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [c, m] = await Promise.all([
        api.get(`/conversations/${id}`),
        api.get(`/conversations/${id}/messages`),
      ]);
      setConv(c.data);
      setMessages(await decryptMessagesForUser<Message>(m.data, user?.id));
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setLoading(false);
    }
  }, [id, user?.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!conv || !user?.id) {
      setE2eeTrust(null);
      return () => {
        cancelled = true;
      };
    }

    syncConversationKeyTrust(conv, user.id)
      .then((status) => {
        if (!cancelled) setE2eeTrust(status);
      })
      .catch(() => {
        if (!cancelled) setE2eeTrust(null);
      });

    return () => {
      cancelled = true;
    };
  }, [conv, user?.id]);

  const getMemberNames = useCallback(
    (memberIds: string[]) =>
      memberIds
        .map((memberId) => {
          const member = conv?.members.find((m: any) => m.id === memberId);
          return member?.name || member?.username || memberId;
        })
        .join(', '),
    [conv],
  );

  const getChangedKeyDetails = useCallback(
    (status: E2EEKeyTrustStatus) =>
      status.changedMemberIds
        .map((memberId) =>
          t('chat.e2e_key_fingerprint', {
            name: getMemberNames([memberId]),
            fingerprint: status.fingerprints[memberId] || '-',
          }),
        )
        .join('\n'),
    [getMemberNames, t],
  );

  const confirmE2EEKeyChange = useCallback(
    (statusOverride?: E2EEKeyTrustStatus | null) => {
      const status = statusOverride || e2eeTrust;
      if (!conv || !user?.id || !status?.changedMemberIds.length) return;

      const names = getMemberNames(status.changedMemberIds);
      const details = getChangedKeyDetails(status);
      Alert.alert(
        t('chat.e2e_key_changed_title'),
        [t('chat.e2e_key_changed_body', { names }), details].filter(Boolean).join('\n\n'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('chat.e2e_trust_new_keys'),
            onPress: async () => {
              try {
                const nextStatus = await trustConversationKeys(conv, user.id);
                setE2eeTrust(nextStatus);
              } catch (e) {
                Alert.alert(t('common.error'), formatApiErrorDetail(e));
              }
            },
          },
        ],
      );
    },
    [conv, e2eeTrust, getChangedKeyDetails, getMemberNames, t, user?.id],
  );

  const ensureTrustedEncryption = useCallback(async (): Promise<boolean> => {
    if (!conv || !user?.id || !isConversationE2EEReady(conv, user.id)) {
      return false;
    }

    const status = await syncConversationKeyTrust(conv, user.id);
    setE2eeTrust(status);
    if (status.trusted) return true;

    if (status.changedMemberIds.length) {
      confirmE2EEKeyChange(status);
    } else {
      Alert.alert(t('common.error'), t('chat.e2e_key_blocked'));
    }
    return false;
  }, [confirmE2EEKeyChange, conv, t, user?.id]);

  // Live updates via WebSocket
  useWebSocket(
    useCallback(
      (msg: any) => {
        if (msg?.type === 'message' && msg.data?.conversation_id === id) {
          decryptMessageForUser<Message>(msg.data, user?.id).then((displayMessage) => {
            setMessages((prev) => {
              if (prev.find((m) => m.id === displayMessage.id)) return prev;
              return [...prev, displayMessage];
            });
            scrollToLatest(true);
            // Play in-app "new message" sound (only for messages from others).
            if (displayMessage.sender_id && displayMessage.sender_id !== user?.id) {
              import('../../src/sounds').then((s) => s.playSound('message')).catch(() => {});
            }
          });
        }
        if (msg?.type === 'message:deleted' && msg.data?.conversation_id === id) {
          setMessages((prev) => prev.filter((m) => m.id !== msg.data.id));
        }
        if (
          msg?.type === 'messages:expiring_started' &&
          msg.data?.conversation_id === id
        ) {
          // A recipient opened the chat — disappearing-message countdowns
          // have just started. Patch each affected message's `expires_at`
          // in our local state so the countdown badge shows for everyone.
          const items: { id: string; expires_at: string }[] =
            msg.data?.items || [];
          if (items.length) {
            const byId = new Map(items.map((it) => [it.id, it.expires_at]));
            setMessages((prev) =>
              prev.map((m) =>
                byId.has(m.id) ? { ...m, expires_at: byId.get(m.id) } : m,
              ),
            );
          }
        }
        if (msg?.type === 'conversation:update' && msg.data?.id === id) {
          setConv((prev) =>
            prev ? { ...prev, disappear_seconds: msg.data.disappear_seconds ?? null } : prev,
          );
        }
      },
      [id, scrollToLatest, user?.id]
    )
  );

  const applyDisappearing = async (seconds: number | null) => {
    if (!id || savingDisappear) return;
    setSavingDisappear(true);
    try {
      const { data } = await api.patch(`/conversations/${id}/disappearing`, {
        seconds,
      });
      setConv(data);
      setDisappearSheet(false);
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setSavingDisappear(false);
    }
  };

  // Polling fallback covers WebSocket reconnect gaps without constantly
  // decrypting and re-rendering the full conversation on slower devices.
  useEffect(() => {
    if (!id) return;
    const t = setInterval(async () => {
      try {
        const { data } = await api.get(`/conversations/${id}/messages`);
        const decrypted = await decryptMessagesForUser<Message>(data, user?.id);
        setMessages((prev) => {
          // Merge: keep optimistic ones; replace by id if server has newer copy
          const byId = new Map(prev.map((m) => [m.id, m]));
          decrypted.forEach((m) => byId.set(m.id, m));
          const next = Array.from(byId.values()).sort((a, b) =>
            a.created_at.localeCompare(b.created_at)
          );
          return messageSignature(prev) === messageSignature(next) ? prev : next;
        });
      } catch {
        /* ignore */
      }
    }, CHAT_POLL_MS);
    return () => clearInterval(t);
  }, [id, user?.id]);

  const sendMessage = async (
    content: string,
    kind: 'text' | 'image' | 'voice' | 'file' = 'text',
    attachmentId?: string,
    durationMs?: number,
    e2eeAttachment?: E2EEAttachmentPayload | null
  ): Promise<boolean> => {
    if (!id) return false;
    setSending(true);
    try {
      if (!conv || !user?.id || !isConversationE2EEReady(conv, user.id)) {
        Alert.alert(t('common.error'), t('chat.e2e_required'));
        return false;
      }
      if (!(await ensureTrustedEncryption())) return false;

      let payload: any = {
        conversation_id: id,
        content: '[encrypted message]',
        kind,
        attachment_id: attachmentId,
        duration_ms: durationMs,
      };

      const encrypted = await encryptTextForConversation(content, conv, user.id);
      if (!encrypted) {
        Alert.alert(t('common.error'), t('chat.e2e_required'));
        return false;
      }
      payload = { ...payload, ...encrypted };

      if (e2eeAttachment) {
        payload.e2ee_attachment = e2eeAttachment;
      }
      const { data } = await api.post('/messages', payload);
      const displayMessage = await decryptMessageForUser<Message>(data, user?.id);
      setMessages((prev) => [...prev, displayMessage]);
      // Play a subtle "sent" sound for outgoing messages
      import('../../src/sounds')
        .then((s) => s.playSound('sent', 0.3))
        .catch(() => {});
      scrollToLatest(true);
      return true;
    } catch (e) {
      Alert.alert(t('common.error'), formatApiErrorDetail(e));
      return false;
    } finally {
      setSending(false);
    }
  };

  const uploadForCurrentConversation = async (
    candidate: UploadCandidate,
  ): Promise<{ upload: any; e2eeAttachment?: E2EEAttachmentPayload | null }> => {
    if (!conv || !user?.id || !isConversationE2EEReady(conv, user.id)) {
      Alert.alert(t('common.error'), t('chat.e2e_required'));
      throw new Error(E2EE_KEY_BLOCKED);
    }
    if (!(await ensureTrustedEncryption())) {
      throw new Error(E2EE_KEY_BLOCKED);
    }
    const encrypted = await encryptAttachmentForConversation(
      candidate.data,
      candidate.mime,
      conv,
      user.id,
    );
    if (!encrypted) {
      Alert.alert(t('common.error'), t('chat.e2e_required'));
      throw new Error(E2EE_KEY_BLOCKED);
    }

    const encryptedUpload = await uploadCandidate({
      filename: `${candidate.filename}.ghostel`,
      mime: 'application/octet-stream',
      data: encrypted.data,
      size: Math.ceil((encrypted.data.length * 3) / 4),
    });
    return { upload: encryptedUpload, e2eeAttachment: encrypted.e2ee_attachment };
  };

  /** Open the action sheet for a single message (reactions, copy, delete). */
  const openMessageActions = (msg: Message) => {
    const isMine = msg.sender_id === user?.id;
    const actions: { text: string; style?: 'destructive' | 'cancel' | 'default'; onPress?: () => void }[] = [
      {
        text: '👍 ❤️ 😂 😮 😢 🙏',
        onPress: () => setReactingTo(msg.id),
      },
    ];
    if (msg.kind === 'text' && msg.content) {
      actions.push({
        text: t('chat.copy_text'),
        onPress: async () => {
          try {
            const Clipboard = await import('expo-clipboard');
            await Clipboard.setStringAsync(msg.content);
          } catch {
            /* clipboard not available */
          }
        },
      });
    }
    if (isMine) {
      actions.push({
        text: t('chat.delete_message'),
        style: 'destructive',
        onPress: () => {
          Alert.alert(t('chat.delete_message'), t('chat.delete_message_confirm'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.delete'),
              style: 'destructive',
              onPress: async () => {
                // Optimistic UI
                setMessages((prev) => prev.filter((m) => m.id !== msg.id));
                try {
                  await api.delete(`/messages/${msg.id}`);
                } catch (e) {
                  Alert.alert(t('common.error'), formatApiErrorDetail(e));
                  // Re-fetch to restore on failure
                  try {
                    const { data } = await api.get(`/conversations/${id}/messages`);
                    setMessages(data);
                  } catch {
                    /* ignore */
                  }
                }
              },
            },
          ]);
        },
      });
    }
    actions.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(msg.sender_name || '', undefined, actions);
  };

  const sendText = async () => {
    if (!text.trim() || sending) return;
    const c = text.trim();
    const sent = await sendMessage(c, 'text');
    if (sent) setText('');
  };

  const onAttachImage = async () => {
    setAttachMenu(false);
    setUploading(true);
    try {
      const candidate = await pickImageForUpload();
      if (candidate) {
        const { upload, e2eeAttachment } = await uploadForCurrentConversation(candidate);
        await sendMessage(candidate.filename, 'image', upload.id, undefined, e2eeAttachment);
      }
    } catch (e) {
      if ((e as Error).message !== E2EE_KEY_BLOCKED) {
        Alert.alert('Upload failed', (e as Error).message);
      }
    } finally {
      setUploading(false);
    }
  };

  const onAttachDocument = async () => {
    setAttachMenu(false);
    setUploading(true);
    try {
      const candidate = await pickDocumentForUpload();
      if (candidate) {
        const { upload, e2eeAttachment } = await uploadForCurrentConversation(candidate);
        await sendMessage(candidate.filename, 'file', upload.id, undefined, e2eeAttachment);
      }
    } catch (e) {
      if ((e as Error).message !== E2EE_KEY_BLOCKED) {
        Alert.alert('Upload failed', (e as Error).message);
      }
    } finally {
      setUploading(false);
    }
  };

  const startRecording = async () => {
    if (recording) return;
    try {
      const rec = createVoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );
    } catch (e) {
      Alert.alert('Mic error', (e as Error).message || 'Cannot record');
    }
  };

  const stopRecording = async (cancel = false) => {
    if (!recording) return;
    setRecording(false);
    clearInterval(recordTimerRef.current);
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return;
    if (cancel) {
      await rec.cancel();
      return;
    }
    try {
      const result = await rec.stop();
      if (result) {
        const { upload, e2eeAttachment } = await uploadForCurrentConversation(result);
        await sendMessage(
          `Voice (${formatDuration(result.durationMs)})`,
          'voice',
          upload.id,
          result.durationMs,
          e2eeAttachment
        );
      }
    } catch (e) {
      if ((e as Error).message !== E2EE_KEY_BLOCKED) {
        Alert.alert('Voice error', (e as Error).message);
      }
    }
  };

  const react = async (msg: Message, emoji: string) => {
    try {
      const { data } = await api.post(`/messages/${msg.id}/reactions`, { emoji });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? data : m)));
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setReactingTo(null);
    }
  };

  const startCall = async () => {
    if (!conv) return;
    try {
      const { data } = await api.post('/calls/start', {
        conversation_id: conv.id,
        mode: 'audio',
      });
      router.push(`/call/${data.id}?role=caller&conversation_id=${conv.id}`);
    } catch (e) {
      Alert.alert('Call failed', formatApiErrorDetail(e));
    }
  };

  const renderMessage = ({ item }: { item: Message }) => {
    // System messages render centered
    if (item.kind === 'system' || item.sender_id === 'system') {
      return (
        <View style={styles.systemMsgWrap} testID={`system-msg-${item.id}`}>
          <View style={styles.systemMsg}>
            <Timer color={theme.colors.primary} size={11} strokeWidth={2.5} />
            <Text style={styles.systemMsgText}>{item.content}</Text>
          </View>
        </View>
      );
    }

    const isMine = item.sender_id === user?.id;
    const reactions = item.reactions || {};
    const reactionEntries = Object.entries(reactions).filter(
      ([, ids]) => ids.length > 0
    );

    // Compute countdown if expiring
    let countdown: string | null = null;
    if (item.expires_at) {
      const remaining = Math.max(
        0,
        Math.floor((parseExpiresAt(item.expires_at) - Date.now()) / 1000),
      );
      if (remaining > 0) {
        if (remaining < 60) countdown = `${remaining}s`;
        else if (remaining < 3600) countdown = `${Math.floor(remaining / 60)}m`;
        else if (remaining < 86400) countdown = `${Math.floor(remaining / 3600)}h`;
        else countdown = `${Math.floor(remaining / 86400)}d`;
      }
    }

    return (
      <View style={[styles.msgRow, isMine ? styles.msgRight : styles.msgLeft]}>
        {!isMine && conv?.type === 'group' && (
          <Avatar name={item.sender_name} size={28} color={theme.colors.primary} />
        )}
        <View style={{ maxWidth: '80%' }}>
          {!isMine && conv?.type === 'group' && (
            <Text style={styles.senderName}>{item.sender_name}</Text>
          )}
          <TouchableOpacity
            testID={`message-${item.id}`}
            activeOpacity={0.85}
            onLongPress={() => openMessageActions(item)}
            style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther]}
          >
            <MessageBody msg={item} isMine={isMine} />
            <View style={styles.bubbleMeta}>
              <Lock
                color={isMine ? '#ffffffaa' : theme.colors.primary}
                size={9}
                strokeWidth={2.5}
              />
              {countdown && (
                <View
                  style={[
                    styles.countdownBadge,
                    {
                      backgroundColor: isMine ? '#ffffff22' : theme.colors.primaryDark,
                    },
                  ]}
                  testID={`countdown-${item.id}`}
                >
                  <Timer
                    color={isMine ? '#ffffffcc' : theme.colors.primary}
                    size={9}
                    strokeWidth={2.5}
                  />
                  <Text
                    style={[
                      styles.countdownText,
                      { color: isMine ? '#ffffffcc' : theme.colors.primary },
                    ]}
                  >
                    {countdown}
                  </Text>
                </View>
              )}
              {/* "Will disappear when read" — only on MY messages that have a
                  disappear_seconds set but no countdown yet (recipient hasn't
                  opened the chat). */}
              {!countdown &&
                isMine &&
                !!item.disappear_seconds &&
                !item.expires_at && (
                  <View
                    style={[
                      styles.countdownBadge,
                      { backgroundColor: '#ffffff22' },
                    ]}
                    testID={`will-disappear-${item.id}`}
                  >
                    <Timer color={'#ffffffcc'} size={9} strokeWidth={2.5} />
                    <Text
                      style={[
                        styles.countdownText,
                        { color: '#ffffffcc' },
                      ]}
                    >
                      {t('chat.will_disappear_when_read')}
                    </Text>
                  </View>
                )}
              <Text
                style={[
                  styles.bubbleTime,
                  isMine ? { color: '#ffffffaa' } : { color: theme.colors.textMuted },
                ]}
              >
                {formatTime(item.created_at)}
              </Text>
            </View>
          </TouchableOpacity>

          {reactionEntries.length > 0 && (
            <View
              style={[
                styles.reactionRow,
                isMine ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' },
              ]}
            >
              {reactionEntries.map(([emoji, ids]) => (
                <TouchableOpacity
                  key={emoji}
                  testID={`reaction-${item.id}-${emoji}`}
                  onPress={() => react(item, emoji)}
                  style={styles.reactionChip}
                  activeOpacity={0.8}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                  <Text style={styles.reactionCount}>{ids.length}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {reactingTo === item.id && (
            <View
              style={[
                styles.quickRow,
                isMine ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' },
              ]}
            >
              {QUICK_REACTIONS.map((e) => (
                <TouchableOpacity
                  key={e}
                  testID={`quick-react-${item.id}-${e}`}
                  onPress={() => react(item, e)}
                  style={styles.quickReact}
                  activeOpacity={0.8}
                >
                  <Text style={styles.reactionEmoji}>{e}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                onPress={() => setReactingTo(null)}
                style={styles.quickReact}
              >
                <Text style={[styles.reactionCount, { color: theme.colors.textSecondary }]}>
                  ✕
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={[styles.safe, styles.center]}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const peer = conv?.type === 'direct'
    ? conv.members.find((m: any) => m.id !== user?.id)
    : null;
  const e2eeReady = isConversationE2EEReady(conv, user?.id) || !!conv?.e2ee_ready;
  const changedMemberIds = e2eeTrust?.changedMemberIds || [];
  const keyChanged = changedMemberIds.length > 0;
  const keyChangedNames = keyChanged ? getMemberNames(changedMemberIds) : '';
  const e2eeTrusted = e2eeReady && e2eeTrust?.trusted === true;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="chat-back-button"
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <ArrowLeft color={theme.colors.textPrimary} size={22} />
        </TouchableOpacity>
        <Avatar
          name={conv?.name || 'Chat'}
          size={36}
          color={peer?.avatar_color || theme.colors.primary}
          status={peer?.status}
          showStatus={!!peer}
          photo={peer?.avatar || conv?.avatar}
        />
        <TouchableOpacity
          style={styles.headerBody}
          onPress={() => {
            if (conv?.type === 'group') {
              router.push(`/group-info/${id}`);
            } else if (peer?.id) {
              router.push(`/user/${peer.id}`);
            }
          }}
          activeOpacity={0.6}
          testID="chat-header-info"
        >
          <Text style={styles.headerTitle} numberOfLines={1}>
            {conv?.name}
          </Text>
          <View style={styles.headerSubRow}>
            <ShieldCheck color={theme.colors.primary} size={11} strokeWidth={2.5} />
            <Text style={styles.headerSub} numberOfLines={1}>
              {conv?.type === 'group'
                ? t('chat.members_count', { count: conv.members.length })
                : peer
                ? `${
                    isProbablyOnline(peer.status, peer.last_active)
                      ? t('presence.online')
                      : formatLastSeen(peer.last_seen, t as any, false) || t('chat.encrypted')
                  }`
                : t('chat.encrypted')}
            </Text>
            {conv?.disappear_seconds ? (
              <>
                <Text style={[styles.headerSub, { opacity: 0.6 }]}>•</Text>
                <Timer color={theme.colors.warning || '#f59e0b'} size={11} strokeWidth={2.5} />
                <Text style={[styles.headerSub, { color: theme.colors.warning || '#f59e0b' }]}>
                  {disappearLabel(conv.disappear_seconds)}
                </Text>
              </>
            ) : null}
            {e2eeTrusted ? (
              <>
                <Text style={[styles.headerSub, { opacity: 0.6 }]}>|</Text>
                <Lock color={theme.colors.primary} size={11} strokeWidth={2.5} />
                <Text style={styles.headerSub}>E2EE</Text>
              </>
            ) : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          testID="disappearing-button"
          onPress={() => setDisappearSheet(true)}
          style={styles.callBtn}
        >
          <Timer
            color={
              conv?.disappear_seconds
                ? theme.colors.warning || '#f59e0b'
                : theme.colors.textSecondary
            }
            size={18}
            strokeWidth={2}
          />
        </TouchableOpacity>
        {conv?.type === 'direct' && (
          <TouchableOpacity testID="start-call-button" onPress={startCall} style={styles.callBtn}>
            <Phone color={theme.colors.primary} size={20} strokeWidth={2} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          testID="chat-header-menu"
          onPress={() => {
            Alert.alert(
              conv?.name || '',
              undefined,
              [
                {
                  text: t('chat.security_title'),
                  onPress: () => router.push(`/chat-security/${id}` as any),
                },
                {
                  text: t('chats.delete_chat'),
                  style: 'destructive',
                  onPress: () => {
                    Alert.alert(
                      t('chats.delete_chat'),
                      t('chats.delete_chat_confirm'),
                      [
                        { text: t('common.cancel'), style: 'cancel' },
                        {
                          text: t('common.delete'),
                          style: 'destructive',
                          onPress: async () => {
                            try {
                              await api.delete(`/conversations/${id}`);
                              router.back();
                            } catch (e) {
                              Alert.alert(t('common.error'), formatApiErrorDetail(e));
                            }
                          },
                        },
                      ],
                    );
                  },
                },
                { text: t('common.cancel'), style: 'cancel' },
              ],
            );
          }}
          style={styles.callBtn}
        >
          <MoreVertical color={theme.colors.textSecondary} size={20} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
        style={styles.flex}
      >
        <FlatList
          ref={listRef}
          testID="messages-list"
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.msgList}
          initialNumToRender={14}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={80}
          windowSize={9}
          removeClippedSubviews={Platform.OS === 'android'}
          onContentSizeChange={() => scrollToLatest(false)}
          onLayout={() => scrollToLatest(false)}
          ListHeaderComponent={
            <>
              {keyChanged ? (
                <View
                  style={[styles.encNotice, styles.keyWarningNotice]}
                  testID="e2ee-key-warning"
                >
                  <ShieldAlert color={theme.colors.warning} size={14} strokeWidth={2.5} />
                  <View style={styles.encNoticeBody}>
                    <Text style={[styles.encNoticeText, styles.keyWarningText]}>
                      {t('chat.e2e_key_changed_banner', { names: keyChangedNames })}
                    </Text>
                    <TouchableOpacity
                      testID="trust-e2ee-keys"
                      onPress={() => confirmE2EEKeyChange()}
                      style={styles.keyTrustBtn}
                      activeOpacity={0.85}
                    >
                      <ShieldCheck
                        color={theme.colors.background}
                        size={12}
                        strokeWidth={2.5}
                      />
                      <Text style={styles.keyTrustText}>
                        {t('chat.e2e_trust_new_keys')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={styles.encNotice}>
                  <Lock color={theme.colors.primary} size={12} strokeWidth={2.5} />
                  <Text style={styles.encNoticeText}>
                    {e2eeTrusted ? t('chat.e2e_notice_ready') : t('chat.e2e_notice')}
                  </Text>
                </View>
              )}
              <CallHistoryBanner conversationId={id || ''} />
            </>
          }
          ListEmptyComponent={
            <View style={styles.emptyMsg}>
              <Text style={styles.emptyMsgText}>
                {t('chat.send_first_message')}
              </Text>
            </View>
          }
        />

        {recording && (
          <View
            style={[styles.recordingBar, { paddingBottom: 12 + insets.bottom }]}
            testID="recording-bar"
          >
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>
              {t('chat.recording')} {formatDuration(recordSeconds * 1000)}
            </Text>
            <TouchableOpacity
              testID="cancel-recording"
              onPress={() => stopRecording(true)}
              style={styles.recordingBtn}
            >
              <X color={theme.colors.error} size={20} />
            </TouchableOpacity>
            <TouchableOpacity
              testID="stop-recording"
              onPress={() => stopRecording(false)}
              style={[styles.recordingBtn, { backgroundColor: theme.colors.primary }]}
            >
              <Send color={theme.colors.background} size={18} strokeWidth={2.5} />
            </TouchableOpacity>
          </View>
        )}

        {!recording && (
          <View style={[styles.composer, { paddingBottom: 10 + insets.bottom }]}>
            <TouchableOpacity
              testID="attach-button"
              onPress={() => setAttachMenu(true)}
              disabled={uploading}
              style={styles.composerIcon}
            >
              {uploading ? (
                <ActivityIndicator color={theme.colors.primary} size="small" />
              ) : (
                <Paperclip
                  color={theme.colors.textSecondary}
                  size={20}
                  strokeWidth={1.8}
                />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              testID="emoji-button"
              onPress={() => setEmojiPicker((v) => !v)}
              style={styles.composerIcon}
            >
              <Smile
                color={emojiPicker ? theme.colors.primary : theme.colors.textSecondary}
                size={20}
                strokeWidth={1.8}
              />
            </TouchableOpacity>
            <TextInput
              testID="message-input"
              value={text}
              onChangeText={setText}
              placeholder={t('chats.type_message')}
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
              multiline
              onFocus={() => setEmojiPicker(false)}
            />
            {text.trim().length === 0 ? (
              <TouchableOpacity
                testID="record-voice-button"
                onPress={startRecording}
                style={styles.sendBtn}
                activeOpacity={0.85}
              >
                <Mic color={theme.colors.background} size={18} strokeWidth={2.4} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="send-message-button"
                onPress={sendText}
                disabled={sending}
                style={[styles.sendBtn, sending && { opacity: 0.4 }]}
                activeOpacity={0.85}
              >
                {sending ? (
                  <ActivityIndicator color={theme.colors.background} size="small" />
                ) : (
                  <Send color={theme.colors.background} size={18} strokeWidth={2.4} />
                )}
              </TouchableOpacity>
            )}
          </View>
        )}

        {emojiPicker && !recording && (
          <View style={styles.emojiPanel} testID="emoji-panel">
            <View style={styles.emojiCatTabs}>
              {EMOJI_CATEGORIES.map((cat, idx) => (
                <TouchableOpacity
                  key={cat.label}
                  testID={`emoji-cat-${idx}`}
                  style={[
                    styles.emojiCatTab,
                    emojiCat === idx && styles.emojiCatTabActive,
                  ]}
                  onPress={() => setEmojiCat(idx)}
                >
                  <Text style={styles.emojiCatIcon}>{cat.icon}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.emojiScroll}
            >
              <View style={styles.emojiGrid}>
                {EMOJI_CATEGORIES[emojiCat].items.map((e, idx) => (
                  <TouchableOpacity
                    key={`${emojiCat}-${idx}-${e}`}
                    testID={`emoji-${emojiCat}-${idx}`}
                    style={styles.emojiBtn}
                    onPress={() => setText((prev) => prev + e)}
                    activeOpacity={0.6}
                  >
                    <Text style={styles.emojiText}>{e}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        )}
      </KeyboardAvoidingView>

      <Modal
        visible={attachMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setAttachMenu(false)}
      >
        <TouchableOpacity
          style={styles.modalBg}
          activeOpacity={1}
          onPress={() => setAttachMenu(false)}
        >
          <View style={styles.modalSheet}>
            <TouchableOpacity
              testID="attach-image"
              style={styles.modalRow}
              onPress={onAttachImage}
            >
              <ImageIcon color={theme.colors.primary} size={22} strokeWidth={1.8} />
              <Text style={styles.modalText}>{t('chat.photo_from_library')}</Text>
            </TouchableOpacity>
            <View style={styles.modalDivider} />
            <TouchableOpacity
              testID="attach-document"
              style={styles.modalRow}
              onPress={onAttachDocument}
            >
              <FileText color={theme.colors.primary} size={22} strokeWidth={1.8} />
              <Text style={styles.modalText}>{t('chat.document_max')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal
        visible={disappearSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setDisappearSheet(false)}
      >
        <TouchableOpacity
          style={styles.modalBg}
          activeOpacity={1}
          onPress={() => setDisappearSheet(false)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.modalSheet}>
            <View style={styles.disappearHeader}>
              <Timer color={theme.colors.warning} size={20} strokeWidth={2} />
              <View style={{ flex: 1 }}>
                <Text style={styles.disappearTitle}>{t('chat.disappearing_title')}</Text>
                <Text style={styles.disappearSubtitle}>
                  {t('chat.disappearing_subtitle')}
                </Text>
              </View>
            </View>
            <View style={styles.modalDivider} />
            {DISAPPEAR_OPTIONS.map((opt, idx) => {
              const selected = (conv?.disappear_seconds ?? null) === opt.seconds;
              return (
                <TouchableOpacity
                  key={String(opt.seconds)}
                  testID={`disappear-option-${opt.seconds ?? 'off'}`}
                  style={styles.modalRow}
                  disabled={savingDisappear}
                  onPress={() => applyDisappearing(opt.seconds)}
                >
                  <View
                    style={[
                      styles.disappearRadio,
                      selected && {
                        backgroundColor: theme.colors.primary,
                        borderColor: theme.colors.primary,
                      },
                    ]}
                  >
                    {selected ? (
                      <Check color={theme.colors.background} size={14} strokeWidth={3} />
                    ) : null}
                  </View>
                  <Text
                    style={[
                      styles.modalText,
                      selected && { color: theme.colors.primary, fontWeight: '600' },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {savingDisappear && selected && (
                    <ActivityIndicator
                      size="small"
                      color={theme.colors.primary}
                      style={{ marginLeft: 'auto' }}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function MessageBody({ msg, isMine }: { msg: Message; isMine: boolean }) {
  if (msg.kind === 'image' && msg.attachment_id) {
    return <ImagePreview msg={msg} />;
  }
  if (msg.kind === 'voice' && msg.attachment_id) {
    return <VoicePlayer msg={msg} isMine={isMine} />;
  }
  if (msg.kind === 'file' && msg.attachment_id) {
    return <FileCard msg={msg} isMine={isMine} />;
  }
  return (
    <Text
      style={[
        styles.bubbleText,
        isMine ? styles.bubbleTextMine : styles.bubbleTextOther,
      ]}
    >
      {msg.content}
    </Text>
  );
}

function ImagePreview({ msg }: { msg: Message }) {
  const { user } = useAuth();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/uploads/${msg.attachment_id}`)
      .then(async ({ data }) => {
        const attachment = msg.e2ee_attachment
          ? await decryptAttachmentForUser(data.data, msg.e2ee_attachment, msg, user?.id)
          : { data: data.data, mime: data.mime };
        if (!attachment) return;
        if (!cancelled)
          setSrc(`data:${attachment.mime};base64,${attachment.data}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [msg.attachment_id, msg.e2ee_attachment, user?.id]);

  if (!src) {
    return (
      <View style={styles.imagePlaceholder}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: src }}
      style={styles.image}
      resizeMode="cover"
      testID={`message-image-${msg.id}`}
    />
  );
}

function VoicePlayer({ msg, isMine }: { msg: Message; isMine: boolean }) {
  const { user } = useAuth();
  const [playing, setPlaying] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [mime, setMime] = useState<string>('audio/m4a');
  const [b64, setB64] = useState<string | null>(null);
  const [progress, setProgress] = useState(0); // 0..1
  const [elapsedMs, setElapsedMs] = useState(0);
  const audioRef = useRef<any>(null);
  const localUriRef = useRef<string | null>(null);
  const pollRef = useRef<any>(null);

  const totalMs = msg.duration_ms || 0;
  const BAR_COUNT = 22;

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/uploads/${msg.attachment_id}`)
      .then(async ({ data }) => {
        if (cancelled) return;
        const attachment = msg.e2ee_attachment
          ? await decryptAttachmentForUser(data.data, msg.e2ee_attachment, msg, user?.id)
          : { data: data.data, mime: data.mime };
        if (!attachment || cancelled) return;
        setSrc(`data:${attachment.mime};base64,${attachment.data}`);
        setMime(attachment.mime);
        setB64(attachment.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      if (audioRef.current) {
        try {
          if (Platform.OS === 'web') audioRef.current.pause?.();
          else audioRef.current.remove?.();
        } catch {}
        audioRef.current = null;
      }
    };
  }, [msg.attachment_id, msg.e2ee_attachment, user?.id]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const resetProgress = () => {
    setProgress(0);
    setElapsedMs(0);
  };

  const toggle = async () => {
    if (Platform.OS === 'web') {
      if (!src) return;
      if (!audioRef.current) {
        const audio = new (window as any).Audio(src);
        audio.onended = () => {
          setPlaying(false);
          stopPolling();
          resetProgress();
        };
        audio.ontimeupdate = () => {
          const cur = audio.currentTime * 1000;
          const dur = audio.duration && isFinite(audio.duration)
            ? audio.duration * 1000
            : totalMs || 1;
          setElapsedMs(cur);
          setProgress(Math.min(1, cur / dur));
        };
        audioRef.current = audio;
      }
      if (playing) {
        audioRef.current.pause();
        setPlaying(false);
      } else {
        await audioRef.current.play();
        setPlaying(true);
      }
      return;
    }

    // Native
    if (!b64) return;
    try {
      if (audioRef.current) {
        if (audioRef.current.playing) {
          audioRef.current.pause();
          setPlaying(false);
          stopPolling();
        } else {
          audioRef.current.play();
          setPlaying(true);
          startNativePoll();
        }
        return;
      }

      // Write base64 to cache file once
      if (!localUriRef.current) {
        let FileSystem: any;
        try {
          FileSystem = require('expo-file-system/legacy');
        } catch {
          FileSystem = require('expo-file-system');
        }
        const ext = mime.includes('webm')
          ? 'webm'
          : mime.includes('ogg')
          ? 'ogg'
          : 'm4a';
        const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
        const path = `${dir}voice-${msg.id}.${ext}`;
        await FileSystem.writeAsStringAsync(path, b64, { encoding: 'base64' });
        localUriRef.current = path;
      }

      const { createAudioPlayer, setAudioModeAsync } = require('expo-audio');
      try {
        await setAudioModeAsync({ playsInSilentMode: true });
      } catch {
        /* ignore */
      }
      const player = createAudioPlayer({ uri: localUriRef.current });
      player.addListener('playbackStatusUpdate', (status: any) => {
        if (status.didJustFinish) {
          setPlaying(false);
          stopPolling();
          resetProgress();
          try {
            player.remove();
          } catch {}
          audioRef.current = null;
        }
      });
      audioRef.current = player;
      player.play();
      setPlaying(true);
      startNativePoll();
    } catch (e: any) {
      Alert.alert('Playback error', e?.message || 'Cannot play voice message');
      setPlaying(false);
      stopPolling();
    }
  };

  const startNativePoll = () => {
    stopPolling();
    pollRef.current = setInterval(() => {
      const p = audioRef.current;
      if (!p) return;
      const curSec = p.currentTime || 0;
      const durSec = p.duration && isFinite(p.duration) && p.duration > 0
        ? p.duration
        : (totalMs / 1000) || 1;
      const curMs = curSec * 1000;
      setElapsedMs(curMs);
      setProgress(Math.min(1, curSec / durSec));
    }, 100);
  };

  const displayMs = playing || elapsedMs > 0 ? elapsedMs : totalMs;
  const displayDur = displayMs > 0 ? formatDuration(displayMs) : '0:00';
  const activeBars = Math.floor(progress * BAR_COUNT);

  return (
    <View style={styles.voiceRow} testID={`voice-message-${msg.id}`}>
      <TouchableOpacity
        testID={`voice-play-${msg.id}`}
        onPress={toggle}
        disabled={!b64 && !src}
        style={[
          styles.playBtn,
          { backgroundColor: isMine ? '#ffffff22' : theme.colors.primaryDark },
          (!b64 && !src) && { opacity: 0.5 },
        ]}
        activeOpacity={0.8}
      >
        {playing ? (
          <Pause
            color={isMine ? '#fff' : theme.colors.primary}
            size={16}
            fill={isMine ? '#fff' : theme.colors.primary}
          />
        ) : (
          <Play
            color={isMine ? '#fff' : theme.colors.primary}
            size={16}
            fill={isMine ? '#fff' : theme.colors.primary}
          />
        )}
      </TouchableOpacity>
      <View style={styles.voiceBars}>
        {[...Array(BAR_COUNT)].map((_, i) => {
          const isActive = i < activeBars;
          const activeColor = isMine ? '#ffffff' : theme.colors.primary;
          const dimColor = isMine ? '#ffffff55' : `${theme.colors.primary}55`;
          return (
            <View
              key={i}
              style={[
                styles.voiceBar,
                {
                  backgroundColor: isActive ? activeColor : dimColor,
                  height: 4 + ((i * 5) % 16),
                },
              ]}
            />
          );
        })}
      </View>
      <Text
        style={[
          styles.voiceDur,
          { color: isMine ? '#ffffffcc' : theme.colors.textSecondary },
        ]}
        testID={`voice-time-${msg.id}`}
      >
        {displayDur}
      </Text>
    </View>
  );
}

function FileCard({ msg, isMine }: { msg: Message; isMine: boolean }) {
  return (
    <View style={styles.fileRow} testID={`file-message-${msg.id}`}>
      <View
        style={[
          styles.fileIcon,
          { backgroundColor: isMine ? '#ffffff22' : theme.colors.primaryDark },
        ]}
      >
        <FileIco color={isMine ? '#fff' : theme.colors.primary} size={20} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={[styles.fileName, { color: isMine ? '#fff' : theme.colors.textPrimary }]}
        >
          {msg.content || 'Document'}
        </Text>
        <Text style={[styles.fileSub, { color: isMine ? '#ffffffaa' : theme.colors.textSecondary }]}>
          Secure attachment
        </Text>
      </View>
    </View>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  backBtn: { padding: 4 },
  headerBody: { flex: 1, minWidth: 0 },
  headerTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  headerSubRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  headerSub: { color: theme.colors.primary, fontSize: 10, fontWeight: '600', flexShrink: 1 },
  callBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  msgList: { padding: 14, gap: 4, paddingBottom: 16 },
  msgRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  msgLeft: { justifyContent: 'flex-start', alignItems: 'flex-end' },
  msgRight: { justifyContent: 'flex-end', alignSelf: 'flex-end' },
  senderName: {
    color: theme.colors.primary,
    fontSize: 11,
    marginLeft: 12,
    marginBottom: 2,
    fontWeight: '600',
  },
  bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: theme.radius.lg },
  bubbleMine: { backgroundColor: theme.colors.bubbleSent, borderTopRightRadius: 4 },
  bubbleOther: {
    backgroundColor: theme.colors.bubbleReceived,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bubbleText: { fontSize: 15, lineHeight: 20 },
  bubbleTextMine: { color: '#ffffff' },
  bubbleTextOther: { color: theme.colors.textPrimary },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  bubbleTime: { fontSize: 10 },
  reactionRow: { flexDirection: 'row', gap: 4, marginTop: 4 },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  reactionEmoji: { fontSize: 13 },
  reactionCount: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' },
  quickRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 6,
    backgroundColor: theme.colors.surface,
    padding: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  quickReact: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.pill },
  encNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  encNoticeBody: { flex: 1, minWidth: 0 },
  encNoticeText: { color: theme.colors.textSecondary, fontSize: 11 },
  keyWarningNotice: {
    alignSelf: 'stretch',
    alignItems: 'flex-start',
    borderRadius: theme.radius.md,
    backgroundColor: `${theme.colors.warning}14`,
    borderColor: theme.colors.warning,
    paddingVertical: 10,
  },
  keyWarningText: {
    color: theme.colors.textPrimary,
    lineHeight: 16,
    flexShrink: 1,
  },
  keyTrustBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.warning,
  },
  keyTrustText: {
    color: theme.colors.background,
    fontSize: 11,
    fontWeight: '700',
  },
  emptyMsg: { padding: 24, alignItems: 'center' },
  emptyMsgText: { color: theme.colors.textMuted, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    gap: 6,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  composerIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxHeight: 120,
    minHeight: 40,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.error,
  },
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.error,
  },
  recordingText: { color: theme.colors.textPrimary, flex: 1, fontSize: 14, fontWeight: '600' },
  recordingBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modalBg: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 8,
    paddingBottom: 32,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 14,
  },
  modalText: { color: theme.colors.textPrimary, fontSize: 15 },
  modalDivider: { height: 1, backgroundColor: theme.colors.border, marginHorizontal: 16 },
  imagePlaceholder: {
    width: 220,
    height: 160,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: 220,
    height: 160,
    borderRadius: theme.radius.md,
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 180,
  },
  playBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceBars: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flex: 1,
  },
  voiceBar: { width: 2, borderRadius: 1 },
  voiceDur: { fontSize: 11, fontWeight: '600' },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 200,
    maxWidth: 240,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileName: { fontSize: 14, fontWeight: '600' },
  fileSub: { fontSize: 11, marginTop: 2 },
  emojiPanel: {
    height: 260,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  emojiCatTabs: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  emojiCatTab: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
  },
  emojiCatTabActive: {
    backgroundColor: theme.colors.primary + '20',
  },
  emojiCatIcon: {
    fontSize: 20,
  },
  emojiScroll: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  emojiBtn: {
    width: '12.5%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiText: { fontSize: 26 },
  systemMsgWrap: {
    alignItems: 'center',
    marginVertical: 6,
  },
  systemMsg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: '85%',
  },
  systemMsgText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '500',
    flexShrink: 1,
  },
  countdownBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.pill,
  },
  countdownText: {
    fontSize: 10,
    fontWeight: '700',
  },
  disappearHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 16,
    paddingBottom: 12,
  },
  disappearTitle: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  disappearSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  disappearRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
