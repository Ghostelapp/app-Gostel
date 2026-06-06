/**
 * PinLock — local PIN code app lock.
 *
 * Stores a SHA-256 hash of the PIN in `expo-secure-store` (Keychain on iOS,
 * EncryptedSharedPreferences on Android).
 *
 * - On cold launch when a PIN is set → app is locked.
 * - When the app returns from background after >`AUTO_LOCK_MS` → app is locked.
 * - User unlocks by entering the correct PIN.
 *
 * No biometric (per user request — PIN only).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  AppState,
  AppStateStatus,
  Image,
  Vibration,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Delete, LogOut } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { theme } from './theme';

const PIN_KEY = 'ghostel.pinHash.v1';
const AUTO_LOCK_MS = 30_000; // re-lock when app has been backgrounded for >30s
const canUseSecureStore = Platform.OS !== 'web';

type PinLockState = {
  pinSet: boolean;
  isLocked: boolean;
  loading: boolean;
  setPin: (pin: string) => Promise<void>;
  clearPin: (currentPin: string) => Promise<boolean>;
  verifyPin: (pin: string) => Promise<boolean>;
  lockNow: () => void;
  /** Unlock without verifying — for use after a successful logout. */
  unlock: () => void;
  /** Force-disable the lock from sign-out flow (clears stored PIN regardless). */
  forceClearForLogout: () => Promise<void>;
};

const Ctx = createContext<PinLockState | undefined>(undefined);

async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `ghostel:v1:${pin}`,
  );
}

async function getStoredPinHash(): Promise<string | null> {
  if (!canUseSecureStore) return AsyncStorage.getItem(PIN_KEY);
  return SecureStore.getItemAsync(PIN_KEY);
}

async function setStoredPinHash(hash: string): Promise<void> {
  if (!canUseSecureStore) {
    await AsyncStorage.setItem(PIN_KEY, hash);
    return;
  }
  await SecureStore.setItemAsync(PIN_KEY, hash);
}

async function removeStoredPinHash(): Promise<void> {
  if (!canUseSecureStore) {
    await AsyncStorage.removeItem(PIN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(PIN_KEY);
}

export function PinLockProvider({ children }: { children: React.ReactNode }) {
  const [pinSet, setPinSet] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const backgroundedAtRef = useRef<number | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Load saved hash on cold start → lock immediately if PIN exists
  useEffect(() => {
    (async () => {
      try {
        const stored = await getStoredPinHash();
        const has = !!stored;
        setPinSet(has);
        setIsLocked(has); // cold launch with PIN → require unlock
      } catch {
        setPinSet(false);
        setIsLocked(false);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Listen for app foreground/background transitions
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'background' || next === 'inactive') {
        if (prev === 'active') backgroundedAtRef.current = Date.now();
      } else if (next === 'active' && prev !== 'active') {
        // Returned to foreground
        const since = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (since && Date.now() - since >= AUTO_LOCK_MS && pinSet) {
          setIsLocked(true);
        }
      }
    });
    return () => sub.remove();
  }, [pinSet]);

  const setPin = useCallback(async (pin: string) => {
    const hash = await hashPin(pin);
    await setStoredPinHash(hash);
    setPinSet(true);
    setIsLocked(false);
  }, []);

  const verifyPin = useCallback(async (pin: string) => {
    const stored = await getStoredPinHash();
    if (!stored) return true; // nothing to verify against
    const h = await hashPin(pin);
    return h === stored;
  }, []);

  const clearPin = useCallback(async (currentPin: string) => {
    const ok = await verifyPin(currentPin);
    if (!ok) return false;
    await removeStoredPinHash();
    setPinSet(false);
    setIsLocked(false);
    return true;
  }, [verifyPin]);

  const forceClearForLogout = useCallback(async () => {
    try {
      await removeStoredPinHash();
    } catch {
      /* noop */
    }
    setPinSet(false);
    setIsLocked(false);
  }, []);

  const lockNow = useCallback(() => {
    if (pinSet) setIsLocked(true);
  }, [pinSet]);

  const unlock = useCallback(() => setIsLocked(false), []);

  const value = useMemo<PinLockState>(() => ({
    pinSet,
    isLocked,
    loading,
    setPin,
    clearPin,
    verifyPin,
    lockNow,
    unlock,
    forceClearForLogout,
  }), [pinSet, isLocked, loading, setPin, clearPin, verifyPin, lockNow, unlock, forceClearForLogout]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {isLocked ? <LockOverlay /> : null}
    </Ctx.Provider>
  );
}

export function usePinLock(): PinLockState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePinLock must be used inside PinLockProvider');
  return v;
}

/* --------------------------------------------------------------------- */
/* Lock overlay UI                                                       */
/* --------------------------------------------------------------------- */

function LockOverlay() {
  const { t } = useTranslation();
  const { verifyPin, unlock, forceClearForLogout } = usePinLock();
  const [entered, setEntered] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const verifying = useRef(false);
  const MIN_LEN = 4;
  const MAX_LEN = 6;

  const onDigit = (d: string) => {
    setError(null);
    setEntered((prev) => {
      if (prev.length >= MAX_LEN) return prev;
      return prev + d;
    });
  };

  const onBack = () => {
    setError(null);
    setEntered((prev) => prev.slice(0, -1));
  };

  // Auto-verify when reaching min length on each digit
  useEffect(() => {
    if (entered.length < MIN_LEN) return;
    if (verifying.current) return;
    verifying.current = true;
    (async () => {
      const ok = await verifyPin(entered);
      verifying.current = false;
      if (ok) {
        setEntered('');
        unlock();
      } else if (entered.length >= MAX_LEN) {
        setError(t('pinlock.wrong'));
        Vibration.vibrate(120);
        setAttempts((a) => a + 1);
        setEntered('');
      }
    })();
  }, [entered, verifyPin, unlock, t]);

  const dots = Array.from({ length: MAX_LEN }, (_, i) => i < entered.length);

  const KEYS: (string | null)[] = ['1','2','3','4','5','6','7','8','9', null, '0', 'back'];

  return (
    <View style={styles.overlay} testID="pin-lock-overlay">
      <View style={styles.header}>
        <Image
          source={require('../assets/images/icon.png')}
          style={styles.logoCircle}
          resizeMode="contain"
        />
        <Text style={styles.title}>{t('pinlock.locked_title')}</Text>
        <Text style={styles.subtitle}>{t('pinlock.locked_subtitle')}</Text>
      </View>

      <View style={styles.dotsRow}>
        {dots.map((filled, i) => (
          <View
            key={i}
            style={[styles.dot, filled && styles.dotFilled]}
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
          if (k === null) {
            return <View key={idx} style={styles.keyPlaceholder} />;
          }
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

      {attempts >= 5 && (
        <TouchableOpacity
          style={styles.forgotBtn}
          onPress={async () => {
            // After many failed attempts, allow user to escape via signing out
            // (we don't have biometric per user request, and rather than support
            // hidden recovery we let the user log out, which clears the PIN).
            await forceClearForLogout();
          }}
          testID="pin-forgot"
        >
          <LogOut color={theme.colors.error} size={14} strokeWidth={2} />
          <Text style={styles.forgotText}>{t('pinlock.forgot_signout')}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: Platform.OS === 'android' ? 80 : 110,
    paddingHorizontal: 24,
    zIndex: 10000,
  },
  header: { alignItems: 'center', marginBottom: 24 },
  logoCircle: {
    width: 72,
    height: 72,
    marginBottom: 14,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    marginTop: 6,
    fontSize: 13,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 8,
    marginBottom: 16,
  },
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
  errorText: {
    color: theme.colors.error,
    fontSize: 13,
    marginBottom: 8,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 264,
    justifyContent: 'space-between',
    marginTop: 8,
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
  keyText: {
    color: theme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '500',
  },
  forgotBtn: {
    marginTop: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  forgotText: { color: theme.colors.error, fontSize: 13, fontWeight: '600' },
});
