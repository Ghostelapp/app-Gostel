import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { Lock, Mail, ShieldCheck } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../src/auth';
import { theme } from '../../src/theme';

export default function LoginScreen() {
  const { login } = useAuth();
  const router = useRouter();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [require2FA, setRequire2FA] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');
    if (!email || !password) {
      setError(t('auth.email_password_required'));
      return;
    }
    setBusy(true);
    try {
      const res = await login(email.trim(), password, totp || undefined);
      if (res.requires_2fa) {
        setRequire2FA(true);
      } else {
        router.replace('/(tabs)/chats');
      }
    } catch (e: any) {
      setError(e.message || t('auth.login_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            {Platform.OS === 'web' ? (
              <View style={styles.logoCircle}>
                <ShieldCheck color={theme.colors.background} size={36} strokeWidth={2.2} />
              </View>
            ) : (
              <Image
                source={require('../../assets/images/icon.png')}
                style={styles.logoImage}
                resizeMode="contain"
              />
            )}
            <Text style={styles.brandTitle}>Ghostel</Text>
            <Text style={styles.brandSub}>{t('auth.brand_subtitle')}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('auth.sign_in')}</Text>
            <Text style={styles.cardSub}>{t('auth.private_tagline')}</Text>

            <View style={styles.field}>
              <Mail color={theme.colors.textSecondary} size={18} />
              <TextInput
                testID="login-email-input"
                value={email}
                onChangeText={setEmail}
                placeholder={t('auth.email_placeholder')}
                placeholderTextColor={theme.colors.textMuted}
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
              />
            </View>
            <View style={styles.field}>
              <Lock color={theme.colors.textSecondary} size={18} />
              <TextInput
                testID="login-password-input"
                value={password}
                onChangeText={setPassword}
                placeholder={t('auth.password')}
                placeholderTextColor={theme.colors.textMuted}
                secureTextEntry
                style={styles.input}
              />
            </View>

            {require2FA && (
              <View style={styles.field}>
                <ShieldCheck color={theme.colors.primary} size={18} />
                <TextInput
                  testID="login-totp-input"
                  value={totp}
                  onChangeText={setTotp}
                  placeholder={t('auth.twofa_code')}
                  placeholderTextColor={theme.colors.textMuted}
                  keyboardType="number-pad"
                  maxLength={6}
                  style={styles.input}
                />
              </View>
            )}

            {!!error && (
              <Text testID="login-error" style={styles.error}>
                {error}
              </Text>
            )}

            <TouchableOpacity
              testID="login-submit-button"
              onPress={handleLogin}
              disabled={busy}
              style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator color={theme.colors.background} />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {require2FA ? t('auth.verify_2fa') : t('auth.sign_in')}
                </Text>
              )}
            </TouchableOpacity>

            <Link href="/(auth)/register" asChild>
              <TouchableOpacity testID="goto-register-button" style={styles.linkBtn}>
                <Text style={styles.linkText}>
                  {t('auth.no_account')} <Text style={styles.linkAccent}>{t('auth.create_one')}</Text>
                </Text>
              </TouchableOpacity>
            </Link>
          </View>

          <View style={styles.footerRow}>
            <Lock color={theme.colors.textSecondary} size={12} />
            <Text style={styles.footerText}>{t('auth.secure_footer')}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 32,
    justifyContent: 'center',
  },
  brand: { alignItems: 'center', marginBottom: 36 },
  logoImage: {
    width: 96,
    height: 96,
    borderRadius: 24,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 22,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  brandTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: theme.colors.textPrimary,
    letterSpacing: -0.8,
  },
  brandSub: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    marginTop: 4,
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitle: { color: theme.colors.textPrimary, fontSize: 22, fontWeight: '600' },
  cardSub: {
    color: theme.colors.textSecondary,
    marginTop: 6,
    marginBottom: 20,
    fontSize: 13,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 12,
    height: 50,
    gap: 10,
  },
  input: { flex: 1, color: theme.colors.textPrimary, fontSize: 15 },
  error: {
    color: theme.colors.error,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 8,
  },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 14,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: {
    color: theme.colors.background,
    fontWeight: '700',
    fontSize: 15,
    letterSpacing: 0.3,
  },
  linkBtn: { alignItems: 'center', marginTop: 16 },
  linkText: { color: theme.colors.textSecondary, fontSize: 13 },
  linkAccent: { color: theme.colors.primary, fontWeight: '600' },
  footerRow: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 28,
  },
  footerText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
});
