const fs = require('node:fs');
const path = require('node:path');

function patchSecureStoreIos(source) {
  const marker = '// Ghostel: migrate accessibility on existing unauthenticated items.';
  if (source.includes(marker)) return source;
  const old = '    let updateDictionary = [kSecValueData as String: valueData]';
  if (!source.includes(old)) throw new Error('SecureStore update implementation changed');
  return source.replace(old, `    var updateDictionary: [String: Any] = [kSecValueData as String: valueData]
    ${marker}
    if !options.requireAuthentication {
      updateDictionary[kSecAttrAccessible as String] = attributeWith(options: options)
    }`);
}

if (require.main === module) {
  const file = path.resolve(__dirname, '../node_modules/expo-secure-store/ios/SecureStoreModule.swift');
  fs.writeFileSync(file, patchSecureStoreIos(fs.readFileSync(file, 'utf8')));
  console.log('[patch-secure-store-ios] Existing key accessibility migration enabled');
}
module.exports = { patchSecureStoreIos };
