const {
  withAppDelegate,
  withDangerousMod,
  withXcodeProject,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const BRIDGING_HEADER = 'GhostelVoip-Bridging-Header.h';
const PLUGIN_MARKER = '// Ghostel PushKit delegate';

const BRIDGING_HEADER_CONTENT = `#import "RNVoipPushNotificationManager.h"
#import <RNCallKeep/RNCallKeep.h>
`;

const VOIP_EXTENSION = `

${PLUGIN_MARKER}
extension AppDelegate: PKPushRegistryDelegate {
  public func pushRegistry(
    _ registry: PKPushRegistry,
    didUpdate pushCredentials: PKPushCredentials,
    for type: PKPushType
  ) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didInvalidatePushTokenFor type: PKPushType
  ) {}

  public func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    let data = payload.dictionaryPayload
    guard
      let callId = (data["call_id"] as? String) ?? (data["uuid"] as? String),
      UUID(uuidString: callId) != nil
    else {
      completion()
      return
    }

    let callerId = data["caller_id"] as? String ?? "ghostel"
    let callerName = data["caller_name"] as? String ?? "ghostel.app caller"

    // Cache the payload for the JS bridge, then report CallKit immediately.
    // iOS 13+ terminates apps that receive a VoIP push without doing this.
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)
    RNCallKeep.reportNewIncomingCall(
      callId,
      handle: callerId,
      handleType: "generic",
      hasVideo: false,
      localizedCallerName: callerName,
      supportsHolding: false,
      supportsDTMF: false,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: data,
      withCompletionHandler: completion
    )
  }
}
`;

function insertAfterImports(source, importLine) {
  if (source.includes(importLine)) return source;
  const matches = [...source.matchAll(/^import\s+\w+$/gm)];
  if (!matches.length) return `${importLine}\n${source}`;
  const last = matches[matches.length - 1];
  const offset = last.index + last[0].length;
  return `${source.slice(0, offset)}\n${importLine}${source.slice(offset)}`;
}

function patchAppDelegate(source) {
  let output = insertAfterImports(source, 'import PushKit');
  if (!output.includes('RNVoipPushNotificationManager.voipRegistration()')) {
    const launchMethod = /(func\s+application\([^)]*didFinishLaunchingWithOptions[^)]*\)[^{]*\{\s*\n)/;
    if (!launchMethod.test(output)) {
      throw new Error('withIosVoipPush: didFinishLaunchingWithOptions was not found');
    }
    output = output.replace(
      launchMethod,
      `$1    RNCallKeep.setup([\n` +
        `      "appName": "ghostel.app",\n` +
        `      "supportsVideo": false,\n` +
        `      "includesCallsInRecents": false,\n` +
        `      "maximumCallGroups": 1,\n` +
        `      "maximumCallsPerCallGroup": 1,\n` +
        `      "ringtoneSound": "Ringtone.caf",\n` +
        `      "audioSession": [\n` +
        `        "categoryOptions": 4,\n` +
        `        "mode": "AVAudioSessionModeVoiceChat"\n` +
        `      ]\n` +
        `    ])\n` +
        `    RNVoipPushNotificationManager.voipRegistration()\n`,
    );
  }
  if (!output.includes(PLUGIN_MARKER)) {
    output = output.trimEnd() + VOIP_EXTENSION;
  }
  return output;
}

function withVoipAppDelegate(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(`withIosVoipPush: expected Swift AppDelegate, got ${cfg.modResults.language}`);
    }
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents);
    return cfg;
  });
}

function withVoipBridgingHeader(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { platformProjectRoot, projectName } = cfg.modRequest;
      if (!projectName) throw new Error('withIosVoipPush: missing iOS project name');
      const targetDirectory = path.join(platformProjectRoot, projectName);
      fs.writeFileSync(
        path.join(targetDirectory, BRIDGING_HEADER),
        BRIDGING_HEADER_CONTENT,
        'utf8',
      );
      return cfg;
    },
  ]);
}

function withVoipBuildSettings(config) {
  return withXcodeProject(config, (cfg) => {
    const { projectName } = cfg.modRequest;
    if (!projectName) throw new Error('withIosVoipPush: missing project name for Xcode');
    const headerPath = `\"${projectName}/${BRIDGING_HEADER}\"`;
    const configurations = cfg.modResults.pbxXCBuildConfigurationSection();
    for (const value of Object.values(configurations)) {
      if (value?.buildSettings?.PRODUCT_NAME) {
        value.buildSettings.SWIFT_OBJC_BRIDGING_HEADER = headerPath;
      }
    }
    return cfg;
  });
}

module.exports = function withIosVoipPush(config) {
  config = withVoipAppDelegate(config);
  config = withVoipBridgingHeader(config);
  config = withVoipBuildSettings(config);
  return config;
};

module.exports.patchAppDelegate = patchAppDelegate;
