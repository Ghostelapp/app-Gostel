/**
 * withFirebaseManifestFix.js
 *
 * Expo config plugin to resolve a manifest merger conflict that happens when
 * BOTH `expo-notifications` (with defaultChannel config) AND
 * `@react-native-firebase/messaging` are used together.
 *
 * Without this fix, EAS Android build fails with:
 *   > Task :app:processReleaseMainManifest FAILED
 *   Manifest merger failed : Attribute meta-data#
 *   com.google.firebase.messaging.default_notification_channel_id@value
 *   value=(messages) ... is also present at [:react-native-firebase_messaging]
 *
 * Both libs want to declare the same meta-data tag — we tell Android Gradle
 * Plugin to use ours via `tools:replace="android:value"`.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const META_NAME = 'com.google.firebase.messaging.default_notification_channel_id';

const withFirebaseManifestFix = (config) => {
  return withAndroidManifest(config, async (cfg) => {
    const manifest = cfg.modResults;

    // Ensure xmlns:tools is declared on the root <manifest> element so we can
    // use `tools:replace="..."` later.
    if (!manifest.manifest.$) {
      manifest.manifest.$ = {};
    }
    if (!manifest.manifest.$['xmlns:tools']) {
      manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    // Walk every <application> and patch the conflicting meta-data tag.
    const apps = manifest.manifest.application || [];
    for (const app of apps) {
      if (!app['meta-data']) continue;
      app['meta-data'] = app['meta-data'].map((item) => {
        if (item && item.$ && item.$['android:name'] === META_NAME) {
          item.$['tools:replace'] = 'android:value';
        }
        return item;
      });
    }

    return cfg;
  });
};

module.exports = withFirebaseManifestFix;
