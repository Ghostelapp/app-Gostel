import { LogBox, Platform } from 'react-native';
import { registerFcmHandlers } from './src/fcmBackground';

if (__DEV__) {
  LogBox.ignoreLogs([
    '`setBackgroundColorAsync` is not supported with edge-to-edge enabled.',
    'This method is deprecated (as well as all React Native Firebase namespaced API)',
  ]);
}

// Android must register Firebase Messaging before Expo Router mounts so Headless
// JS can handle data-only call pushes without rendering app/_layout.tsx.
if (Platform.OS === 'android') {
  try {
    registerFcmHandlers();
  } catch (error) {
    console.warn('[boot] registerFcmHandlers failed', error);
  }
}

// eslint-disable-next-line import/first
import 'expo-router/entry';
