/**
 * OnboardingProvider — runs once on first app launch.
 *
 * Shows a 3-step modal flow:
 *   1. Welcome (brand splash + CTA)
 *   2. Terms of Use + Privacy Policy acceptance (required checkbox)
 *   3. Permissions request (notifications, microphone, camera, photos)
 *
 * State is persisted to AsyncStorage under `ghostel.onboarding.v1`.
 * Once completed, the overlay is never shown again on this device.
 *
 * Mounted near the root layout — appears OVER everything else when active.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  ActivityIndicator,
  Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ShieldCheck,
  Lock,
  Bell,
  Mic,
  Camera,
  Image as ImageIcon,
  Check,
  ChevronRight,
  Settings as SettingsIcon,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { theme } from './theme';

const STORAGE_KEY = 'ghostel.onboarding.v1';

type Step = 'welcome' | 'terms' | 'permissions';
type PermKey = 'notifications' | 'microphone' | 'camera' | 'photos';
type PermStatus = 'unknown' | 'granted' | 'denied';

type OnboardingState = {
  completed: boolean | null; // null until storage check finishes
  reset: () => Promise<void>; // for debugging / settings reset
};

const Ctx = createContext<OnboardingState | undefined>(undefined);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [completed, setCompleted] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(STORAGE_KEY);
        setCompleted(v === 'true');
      } catch {
        setCompleted(false);
      }
    })();
  }, []);

  const finish = useCallback(async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      /* ignore */
    }
    setCompleted(true);
  }, []);

  const reset = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setCompleted(false);
  }, []);

  const value = useMemo<OnboardingState>(
    () => ({ completed, reset }),
    [completed, reset],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {completed === false ? <OnboardingOverlay onFinish={finish} /> : null}
    </Ctx.Provider>
  );
}

export function useOnboarding(): OnboardingState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOnboarding must be inside OnboardingProvider');
  return v;
}

/* ===================== Overlay ===================== */

function OnboardingOverlay({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('welcome');
  const [agreed, setAgreed] = useState(false);
  const [perms, setPerms] = useState<Record<PermKey, PermStatus>>({
    notifications: 'unknown',
    microphone: 'unknown',
    camera: 'unknown',
    photos: 'unknown',
  });
  const [requesting, setRequesting] = useState<PermKey | null>(null);

  // Pre-check existing permission statuses so we don't double-prompt
  useEffect(() => {
    if (step !== 'permissions') return;
    (async () => {
      const next: Record<PermKey, PermStatus> = { ...perms };
      try {
        const Notifications = await import('expo-notifications');
        const s = await Notifications.getPermissionsAsync();
        next.notifications = s.granted ? 'granted' : s.canAskAgain ? 'unknown' : 'denied';
      } catch {
        /* skip */
      }
      try {
        const ImagePicker = await import('expo-image-picker');
        const cam = await ImagePicker.getCameraPermissionsAsync();
        next.camera = cam.granted ? 'granted' : cam.canAskAgain ? 'unknown' : 'denied';
        const lib = await ImagePicker.getMediaLibraryPermissionsAsync();
        next.photos = lib.granted ? 'granted' : lib.canAskAgain ? 'unknown' : 'denied';
      } catch {
        /* skip */
      }
      try {
        const Audio = await import('expo-audio');
        const s = await Audio.getRecordingPermissionsAsync();
        next.microphone = s.granted ? 'granted' : s.canAskAgain ? 'unknown' : 'denied';
      } catch {
        /* skip */
      }
      setPerms(next);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const requestPerm = async (key: PermKey) => {
    setRequesting(key);
    try {
      let granted = false;
      let canAskAgain = true;
      if (key === 'notifications') {
        const Notifications = await import('expo-notifications');
        const res = await Notifications.requestPermissionsAsync();
        granted = !!res.granted;
        canAskAgain = !!res.canAskAgain;
      } else if (key === 'camera') {
        const ImagePicker = await import('expo-image-picker');
        const res = await ImagePicker.requestCameraPermissionsAsync();
        granted = !!res.granted;
        canAskAgain = !!res.canAskAgain;
      } else if (key === 'photos') {
        const ImagePicker = await import('expo-image-picker');
        const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
        granted = !!res.granted;
        canAskAgain = !!res.canAskAgain;
      } else if (key === 'microphone') {
        const Audio = await import('expo-audio');
        const res = await Audio.requestRecordingPermissionsAsync();
        granted = !!res.granted;
        canAskAgain = !!res.canAskAgain;
      }
      setPerms((p) => ({
        ...p,
        [key]: granted ? 'granted' : canAskAgain ? 'unknown' : 'denied',
      }));
    } catch {
      setPerms((p) => ({ ...p, [key]: 'denied' }));
    } finally {
      setRequesting(null);
    }
  };

  return (
    <View style={styles.overlay} testID="onboarding-overlay">
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        {step === 'welcome' && (
          <WelcomeStep t={t} onNext={() => setStep('terms')} />
        )}
        {step === 'terms' && (
          <TermsStep
            t={t}
            agreed={agreed}
            onAgreedChange={setAgreed}
            onNext={() => setStep('permissions')}
          />
        )}
        {step === 'permissions' && (
          <PermissionsStep
            t={t}
            perms={perms}
            requesting={requesting}
            onRequest={requestPerm}
            onFinish={onFinish}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

/* ===================== Step views ===================== */

function WelcomeStep({ t, onNext }: { t: any; onNext: () => void }) {
  return (
    <View style={styles.stepWrap}>
      <View style={styles.stepBody}>
        <Image
          source={require('../assets/images/icon.png')}
          style={styles.logoBig}
          resizeMode="contain"
        />
        <Text style={styles.welcomeTitle}>{t('onboarding.welcome_title')}</Text>
        <Text style={styles.welcomeSubtitle}>{t('onboarding.welcome_subtitle')}</Text>
        <Text style={styles.welcomeBody}>{t('onboarding.welcome_body')}</Text>
      </View>
      <View style={styles.stepFooter}>
        <PrimaryButton
          label={t('onboarding.welcome_cta')}
          onPress={onNext}
          testID="onboarding-welcome-cta"
        />
      </View>
    </View>
  );
}

function TermsStep({
  t,
  agreed,
  onAgreedChange,
  onNext,
}: {
  t: any;
  agreed: boolean;
  onAgreedChange: (v: boolean) => void;
  onNext: () => void;
}) {
  return (
    <View style={styles.stepWrap}>
      <View style={styles.stepHeader}>
        <Lock color={theme.colors.primary} size={20} strokeWidth={2} />
        <Text style={styles.stepHeaderTitle}>{t('onboarding.terms_title')}</Text>
      </View>
      <Text style={styles.stepIntro}>{t('onboarding.terms_intro')}</Text>
      <ScrollView style={styles.termsScroll} contentContainerStyle={styles.termsContent}>
        <Text style={styles.termsBody}>{t('onboarding.terms_body')}</Text>
      </ScrollView>
      <TouchableOpacity
        style={styles.acceptRow}
        onPress={() => onAgreedChange(!agreed)}
        testID="onboarding-accept-toggle"
        activeOpacity={0.8}
      >
        <View
          style={[styles.checkbox, agreed && styles.checkboxOn]}
          testID="onboarding-accept-checkbox"
        >
          {agreed && <Check color={theme.colors.background} size={14} strokeWidth={3} />}
        </View>
        <Text style={styles.acceptText}>{t('onboarding.terms_accept_label')}</Text>
      </TouchableOpacity>
      <View style={styles.stepFooter}>
        <PrimaryButton
          label={t('onboarding.terms_continue')}
          onPress={onNext}
          disabled={!agreed}
          testID="onboarding-terms-continue"
        />
      </View>
    </View>
  );
}

function PermissionsStep({
  t,
  perms,
  requesting,
  onRequest,
  onFinish,
}: {
  t: any;
  perms: Record<PermKey, PermStatus>;
  requesting: PermKey | null;
  onRequest: (k: PermKey) => void;
  onFinish: () => void;
}) {
  const items: { key: PermKey; icon: any; title: string; desc: string }[] = [
    {
      key: 'notifications',
      icon: Bell,
      title: t('onboarding.perm_notifications'),
      desc: t('onboarding.perm_notifications_desc'),
    },
    {
      key: 'microphone',
      icon: Mic,
      title: t('onboarding.perm_microphone'),
      desc: t('onboarding.perm_microphone_desc'),
    },
    {
      key: 'camera',
      icon: Camera,
      title: t('onboarding.perm_camera'),
      desc: t('onboarding.perm_camera_desc'),
    },
    {
      key: 'photos',
      icon: ImageIcon,
      title: t('onboarding.perm_photos'),
      desc: t('onboarding.perm_photos_desc'),
    },
  ];

  return (
    <View style={styles.stepWrap}>
      <View style={styles.stepHeader}>
        <ShieldCheck color={theme.colors.primary} size={20} strokeWidth={2} />
        <Text style={styles.stepHeaderTitle}>{t('onboarding.perms_title')}</Text>
      </View>
      <Text style={styles.stepIntro}>{t('onboarding.perms_intro')}</Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>
        {items.map((it) => (
          <PermRow
            key={it.key}
            icon={it.icon}
            title={it.title}
            desc={it.desc}
            status={perms[it.key]}
            busy={requesting === it.key}
            onPress={() => {
              if (perms[it.key] === 'denied') {
                Linking.openSettings?.();
              } else if (perms[it.key] !== 'granted') {
                onRequest(it.key);
              }
            }}
            t={t}
            testID={`perm-row-${it.key}`}
          />
        ))}
      </ScrollView>
      <View style={styles.stepFooter}>
        <PrimaryButton
          label={t('onboarding.perms_finish')}
          onPress={onFinish}
          testID="onboarding-finish"
        />
        <TouchableOpacity
          onPress={onFinish}
          style={styles.skipBtn}
          testID="onboarding-skip"
        >
          <Text style={styles.skipText}>{t('onboarding.perms_skip')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function PermRow({
  icon: Icon,
  title,
  desc,
  status,
  busy,
  onPress,
  t,
  testID,
}: {
  icon: any;
  title: string;
  desc: string;
  status: PermStatus;
  busy: boolean;
  onPress: () => void;
  t: any;
  testID?: string;
}) {
  const isGranted = status === 'granted';
  const isDenied = status === 'denied';
  return (
    <View style={styles.permRow} testID={testID}>
      <View style={styles.permIcon}>
        <Icon
          color={isGranted ? theme.colors.success : theme.colors.primary}
          size={22}
          strokeWidth={1.8}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.permTitle}>{title}</Text>
        <Text style={styles.permDesc}>{desc}</Text>
        {isDenied && (
          <Text style={styles.permDeniedHint}>
            {t('onboarding.perm_explain_denied')}
          </Text>
        )}
      </View>
      <TouchableOpacity
        onPress={onPress}
        disabled={isGranted || busy}
        style={[
          styles.permBtn,
          isGranted && styles.permBtnGranted,
          isDenied && styles.permBtnDenied,
        ]}
        activeOpacity={0.8}
        testID={`${testID}-action`}
      >
        {busy ? (
          <ActivityIndicator color={theme.colors.background} size="small" />
        ) : isGranted ? (
          <>
            <Check color={theme.colors.success} size={14} strokeWidth={2.5} />
            <Text style={[styles.permBtnText, { color: theme.colors.success }]}>
              {t('onboarding.perm_granted')}
            </Text>
          </>
        ) : isDenied ? (
          <>
            <SettingsIcon color="#fff" size={14} strokeWidth={2.2} />
            <Text style={[styles.permBtnText, { color: '#fff' }]}>
              {t('onboarding.perm_open_settings')}
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.permBtnText, { color: theme.colors.background }]}>
              {t('onboarding.perm_grant')}
            </Text>
            <ChevronRight color={theme.colors.background} size={14} strokeWidth={2.5} />
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

/* ===================== Bits ===================== */

function PrimaryButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.primaryBtn, disabled && styles.primaryBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      testID={testID}
    >
      <Text style={[styles.primaryBtnText, disabled && { opacity: 0.6 }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
    zIndex: 9999,
  },
  stepWrap: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 12,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  stepHeaderTitle: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  stepBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  logoBig: {
    width: 120,
    height: 120,
    marginBottom: 24,
  },
  welcomeTitle: {
    color: theme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 6,
    textAlign: 'center',
  },
  welcomeSubtitle: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 20,
    textAlign: 'center',
  },
  welcomeBody: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  stepIntro: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  termsScroll: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
  },
  termsContent: { padding: 14 },
  termsBody: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 21,
  },
  acceptRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  acceptText: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  stepFooter: { paddingTop: 8 },
  primaryBtn: {
    backgroundColor: theme.colors.primary,
    paddingVertical: 14,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
  },
  primaryBtnDisabled: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  primaryBtnText: {
    color: theme.colors.background,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  skipBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  skipText: { color: theme.colors.textMuted, fontSize: 13 },
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    marginBottom: 10,
  },
  permIcon: {
    width: 36,
    alignItems: 'center',
  },
  permTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  permDesc: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  permDeniedHint: {
    color: theme.colors.warning,
    fontSize: 11,
    marginTop: 6,
    lineHeight: 15,
  },
  permBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    minWidth: 80,
    justifyContent: 'center',
  },
  permBtnGranted: {
    backgroundColor: theme.colors.success + '20',
    borderWidth: 1,
    borderColor: theme.colors.success + '60',
  },
  permBtnDenied: {
    backgroundColor: theme.colors.error,
  },
  permBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
