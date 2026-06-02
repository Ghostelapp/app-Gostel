// Native (iOS/Android) — re-export react-native-webrtc
// Note: requires expo dev build (does NOT work in Expo Go)
export const getWebRTC = () => {
  try {
    return require('react-native-webrtc');
  } catch {
    return null;
  }
};
