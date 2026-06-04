/**
 * Settings → App lock (PIN code).
 *
 * Lets the user set, change, or disable a 4-6 digit numeric PIN that locks the
 * app on cold launch and after returning from background.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Vibration,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Delete, Lock, ShieldCheck } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../../src/theme';
import { usePinLock } from '../../src/pinLock';

const MIN_LEN = 4;
const MAX_LEN = 6;

type Step =
  | 'enter_current'       // change/disable: enter current first
  | 'enter_new'           // setup or change: enter new PIN
  | 'confirm_new'         // setup or change: confirm new PIN
  | 'done';

export default function AppLockScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { pinSet, setPin, clearPin, verifyPin } = usePinLock();

  const [mode, setMode] = useState<'idle' | 'setup' | 'change' | 'disable'>('idle');
  const [step, setStep] = useState<Step>('enter_new');
  const [entered, setEntered] = useState('');
  const [draftNewPin, setDraftNewPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const reset = () => {
    setMode('idle');
    setEntered('');
    setDraftNewPin(null);
    setError(null);
    setStep('enter_new');
  };

  const onDigit = (d: string) => {
    setError(null);
    setEntered((p) => (p.length >= MAX_LEN ? p : p + d));
  };
  const onBack = () => {
    setError(null);
    setEntered((p) => p.slice(0, -1));
  };

  // Auto-advance when length reaches min/max
  useEffect(() => {
    if (mode === 'idle') return;
    if (entered.length < MIN_LEN) return;
    if (busy.current) return;

    // For setup steps, wait until user reaches MAX_LEN OR taps a confirm action.
    // To keep UX simple we auto-confirm on hitting MAX_LEN OR press of any extra digit.
    // We also auto-advance when min reached AFTER a small delay handled here.
    const handle = async () => {
      busy.current = true;
      try {
        if (step === 'enter_current') {
          if (entered.length < MIN_LEN) return;
          if (entered.length >= MIN_LEN) {
            // try verify
            const ok = await verifyPin(entered);
            if (ok) {
              if (mode === 'disable') {
                await clearPin(entered);
                Alert.alert(t('pinlock.disabled_title'), t('pinlock.disabled_body'));
                router.back();
                return;
              }
              // change → next step is new pin
              setEntered('');
              setStep('enter_new');
              return;
            }
            if (entered.length >= MAX_LEN) {
              setError(t('pinlock.wrong'));
              Vibration.vibrate(120);
              setEntered('');
            }
          }
        } else if (step === 'enter_new') {
          if (entered.length >= MAX_LEN) {
            setDraftNewPin(entered);
            setEntered('');
            setStep('confirm_new');
          }
        } else if (step === 'confirm_new') {
          if (entered.length >= MAX_LEN) {
            if (entered === draftNewPin) {
              await setPin(entered);
              Alert.alert(t('pinlock.set_title'), t('pinlock.set_body'));
              router.back();
            } else {
              setError(t('pinlock.mismatch'));
              Vibration.vibrate(120);
              setEntered('');
              setStep('enter_new');
              setDraftNewPin(null);
            }
          }
        }
      } finally {
        busy.current = false;
      }
    };
    handle();
  }, [entered, step, mode, draftNewPin, setPin, verifyPin, clearPin, router, t]);

  // -------------------------------------------------------------------- UI

  if (mode === 'idle') {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} testID="back-btn" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <ArrowLeft color={theme.colors.textPrimary} size={22} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('profile.app_lock')}</Text>
          <View style={{ width: 22 }} />
        </View>

        <View style={styles.body}>
          <View style={styles.iconCircle}>
            <ShieldCheck color={theme.colors.primary} size={28} strokeWidth={2} />
          </View>
          <Text style={styles.title}>
            {pinSet ? t('pinlock.status_on') : t('pinlock.status_off')}
          </Text>
          <Text style={styles.subtitle}>{t('profile.app_lock_desc')}</Text>

          {!pinSet ? (
            <TouchableOpacity
              testID="setup-pin"
              style={styles.primaryBtn}
              onPress={() => {
                setMode('setup');
                setStep('enter_new');
                setEntered('');
              }}
              activeOpacity={0.85}
            >
              <Lock color="#0f1419" size={16} strokeWidth={2.5} />
              <Text style={styles.primaryBtnText}>{t('profile.set_pin')}</Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity
                testID="change-pin"
                style={styles.primaryBtn}
                onPress={() => {
                  setMode('change');
                  setStep('enter_current');
                  setEntered('');
                }}
                activeOpacity={0.85}
              >
                <Lock color="#0f1419" size={16} strokeWidth={2.5} />
                <Text style={styles.primaryBtnText}>{t('profile.change_pin')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="disable-pin"
                style={styles.dangerBtn}
                onPress={() => {
                  setMode('disable');
                  setStep('enter_current');
                  setEntered('');
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.dangerBtnText}>{t('profile.disable_pin')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Keypad screens (setup/change/disable)
  const headerLabel =
    step === 'enter_current'
      ? t('pinlock.enter_current')
      : step === 'enter_new'
      ? t('pinlock.enter_new')
      : t('pinlock.confirm_new');

  const dots = Array.from({ length: MAX_LEN }, (_, i) => i < entered.length);
  const KEYS: (string | null)[] = ['1','2','3','4','5','6','7','8','9', null, '0', 'back'];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={reset} testID="cancel-btn" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <ArrowLeft color={theme.colors.textPrimary} size={22} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {mode === 'disable' ? t('profile.disable_pin') : t('profile.app_lock')}
        </Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.body}>
        <Text style={styles.title}>{headerLabel}</Text>
        <Text style={styles.subtitle}>{t('pinlock.hint_min_max')}</Text>

        <View style={styles.dotsRow}>
          {dots.map((filled, i) => (
            <View
              key={i}
              style={[stylesDot.dot, filled && stylesDot.dotFilled]}
              testID={`pin-dot-${i}`}
            />
          ))}
        </View>

        {!!error && (
          <Text style={styles.errorText} testID="pin-error">
            {error}
          </Text>
        )}

        <View style={styles.keypad}>
          {KEYS.map((k, idx) => {
            if (k === null) return <View key={idx} style={styles.keyPlaceholder} />;
            if (k === 'back') {
              return (
                <TouchableOpacity
                  key={idx}
                  style={styles.key}
                  onPress={onBack}
                  testID="pin-key-back"
                  activeOpacity={0.6}
                >
                  <Delete color={theme.colors.textPrimary} size={22} strokeWidth={2} />
                </TouchableOpacity>
              );
            }
            return (
              <TouchableOpacity
                key={idx}
                style={styles.key}
                onPress={() => onDigit(k)}
                testID={`pin-key-${k}`}
                activeOpacity={0.6}
              >
                <Text style={styles.keyText}>{k}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

const stylesDot = StyleSheet.create({
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
  },
  dotFilled: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    color: theme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'android' ? 32 : 48,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.primary + '50',
    marginBottom: 16,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginTop: 4,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  primaryBtn: {
    marginTop: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.pill,
  },
  primaryBtnText: { color: '#0f1419', fontSize: 14, fontWeight: '700' },
  dangerBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  dangerBtnText: {
    color: theme.colors.error,
    fontSize: 14,
    fontWeight: '600',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 22,
    marginBottom: 14,
  },
  errorText: {
    color: theme.colors.error,
    fontSize: 13,
    marginBottom: 6,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 264,
    justifyContent: 'space-between',
    marginTop: 6,
  },
  key: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 6,
  },
  keyPlaceholder: { width: 72, height: 72, marginVertical: 6 },
  keyText: { color: theme.colors.textPrimary, fontSize: 24, fontWeight: '500' },
});
