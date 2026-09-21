/* global __dirname */
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  // Use the existing opaque brand asset for the App Store icon on iOS.
  config = {
    ...config,
    ios: { ...(config.ios || {}), icon: './assets/images/ghostel-logo.jpg' },
    plugins: (config.plugins || []).map((plugin) =>
      Array.isArray(plugin) && plugin[0] === 'expo-splash-screen'
        ? [plugin[0], { ...plugin[1], ios: { ...plugin[1]?.ios, image: './assets/images/ghostel-logo.jpg' } }]
        : plugin,
    ),
  };
  const skipFirebaseIos = process.env.EXPO_SKIP_FIREBASE_IOS === '1';
  const requireFirebaseIos = process.env.EXPO_REQUIRE_FIREBASE_IOS === '1';
  if (skipFirebaseIos && requireFirebaseIos) {
    throw new Error('Cannot require and skip Firebase for the same iOS build.');
  }
  const useJscIos = process.env.EXPO_USE_JSC_IOS === '1';
  const iosGoogleServicesFile = './GoogleService-Info.plist';
  const iosGoogleServicesPath = path.join(__dirname, 'GoogleService-Info.plist');
  const iosModularHeadersPlugin = './plugins/withIosModularHeaders';
  const hasIosGoogleServicesFile = fs.existsSync(iosGoogleServicesPath);

  const withUniquePlugin = (plugins, pluginName) => {
    const hasPlugin = plugins.some((plugin) => {
      const name = Array.isArray(plugin) ? plugin[0] : plugin;
      return name === pluginName;
    });

    return hasPlugin ? plugins : [...plugins, pluginName];
  };

  if (!skipFirebaseIos) {
    if (requireFirebaseIos && !hasIosGoogleServicesFile) {
      throw new Error(
        'Full iOS Firebase build requires frontend/GoogleService-Info.plist for bundle ID app.ghostel.',
      );
    }

    return {
      ...config,
      ios: hasIosGoogleServicesFile
        ? {
            ...(config.ios || {}),
            ...(useJscIos ? { jsEngine: 'jsc' } : {}),
            googleServicesFile: iosGoogleServicesFile,
          }
        : {
            ...(config.ios || {}),
            ...(useJscIos ? { jsEngine: 'jsc' } : {}),
          },
      plugins: withUniquePlugin(config.plugins || [], iosModularHeadersPlugin),
    };
  }

  const firebasePlugins = new Set([
    '@react-native-firebase/app',
    '@react-native-firebase/messaging',
    './plugins/withFirebaseManifestFix',
  ]);

  return {
    ...config,
    ios: {
      ...(config.ios || {}),
      ...(useJscIos ? { jsEngine: 'jsc' } : {}),
    },
    plugins: [
      ...withUniquePlugin((config.plugins || []).filter((plugin) => {
        const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
        return !firebasePlugins.has(pluginName);
      }), iosModularHeadersPlugin),
    ],
  };
};
