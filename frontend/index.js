import { LogBox, Platform } from 'react-native';
import { registerFcmHandlers } from './src/fcmBackground';
import { setupCallKeep } from './src/callkeep';

if (__DEV__) {
  LogBox.ignoreLogs([
    '`setBackgroundColorAsync` is not supported with edge-to-edge enabled.',
    'This method is deprecated (as well as all React Native Firebase namespaced API)',
  ]);
}

// Register Firebase Messaging handlers before Expo Router mounts. Android can
// start Headless JS for data-only FCM pushes without rendering app/_layout.tsx.
try {
  registerFcmHandlers();
} catch (error) {
  console.warn('[boot] registerFcmHandlers failed', error);
}

if (Platform.OS === 'ios') {
  setupCallKeep().catch((error) => {
    console.warn('[boot] setupCallKeep failed', error);
  });
}

import 'expo-router/entry';
