module.exports = ({ config }) => {
  const skipFirebaseIos = process.env.EXPO_SKIP_FIREBASE_IOS === '1';

  if (!skipFirebaseIos) {
    return config;
  }

  const firebasePlugins = new Set([
    '@react-native-firebase/app',
    '@react-native-firebase/messaging',
    './plugins/withFirebaseManifestFix',
  ]);

  return {
    ...config,
    plugins: [
      ...(config.plugins || []).filter((plugin) => {
        const pluginName = Array.isArray(plugin) ? plugin[0] : plugin;
        return !firebasePlugins.has(pluginName);
      }),
      './plugins/withIosModularHeaders',
    ],
  };
};
