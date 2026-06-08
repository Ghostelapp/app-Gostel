/**
 * withWakeScreenAndroidActivity — Expo config plugin.
 *
 * Keeps lock-screen wake behavior scoped to verified incoming-call intents.
 * MainActivity applies the flags at runtime instead of exposing them for
 * every launcher or deep-link intent.
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
      delete activity.$['android:showWhenLocked'];
      delete activity.$['android:turnScreenOn'];
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
