import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import {
  ArrowLeft,
  AtSign,
  Briefcase,
  CheckCircle2,
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
  XCircle,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import { theme } from '../../src/theme';

export default function RegisterScreen() {
  const { register } = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [title, setTitle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const un = username.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,20}$/.test(un)) {
      setUsernameAvailable(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .get('/auth/username-available', { params: { username: un } })
        .then(({ data }) => {
          if (!cancelled) setUsernameAvailable(data?.available === true);
        })
        .catch(() => {
          if (!cancelled) setUsernameAvailable(null);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username]);

  const handleSubmit = async () => {
    setError('');
    if (!username || !name || !email || !password) {
      setError('Username, name, email and password are required');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    const un = username.trim().toLowerCase().replace(/^@/, '');
    if (un && !/^[a-z0-9_]{3,20}$/.test(un)) {
      setError('Username: 3-20 chars, lowercase letters, numbers or _');
      return;
    }
    if (un && usernameAvailable === false) {
      setError('Username is already taken');
      return;
    }
    setBusy(true);
    try {
      await register(email.trim(), password, name.trim(), title.trim(), un || undefined);
      router.replace('/(tabs)/chats');
    } catch (e: any) {
      setError(e.message || 'Registration failed');
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
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity testID="back-to-login" style={styles.backBtn}>
              <ArrowLeft color={theme.colors.textPrimary} size={20} />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
          </Link>

          <Text style={styles.title}>Create account</Text>
          <Text style={styles.sub}>
            Join your enterprise workspace with secure messaging.
          </Text>

          <View style={styles.field}>
            <AtSign color={theme.colors.textSecondary} size={18} />
            <TextInput
              testID="register-username-input"
              value={username}
              onChangeText={setUsername}
              placeholder="Username (optional, e.g. jan_kowalski)"
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            {usernameAvailable === true ? (
              <CheckCircle2 color={theme.colors.success} size={19} />
            ) : usernameAvailable === false ? (
              <XCircle color={theme.colors.error} size={19} />
            ) : null}
          </View>
          <View style={styles.field}>
            <Mail color={theme.colors.textSecondary} size={18} />
            <TextInput
              testID="register-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder="Work email"
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
              keyboardType="email-address"
              style={styles.input}
            />
          </View>
          <View style={styles.field}>
            <User color={theme.colors.textSecondary} size={18} />
            <TextInput
              testID="register-name-input"
              value={name}
              onChangeText={setName}
              placeholder="Full name"
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
            />
          </View>
          <View style={styles.field}>
            <Briefcase color={theme.colors.textSecondary} size={18} />
            <TextInput
              testID="register-title-input"
              value={title}
              onChangeText={setTitle}
              placeholder="Job title (optional)"
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
            />
          </View>
          <View style={styles.field}>
            <Lock color={theme.colors.textSecondary} size={18} />
            <TextInput
              testID="register-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="Password (min 8 chars)"
              placeholderTextColor={theme.colors.textMuted}
              secureTextEntry={!showPassword}
              style={styles.input}
            />
            <TouchableOpacity
              testID="register-password-visibility"
              onPress={() => setShowPassword((value) => !value)}
              hitSlop={10}
            >
              {showPassword ? (
                <EyeOff color={theme.colors.textSecondary} size={19} />
              ) : (
                <Eye color={theme.colors.textSecondary} size={19} />
              )}
            </TouchableOpacity>
          </View>

          {!!error && (
            <Text testID="register-error" style={styles.error}>
              {error}
            </Text>
          )}

          <TouchableOpacity
            testID="register-submit-button"
            onPress={handleSubmit}
            disabled={busy}
            style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={theme.colors.background} />
            ) : (
              <Text style={styles.primaryBtnText}>Create secure account</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.legal}>
            By creating an account you accept our terms. All conversations are
            protected in transit.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  flex: { flex: 1 },
  scroll: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    padding: 24,
    paddingBottom: 32,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 },
  backText: { color: theme.colors.textPrimary, fontSize: 14 },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  sub: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    marginTop: 6,
    marginBottom: 24,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 12,
    height: 50,
    gap: 10,
  },
  input: { flex: 1, color: theme.colors.textPrimary, fontSize: 15 },
  error: { color: theme.colors.error, fontSize: 13, marginTop: 4, marginBottom: 8 },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 14,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryBtnText: { color: theme.colors.background, fontWeight: '700', fontSize: 15 },
  legal: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: 24,
    lineHeight: 16,
    textAlign: 'center',
  },
});
