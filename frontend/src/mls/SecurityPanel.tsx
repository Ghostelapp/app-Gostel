import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { directoryMLS, approveMLS, initializeMLS, revokeMLSDevice } from './client';
import { publicKeyFingerprint } from '../e2ee';
import { api, formatApiErrorDetail } from '../api';
import { theme } from '../theme';

export default function SecurityPanel({ user, conversation, refresh }: { user: string; conversation: { id: string; members: any[]; type: 'direct' | 'group'; name: string; created_by?: string; e2ee_protocol?: string }; refresh: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [directory, setDirectory] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; action: () => void } | null>(null);
  const load = useCallback(async () => {
    setBusy(true); setError(''); setConfirmation(null);
    try { setDirectory(await directoryMLS(user, conversation.id)); } catch (e) { setError(formatApiErrorDetail(e)); }
    finally { setBusy(false); }
  }, [user, conversation.id]);
  useEffect(() => { void load(); }, [load]);
  const act = async (initialize: boolean) => {
    setBusy(true); setError('');
    try {
      if (initialize) await initializeMLS(user, conversation.id);
      else await approveMLS(user, conversation.id, directory.devices);
      await load(); refresh();
    } catch (e) { setError(formatApiErrorDetail(e)); }
    finally { setBusy(false); }
  };
  const complete = directory?.devices?.some((d: any) => d.device_id === directory.own.device_id) && conversation.members.every(m => directory.devices.some((d: any) => d.user_id === m.id));
  const text = { color: theme.colors.textPrimary, marginBottom: 8 };
  const button = { padding: 12, borderRadius: 8, backgroundColor: theme.colors.primary, marginVertical: 6 };
  return <View style={{ padding: 16, borderWidth: 1, borderColor: theme.colors.primary, borderRadius: 12, marginBottom: 16 }}>
    <Text style={{ ...text, fontSize: 18, fontWeight: '700' }}>{t('chat.mls_title')}</Text>
    <Text style={text}>{t('chat.mls_description')}</Text>
    {busy && <ActivityIndicator />}
    {confirmation && <View accessibilityRole="alert" style={{ padding: 12, borderWidth: 1, borderColor: theme.colors.warning, marginVertical: 8 }}>
      <Text style={{ ...text, fontWeight: '700' }}>{confirmation.title}</Text>
      <Text style={text}>{confirmation.message}</Text>
      <TouchableOpacity disabled={busy} style={button} onPress={() => { const action = confirmation.action; setConfirmation(null); action(); }}><Text style={text}>{t('chat.mls_confirm')}</Text></TouchableOpacity>
      <TouchableOpacity style={{ padding: 12 }} onPress={() => setConfirmation(null)}><Text style={text}>{t('common.cancel')}</Text></TouchableOpacity>
    </View>}
    {!!error && <Text style={{ color: theme.colors.warning }}>{error}</Text>}
    {directory && <>
      <Text style={text}>{t('chat.mls_own')}</Text>
      <Text selectable style={text}>{directory.own.device_id}{'\n'}{publicKeyFingerprint(directory.own.signature_key)}</Text>
      {directory.devices.filter((d: any) => d.device_id !== directory.own.device_id).map((d: any) => <View key={d.device_id} style={{ marginVertical: 8 }}>
        <Text style={text}>{conversation.members.find(m => m.id === d.user_id)?.name || d.user_id}{'\n'}{d.device_id}</Text>
        <Text selectable style={text}>{publicKeyFingerprint(d.signature_key)}</Text>
        {d.user_id === user && <TouchableOpacity disabled={busy} onPress={() => setConfirmation({ title: t('chat.mls_revoke'), message: t('chat.mls_revoke_confirm'), action: async () => {
            setBusy(true); try { await revokeMLSDevice(user, d.device_id); await load(); } catch (e) { setError(formatApiErrorDetail(e)); } finally { setBusy(false); }
          } })}><Text style={{ color: theme.colors.warning }}>{t('chat.mls_revoke')}</Text></TouchableOpacity>}
      </View>)}
      {!complete && <Text style={text}>{t('chat.mls_missing')}</Text>}
      {complete && <TouchableOpacity disabled={busy} style={button} onPress={() => setConfirmation({ title: t('chat.mls_verify'), message: t('chat.mls_compare'), action: () => { void act(false); } })}><Text style={text}>{t('chat.mls_verify')}</Text></TouchableOpacity>}
      {complete && directory.approved && directory.protocol !== 'mls-v1' && conversation.created_by === user && <TouchableOpacity disabled={busy} style={button} onPress={() => { void act(true); }}><Text style={text}>{t('chat.mls_activate')}</Text></TouchableOpacity>}
      {directory.protocol === 'mls-v1' && <Text style={text}>{t('chat.mls_active')}</Text>}
    </>}
    {conversation.e2ee_protocol === 'mls-v1' && <TouchableOpacity disabled={busy} style={button} onPress={async () => {
      setBusy(true);
      try {
        const { data } = await api.post('/conversations', { type: conversation.type, member_ids: conversation.members.map(m => m.id), name: conversation.name, force_new: true });
        router.replace({ pathname: '/chat-security/[id]', params: { id: data.id } });
      } catch (e) { setError(formatApiErrorDetail(e)); } finally { setBusy(false); }
    }}><Text style={text}>{t('chat.mls_new_room')}</Text></TouchableOpacity>}
    <TouchableOpacity disabled={busy} style={button} onPress={() => { void load(); }}><Text style={text}>{t('chat.mls_refresh')}</Text></TouchableOpacity>
    <TouchableOpacity onPress={() => router.push('/mls-licenses' as any)} style={{ padding: 12 }}><Text style={text}>Third-party licenses</Text></TouchableOpacity>
  </View>;
}
