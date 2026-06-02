/**
 * withCallKeepAndroid — Expo config plugin.
 *
 * Adds the Android Telecom / CallKeep wiring to AndroidManifest.xml so that
 * `react-native-callkeep` can:
 *   1. Register as a phone account with the OS Telecom service.
 *   2. Show the NATIVE incoming-call screen on the lockscreen.
 *   3. Run a foreground service while a call is active (mandatory on Android
 *      14+ for any FOREGROUND_SERVICE_PHONE_CALL use).
 *
 * Applied at `expo prebuild` / `eas build` time. Does not touch JS code.
 *
 * Required permissions (all declared here):
 *   - MANAGE_OWN_CALLS         — required for ConnectionService
 *   - READ_PHONE_STATE         — required for CallKeep to detect phone state
 *   - FOREGROUND_SERVICE       — runs the call as a foreground service
 *   - FOREGROUND_SERVICE_PHONE_CALL  — Android 14+ specific FGS type
 *   - BIND_TELECOM_CONNECTION_SERVICE — system-level (granted automatically when service binds)
 */
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const PERMISSIONS = [
  'android.permission.MANAGE_OWN_CALLS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_PHONE_CALL',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.CALL_PHONE',
];

function ensurePermissions(manifest) {
  if (!manifest.manifest['uses-permission'])
    manifest.manifest['uses-permission'] = [];
  const existing = new Set(
    manifest.manifest['uses-permission'].map((p) => p.$?.['android:name']),
  );
  for (const name of PERMISSIONS) {
    if (!existing.has(name)) {
      manifest.manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
  }
}

function ensureCallKeepServices(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  if (!app.service) app.service = [];

  const has = (className) =>
    app.service.some((s) => s.$?.['android:name'] === className);

  // VoiceConnectionService — Telecom ConnectionService implementation provided
  // by react-native-callkeep. Receives the native incoming-call UI events
  // from the OS Telecom stack and bridges them back to JS.
  if (!has('io.wazo.callkeep.VoiceConnectionService')) {
    app.service.push({
      $: {
        'android:name': 'io.wazo.callkeep.VoiceConnectionService',
        'android:label': 'Ghostel calls',
        'android:permission': 'android.permission.BIND_TELECOM_CONNECTION_SERVICE',
        'android:foregroundServiceType': 'phoneCall|microphone',
        'android:exported': 'true',
      },
      'intent-filter': [
        {
          action: [
            { $: { 'android:name': 'android.telecom.ConnectionService' } },
          ],
        },
      ],
    });
  }

  // Headless task service — declared in older callkeep docs but the actual
  // class is not always exported by the npm package. Skipping it here keeps
  // the manifest clean and avoids ClassNotFoundException at runtime when the
  // OS resolves declared services.
  // (FCM background message handling is done entirely in JS via
  // @react-native-firebase/messaging.setBackgroundMessageHandler — see
  // src/fcmBackground.ts.)
}

module.exports = function withCallKeepAndroid(config) {
  return withAndroidManifest(config, (cfg) => {
    ensurePermissions(cfg.modResults);
    ensureCallKeepServices(cfg.modResults);
    return cfg;
  });
};
