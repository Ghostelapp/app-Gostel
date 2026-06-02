/**
 * withWakeScreenAndroidActivity — Expo config plugin.
 *
 * Adds the following attributes to MainActivity in AndroidManifest.xml so
 * the app can launch on top of the lockscreen when the user taps an incoming
 * call notification (or any high-priority push). Without these, Android will
 * launch the app behind the lockscreen and the user must unlock first.
 *
 *   android:showWhenLocked="true"
 *   android:turnScreenOn="true"
 *
 * Also adds <uses-permission> entries that aren't always picked up by Expo
 * managed permissions array (e.g. POST_NOTIFICATIONS on Android 13+, and
 * USE_FULL_SCREEN_INTENT on Android 14+).
 *
 * Applied at `expo prebuild` / `eas build` time.
 */
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

function setMainActivityWakeFlags(androidManifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  const activities = app.activity || [];
  for (const activity of activities) {
    const name = activity.$?.['android:name'];
    if (name === '.MainActivity' || name?.endsWith('.MainActivity')) {
      activity.$['android:showWhenLocked'] = 'true';
      activity.$['android:turnScreenOn'] = 'true';
    }
  }
  return androidManifest;
}

function ensurePermissions(androidManifest) {
  const required = [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.USE_FULL_SCREEN_INTENT',
    'android.permission.WAKE_LOCK',
    'android.permission.TURN_SCREEN_ON',
    'android.permission.DISABLE_KEYGUARD',
    'android.permission.VIBRATE',
  ];
  const manifest = androidManifest.manifest;
  if (!manifest['uses-permission']) manifest['uses-permission'] = [];
  const existing = new Set(
    manifest['uses-permission'].map((p) => p.$?.['android:name']),
  );
  for (const name of required) {
    if (!existing.has(name)) {
      manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
  }
  return androidManifest;
}

module.exports = function withWakeScreenAndroidActivity(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = setMainActivityWakeFlags(cfg.modResults);
    cfg.modResults = ensurePermissions(cfg.modResults);
    return cfg;
  });
};
