import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, KeyRound, ShieldCheck, Copy } from 'lucide-react-native';
import { api, formatApiErrorDetail } from '../../src/api';
import { useAuth } from '../../src/auth';
import { theme } from '../../src/theme';

export default function TwoFactorScreen() {
  const router = useRouter();
  const { user, refreshUser } = useAuth();
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const startSetup = async () => {
    if (!password) {
      Alert.alert('Password required', 'Enter your account password to start 2FA setup.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/auth/2fa/setup', { password });
      setSecret(data.secret);
      setOtpauth(data.otpauth_uri);
      setPassword('');
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (code.length !== 6) {
      Alert.alert('Invalid', 'Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/2fa/enable', { code });
      await refreshUser();
      Alert.alert('Enabled', 'Two-factor authentication is now active.');
      router.back();
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (code.length !== 6) {
      Alert.alert('Invalid', 'Enter your current 6-digit 2FA code to disable.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/2fa/disable', { code });
      await refreshUser();
      Alert.alert('Disabled', 'Two-factor authentication has been turned off.');
      router.back();
    } catch (e) {
      Alert.alert('Error', formatApiErrorDetail(e));
    } finally {
      setBusy(false);
    }
  };

  const enabled = !!user?.two_factor_enabled;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="2fa-back-button"
          onPress={() => router.back()}
          style={{ padding: 6 }}
        >
          <ArrowLeft color={theme.colors.textPrimary} size={22} />
        </TouchableOpacity>
        <Text style={styles.title}>Two-factor authentication</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.heroCard}>
          <View style={styles.heroIcon}>
            <ShieldCheck color={theme.colors.primary} size={28} strokeWidth={1.8} />
          </View>
          <Text style={styles.heroTitle}>
            {enabled ? '2FA is enabled' : 'Add a second layer of security'}
          </Text>
          <Text style={styles.heroSub}>
            Time-based one-time passwords (TOTP) compatible with Google
            Authenticator, Authy, 1Password and YubiKey OTP.
          </Text>
        </View>

        {!enabled && !secret && (
          <>
            <Text style={styles.label}>Confirm your password</Text>
            <TextInput
              testID="2fa-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={theme.colors.textMuted}
              secureTextEntry
              style={styles.passwordInput}
            />
            <TouchableOpacity
              testID="2fa-start-setup"
              style={styles.primaryBtn}
              onPress={startSetup}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color={theme.colors.background} />
              ) : (
                <Text style={styles.primaryBtnText}>Start setup</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {!enabled && secret && (
          <>
            <Text style={styles.label}>1. Add this secret to your authenticator app</Text>
            <View style={styles.secretBox}>
              <KeyRound color={theme.colors.primary} size={16} />
              <Text testID="2fa-secret" style={styles.secretText} selectable>
                {secret}
              </Text>
              <TouchableOpacity
                onPress={() => Alert.alert('Copy', 'Long press the secret to copy it.')}
              >
                <Copy color={theme.colors.textSecondary} size={16} />
              </TouchableOpacity>
            </View>
            {!!otpauth && (
              <Text testID="2fa-uri" style={styles.uriText} selectable>
                {otpauth}
              </Text>
            )}

            <Text style={styles.label}>2. Enter the current 6-digit code</Text>
            <TextInput
              testID="2fa-code-input"
              value={code}
              onChangeText={setCode}
              placeholder="123 456"
              placeholderTextColor={theme.colors.textMuted}
              keyboardType="number-pad"
              maxLength={6}
              style={styles.codeInput}
            />
            <TouchableOpacity
              testID="2fa-enable-button"
              style={styles.primaryBtn}
              onPress={enable}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color={theme.colors.background} />
              ) : (
                <Text style={styles.primaryBtnText}>Enable 2FA</Text>
              )}
            </TouchableOpacity>
          </>
        )}

        {enabled && (
          <>
            <Text style={styles.label}>Enter your current code to disable 2FA</Text>
            <TextInput
              testID="2fa-disable-code-input"
              value={code}
              onChangeText={setCode}
              placeholder="123 456"
              placeholderTextColor={theme.colors.textMuted}
              keyboardType="number-pad"
              maxLength={6}
              style={styles.codeInput}
            />
            <TouchableOpacity
              testID="2fa-disable-button"
              style={[styles.primaryBtn, { backgroundColor: theme.colors.error }]}
              onPress={disable}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={[styles.primaryBtnText, { color: '#fff' }]}>Disable 2FA</Text>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: { color: theme.colors.textPrimary, fontSize: 17, fontWeight: '600' },
  scroll: { padding: 20 },
  heroCard: {
    backgroundColor: theme.colors.surface,
    padding: 20,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 24,
  },
  heroIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.primaryDark,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  heroTitle: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  heroSub: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 19 },
  label: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 10,
  },
  secretBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.colors.surface,
    padding: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secretText: {
    flex: 1,
    color: theme.colors.primary,
    fontSize: 14,
    fontFamily: 'monospace',
    letterSpacing: 1.2,
  },
  uriText: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  codeInput: {
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
    padding: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  passwordInput: {
    backgroundColor: theme.colors.surface,
    color: theme.colors.textPrimary,
    fontSize: 16,
    padding: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 14,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    marginTop: 16,
  },
  primaryBtnText: { color: theme.colors.background, fontWeight: '700', fontSize: 15 },
});
