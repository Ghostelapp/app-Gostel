const stagingNoPush = process.env.APP_VARIANT === 'staging' && process.env.EXPO_STAGING_NO_PUSH === '1';
const skipFirebaseIos = process.env.EXPO_SKIP_FIREBASE_IOS === '1' || stagingNoPush;

module.exports = {
  dependencies: skipFirebaseIos
    ? {
        '@react-native-firebase/app': {
          platforms: {
            ios: null,
            ...(stagingNoPush ? { android: null } : {}),
          },
        },
        '@react-native-firebase/messaging': {
          platforms: {
            ios: null,
            ...(stagingNoPush ? { android: null } : {}),
          },
        },
      }
    : {},
};
