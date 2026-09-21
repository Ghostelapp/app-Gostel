/** Keep CallKit in charge of session activation; route selection only changes the route. */
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '../node_modules/react-native-callkeep/ios/RNCallKeep/RNCallKeep.m');
if (!fs.existsSync(target)) throw new Error('CallKeep iOS source is missing');
let source = fs.readFileSync(target, 'utf8');
const marker = '// Ghostel: release speaker override before selecting an input.';
if (!source.includes(marker)) {
  const original = 'BOOL isSetted = [myAudioSession setPreferredInput:(AVAudioSessionPortDescription *)port error:&err];';
  if (!source.includes(original)) throw new Error('CallKeep route selection changed; review the iOS patch');
  source = source.replace(original, `${marker}\n                [myAudioSession overrideOutputAudioPort:AVAudioSessionPortOverrideNone error:&err];\n                ${original}`);
}
const activation = `    BOOL isCategoryActivated = [myAudioSession setActive:YES error:&err];
    if (!isCategoryActivated)
    {
        NSLog(@"[RNCallKeep][getAudioInputs] setActive failed");
        [NSException raise:@"setActive failed" format:@"error: %@", err];
    }`;
const replacement = '    // Ghostel: enumerating routes must not activate the CallKit audio session.';
if (!source.includes(replacement)) {
  if (!source.includes(activation)) throw new Error('CallKeep audio activation changed; review the iOS patch');
  source = source.replace(activation, replacement);
}
fs.writeFileSync(target, source);
console.log('[patch-callkeep-ios] CallKit audio routing patch applied');
