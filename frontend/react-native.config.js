const skipFirebaseIos = process.env.EXPO_SKIP_FIREBASE_IOS === '1';

module.exports = {
  dependencies: skipFirebaseIos
    ? {
        '@react-native-firebase/app': {
          platforms: {
            ios: null,
          },
        },
        '@react-native-firebase/messaging': {
          platforms: {
            ios: null,
          },
        },
      }
    : {},
};
