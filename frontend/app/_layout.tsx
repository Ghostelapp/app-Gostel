import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/auth';
import IncomingCallProvider from '../src/IncomingCallProvider';
import { setNotificationHandler, subscribeToNotificationTaps } from '../src/push';
import { LanguageProvider } from '../src/i18n/LanguageProvider';
import { BadgeProvider } from '../src/badges';
import { PinLockProvider } from '../src/pinLock';
import { OnboardingProvider } from '../src/onboarding';
import { hydrateSoundPrefs } from '../src/sounds';

setNotificationHandler();
// Eagerly load the user's in-app sound preference from storage.
hydrateSoundPrefs().catch(() => {});

export default function RootLayout() {
  const router = useRouter();

  // Color the Android navigation bar to match app theme
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    (async () => {
      try {
        const NavBar = await import('expo-navigation-bar');
        await NavBar.setButtonStyleAsync('light');
      } catch {
        /* expo-navigation-bar not available in this build */
      }
    })();
  }, []);

  // Subscribe to notification taps — route user to chat or call screen
  useEffect(() => {
    const unsub = subscribeToNotificationTaps(router);
    return () => unsub();
  }, [router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppKeyboardProvider>
        <SafeAreaProvider>
          <LanguageProvider>
            <OnboardingProvider>
              <PinLockProvider>
                <AuthProvider>
                  <BadgeProvider>
                    <IncomingCallProvider>
                      {Platform.OS !== 'web' ? (
                        <StatusBar style="light" backgroundColor="#0f1419" />
                      ) : null}
                      <NativeCallServicesBoot />
                      <Stack
                        screenOptions={{
                          headerShown: false,
                          contentStyle: { backgroundColor: '#0f1419' },
                          animation: 'fade',
                        }}
                      />
                    </IncomingCallProvider>
                  </BadgeProvider>
                </AuthProvider>
              </PinLockProvider>
            </OnboardingProvider>
          </LanguageProvider>
        </SafeAreaProvider>
      </AppKeyboardProvider>
    </GestureHandlerRootView>
  );
}

function AppKeyboardProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function NativeCallServicesBoot() {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;

      import('../src/voipPush')
        .then(({ setupVoipPushNotifications }) => {
          if (!cancelled) setupVoipPushNotifications();
        })
        .catch((error) => {
          console.warn('[boot] setupVoipPushNotifications failed', error);
        });

      import('../src/callkeep')
        .then(({ setupCallKeep }) => setupCallKeep())
        .catch((error) => {
          console.warn('[boot] setupCallKeep failed', error);
        });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return null;
}
