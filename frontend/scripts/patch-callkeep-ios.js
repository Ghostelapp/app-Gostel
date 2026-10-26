/** Keep CallKit in charge of session activation; route selection only changes the route. */
const fs = require('fs');
const path = require('path');
function patchCallKeepIos(source) {
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
// Configure category/mode before fulfilling the answer action, but let CallKit
// activate the session. Manual activation here races iOS's lock-screen audio
// ownership; WebRTC starts only after didActivateAudioSession arrives.
const configurationMarker = '    // Ghostel: CallKit alone activates the configured audio session.';
if (!source.includes(configurationMarker)) {
  const start = source.indexOf('- (void)configureAudioSession\n{');
  const end = source.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('CallKeep audio configuration changed; review the iOS patch');
  const method = source.slice(start, end);
  const manualActivation = '    [audioSession setActive:TRUE error:nil];';
  if (!method.includes(manualActivation)) throw new Error('CallKeep activation changed; review the iOS patch');
  source = source.slice(0, start) + method.replace(manualActivation, configurationMarker) + source.slice(end);
}
const ringbackMarker = '// Ghostel: ringback shares CallKit\'s session without changing its ownership.';
if (!source.includes(ringbackMarker)) {
  const ivar = '    NSMutableArray *_delayedEvents;';
  const module = 'RCT_EXPORT_MODULE()';
  if (!source.includes(ivar) || !source.includes(module)) throw new Error('CallKeep module structure changed');
  source = source.replace('#import <AVFoundation/AVAudioSession.h>', '#import <AVFoundation/AVAudioSession.h>\n#import <AVFoundation/AVAudioPlayer.h>');
  source = source.replace(ivar, ivar + '\n    AVAudioPlayer *_ghostelRingback;\n    NSString *_ghostelRingbackCallId;');
  source = source.replace(module, module + '\n\n' + fs.readFileSync(path.join(__dirname, 'callkeep-ringback.m.txt'), 'utf8'));
}
const endRingback = '    // Ghostel: stop the tone even when the JS bridge is suspended.\n    [self stopGhostelRingback:action.callUUID.UUIDString];';
if (!source.includes(endRingback)) {
  const endAction = '- (void)provider:(CXProvider *)provider performEndCallAction:(CXEndCallAction *)action\n{';
  if (!source.includes(endAction)) throw new Error('CallKeep end action changed');
  source = source.replace(endAction, endAction + '\n' + endRingback);
}
return source;
}

if (require.main === module) {
  const target = path.join(__dirname, '../node_modules/react-native-callkeep/ios/RNCallKeep/RNCallKeep.m');
  if (!fs.existsSync(target)) throw new Error('CallKeep iOS source is missing');
  fs.writeFileSync(target, patchCallKeepIos(fs.readFileSync(target, 'utf8')));
  console.log('[patch-callkeep-ios] CallKit audio ownership and routing patch applied');
}
module.exports = { patchCallKeepIos };
