const { URL } = require('node:url');
function stagingConfig(config, env = process.env) {
  if (env.APP_VARIANT !== 'staging') return config;
  if (env.EXPO_PUBLIC_APP_VARIANT !== 'staging') throw new Error('Staging requires EXPO_PUBLIC_APP_VARIANT=staging');
  const raw = env.EXPO_PUBLIC_BACKEND_URL;
  if (!raw) throw new Error('Staging requires an explicit EXPO_PUBLIC_BACKEND_URL');
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (['api.ghostel.app', 'app.ghostel.app', 'ghostel.app', 'panel-api.ghostel.app'].includes(host)) throw new Error('Staging must not use the production API');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host)))) throw new Error('Staging requires an HTTPS origin (HTTP allowed only on loopback)');
  const noPush = env.EXPO_STAGING_NO_PUSH === '1';
  if (!noPush && (!env.STAGING_GOOGLE_SERVICES_ANDROID || !env.STAGING_GOOGLE_SERVICES_IOS)) throw new Error('Supply separate staging Firebase files, or EXPO_STAGING_NO_PUSH=1 for MLS-only tests');
  const android = { ...config.android, package: 'app.ghostel.staging' };
  const ios = { ...config.ios, bundleIdentifier: 'app.ghostel.staging' };
  if (noPush) { delete android.googleServicesFile; delete ios.googleServicesFile; }
  else { android.googleServicesFile = env.STAGING_GOOGLE_SERVICES_ANDROID; ios.googleServicesFile = env.STAGING_GOOGLE_SERVICES_IOS; }
  return { ...config, name: 'Ghostel Staging', scheme: 'ghostel-staging', android, ios,
    extra: { ...config.extra, appVariant: 'staging', stagingBackendUrl: url.origin, stagingPushEnabled: !noPush },
    plugins: noPush ? config.plugins.filter(p => !['@react-native-firebase/app', '@react-native-firebase/messaging', './plugins/withFirebaseManifestFix'].includes(Array.isArray(p) ? p[0] : p)) : config.plugins,
  };
}
module.exports = { stagingConfig };
