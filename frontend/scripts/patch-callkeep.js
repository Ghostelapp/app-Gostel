/**
 * Keeps react-native-callkeep compatible with React Native's new
 * architecture/TurboModule parser.
 *
 * RNCallKeepModule.java exports overloaded @ReactMethod methods for
 * displayIncomingCall and startCall. TurboModules reject duplicate exported
 * names at runtime, which crashes the app on startup. The JavaScript wrapper
 * already calls the four-argument Android methods, so the three-argument
 * overloads can safely remain as native helpers without @ReactMethod.
 *
 * Idempotent: safe to run after every dependency install.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-callkeep',
  'android',
  'src',
  'main',
  'java',
  'io',
  'wazo',
  'callkeep',
  'RNCallKeepModule.java',
);

if (!fs.existsSync(target)) {
  console.log('[patch-callkeep] Nothing to patch (file not found)');
  process.exit(0);
}

const original = fs.readFileSync(target, 'utf8');
let patched = original;

for (const methodName of ['displayIncomingCall', 'startCall']) {
  const pattern = new RegExp(
    `    @ReactMethod\\r?\\n    public void ${methodName}\\(String uuid, String number, String callerName\\) \\{`,
    'g',
  );
  patched = patched.replace(
    pattern,
    `    public void ${methodName}(String uuid, String number, String callerName) {`,
  );
}

if (patched !== original) {
  fs.writeFileSync(target, patched);
  console.log('[patch-callkeep] Removed duplicate @ReactMethod overloads');
} else {
  console.log('[patch-callkeep] Nothing to patch (already clean)');
}
