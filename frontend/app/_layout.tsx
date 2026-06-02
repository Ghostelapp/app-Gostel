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
import { setupCallKeep } from '../src/callkeep';
import { registerFcmHandlers } from '../src/fcmBackground';

setNotificationHandler();
// Eagerly load the user's in-app sound preference from storage.
hydrateSoundPrefs().catch(() => {});
// Register the FCM background message handler IMMEDIATELY (must run before
// any incoming push). Wrapped — no-op on web or if firebase isn't installed.
// MUST be at module level per Firebase docs (Headless JS for killed app).
try {
  registerFcmHandlers();
} catch (e) {
  console.warn('[boot] registerFcmHandlers failed', e);
}
// Native CallKit / Telecom incoming-call UI is deferred to useEffect because
// RNCallKeep.setup() may need the Activity to be fully initialized.

export default function RootLayout() {
  const router = useRouter();

  // Color the Android navigation bar to match app theme
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    (async () => {
      try {
        const NavBar = await import('expo-navigation-bar');
        await NavBar.setBackgroundColorAsync('#0f1419');
        await NavBar.setButtonStyleAsync('light');
      } catch {
        /* expo-navigation-bar not available in this build */
      }
    })();
  }, []);

  // Initialise CallKeep AFTER the Activity is fully mounted (was previously
  // called at module level which can crash on Android because the Telecom
  // ConnectionService isn't reachable until the Activity is ready).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    setupCallKeep().catch((e) => console.warn('[boot] setupCallKeep failed', e));
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
