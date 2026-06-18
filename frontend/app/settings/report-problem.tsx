import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Bug, ChevronLeft, Send } from 'lucide-react-native';
import { api, BASE_URL, formatApiErrorDetail } from '../../src/api';
import { theme } from '../../src/theme';

const categories = [
  { key: 'call', label: 'Calls' },
  { key: 'push', label: 'Notifications' },
  { key: 'device', label: 'Device' },
  { key: 'account', label: 'Account' },
  { key: 'bug', label: 'Bug' },
  { key: 'other', label: 'Other' },
] as const;

export default function ReportProblemScreen() {
  const router = useRouter();
  const [category, setCategory] = useState<(typeof categories)[number]['key']>('bug');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (subject.trim().length < 4 || message.trim().length < 10) {
      Alert.alert('Missing details', 'Add a short subject and describe what happened.');
      return;
    }
    setSending(true);
    try {
      const diagnostics: Record<string, any> = {
        platform: Platform.OS,
        app_version: Constants.expoConfig?.version || '',
        app_name: Constants.expoConfig?.name || 'ghostel.app',
        api_base_url: BASE_URL,
        at: new Date().toISOString(),
      };
      try {
        const { data } = await api.get('/push/devices');
        diagnostics.push_devices_count = data?.count || 0;
        diagnostics.last_push_diag = data?.last_diag || null;
      } catch (e) {
        diagnostics.push_devices_error = formatApiErrorDetail(e);
      }
      const { data } = await api.post('/support/report', {
        category,
        subject: subject.trim(),
        message: message.trim(),
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
        app_version: Constants.expoConfig?.version || '',
        diagnostics,
      });
      Alert.alert('Report sent', data?.ticket_id ? `Ticket: ${data.ticket_id}` : 'The report was saved for support.');
      setSubject('');
      setMessage('');
    } catch (e) {
      Alert.alert('Could not send report', formatApiErrorDetail(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <ChevronLeft color={theme.colors.textPrimary} size={26} />
          </TouchableOpacity>
          <Text style={styles.title}>Report a problem</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.hero}>
            <Bug color={theme.colors.warning} size={28} />
            <Text style={styles.heroTitle}>Send a useful report</Text>
            <Text style={styles.heroText}>
              Describe what happened. The app will add safe technical diagnostics and send it to Ghostel Support.
            </Text>
          </View>

          <Text style={styles.label}>Category</Text>
          <View style={styles.chips}>
            {categories.map((item) => (
              <TouchableOpacity
                key={item.key}
                style={[styles.chip, category === item.key && styles.chipActive]}
                onPress={() => setCategory(item.key)}
              >
                <Text style={[styles.chipText, category === item.key && styles.chipTextActive]}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Subject</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Example: Audio stops after one second"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            maxLength={160}
          />

          <Text style={styles.label}>What happened?</Text>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="Steps, expected result, actual result, device/network details..."
            placeholderTextColor={theme.colors.textMuted}
            style={[styles.input, styles.textarea]}
            multiline
            maxLength={5000}
            textAlignVertical="top"
          />

          <TouchableOpacity style={styles.primaryBtn} onPress={submit} disabled={sending}>
            {sending ? <ActivityIndicator color={theme.colors.background} /> : <Send color={theme.colors.background} size={18} />}
            <Text style={styles.primaryText}>Send to support</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
  },
  title: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '800' },
  scroll: { padding: 20, paddingBottom: 40 },
  hero: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
    marginBottom: 18,
  },
  heroTitle: { color: theme.colors.textPrimary, fontSize: 20, fontWeight: '900' },
  heroText: { color: theme.colors.textMuted, lineHeight: 20 },
  label: { color: theme.colors.textPrimary, fontWeight: '800', marginBottom: 8, marginTop: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  chipActive: { borderColor: theme.colors.primary, backgroundColor: 'rgba(0,217,255,0.10)' },
  chipText: { color: theme.colors.textMuted, fontWeight: '800' },
  chipTextActive: { color: theme.colors.primary },
  input: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  textarea: { minHeight: 170 },
  primaryBtn: {
    minHeight: 50,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  primaryText: { color: theme.colors.background, fontWeight: '900' },
});
