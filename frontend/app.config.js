const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const skipFirebaseIos = process.env.EXPO_SKIP_FIREBASE_IOS === '1';
  const requireFirebaseIos = process.env.EXPO_REQUIRE_FIREBASE_IOS === '1';
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
            googleServicesFile: iosGoogleServicesFile,
          }
        : config.ios,
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
    plugins: [
      ...withUniquePlugin((config.plugins || []).filter((plugin) => {
        const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
        return !firebasePlugins.has(pluginName);
      }), iosModularHeadersPlugin),
    ],
  };
};
