const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real TS services against a deterministic native/storage boundary.
function harness(initialEvents = []) {
  const values = new Map();
  const events = new Map();
  const requests = [];
  const routes = [];
  const reports = [];
  const audio = [];
  const timers = [];
  const storage = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
  };
  const native = {
    setup: async () => {},
    addEventListener: (name, fn) => events.set(name, fn),
    getInitialEvents: async () => initialEvents,
    clearInitialEvents: () => {},
    reportEndCallWithUUID: (...args) => reports.push(args),
    displayIncomingCall: () => {},
    answerIncomingCall: id => events.get('answerCall')?.({ callUUID: id }),
    startCall: () => {},
    reportConnectingOutgoingCallWithUUID: () => {},
    reportConnectedOutgoingCallWithUUID: () => {},
    backToForeground: () => {},
  };
  const api = {
    get: async () => ({ data: { status: 'ringing' } }),
    post: async (url) => { requests.push(url); return { data: { status: 'answered', accepted: true } }; },
  };
  const appState = { currentState: 'background', addEventListener: () => ({ remove() {} }) };
  const modules = new Map();
  const mocks = {
    '@react-native-async-storage/async-storage': storage,
    'react-native': { Platform: { OS: 'ios' }, AppState: appState, DeviceEventEmitter: { emit() {}, addListener: () => ({ remove() {} }) } },
    'react-native-callkeep': { default: native },
    'expo-crypto': { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    './api': { api },
    './webrtcAudioSession': { activateWebRtcAudioSession: () => audio.push('activate'), deactivateWebRtcAudioSession: () => audio.push('deactivate') },
  };
  function load(name) {
    if (mocks[name]) return mocks[name];
    const filename = path.resolve(__dirname, '../src', name.replace(/^\.\//, '') + '.ts');
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(js, {
      module, exports: module.exports, require: load, console: { log() {}, warn() {} },
      setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    }, { filename });
    return module.exports;
  }
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  return { load, values, events, requests, routes, reports, audio, api, appState, settle, timers };
}
const id = '11111111-1111-4111-8111-111111111111';
const info = { callId: id, conversationId: 'chat', callerId: 'peer', callerName: 'Peer' };

test('terminal and expired persisted calls are removed without recursive reads', async () => {
  for (const state of [
    { callStatus: 'ENDED', lastSyncedAt: Date.now() },
    { callStatus: 'INCOMING_RINGING', lastSyncedAt: Date.now() - 180000 },
  ]) {
    const h = harness();
    h.values.set('ghostel_active_call_state_v1', JSON.stringify({ activeCallId: id, ...state }));
    assert.equal(await h.load('./callState').getActiveCallState(), null);
    assert.equal(h.values.has('ghostel_active_call_state_v1'), false);
  }
});

test('cleanup for an older call leaves a different active call intact', async () => {
  const h = harness(); const state = h.load('./callState');
  await state.saveActiveCallState({ activeCallId: 'new', callStatus: 'ACTIVE' });
  await state.clearActiveCallState('old');
  assert.equal((await state.getActiveCallState()).activeCallId, 'new');
});

test('duplicate push cannot downgrade an answered call to ringing', async () => {
  const h = harness(); const store = h.load('./incomingCallStore');
  const state = h.load('./callState');
  await store.markCallLocallyAccepted(id);
  await state.saveActiveCallState({ activeCallId: id, callStatus: 'CONNECTING' });
  assert.equal(await store.showIncomingCallFromPush({ call_id: id, caller_id: 'peer', conversation_id: 'chat' }), null);
  assert.equal((await state.getActiveCallState()).callStatus, 'CONNECTING');
});

test('CallKit audio activation never answers a ringing call', async () => {
  const h = harness(); const keep = h.load('./callkeep');
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep();
  h.events.get('didActivateAudioSession')(); await h.settle();
  assert.deepEqual(h.audio, ['activate']);
  assert.equal(h.requests.filter(url => url.endsWith('/accept')).length, 0);
});

test('background answer routes media without unlocking, duplicate answer signals once', async () => {
  const h = harness(); const keep = h.load('./callkeep');
  keep.bindCallKeepBridge({ router: { replace: href => h.routes.push(href) }, wsSend() {} });
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep();
  h.events.get('answerCall')({ callUUID: id });
  h.events.get('answerCall')({ callUUID: id });
  await h.settle();
  assert.equal(h.routes.length, 1);
  assert.equal(h.requests.filter(url => url.endsWith('/accept')).length, 1);
  assert.equal(h.audio.length, 0);
});

test('hangup immediately after answer and unlock is honored once', async () => {
  const h = harness(); const keep = h.load('./callkeep'); const actions = [];
  keep.subscribeToCallKeepActions(action => actions.push(action));
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep();
  h.events.get('answerCall')({ callUUID: id }); await h.settle();
  h.appState.currentState = 'active';
  h.events.get('endCall')({ callUUID: id });
  h.events.get('endCall')({ callUUID: id }); await h.settle();
  assert.equal(h.requests.filter(url => url.endsWith('/end')).length, 1);
  assert.equal(h.requests.filter(url => url.endsWith('/decline')).length, 0);
  assert.equal(h.values.has('ghostel_pending_answered_call_v1'), false);
  assert.ok(actions.some(action => action.action === 'end'));
});

test('remote termination reports an ended call, never a local reject transaction', async () => {
  const h = harness(); const keep = h.load('./callkeep');
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep();
  keep.endIncomingCallNative(id); await h.settle();
  assert.deepEqual(h.reports, [[id, 2]]);
  assert.equal(h.requests.length, 0);
});

test('cold-start answer/end events replay in order and cannot reopen ended call', async () => {
  const h = harness([
    { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: id } },
    { name: 'RNCallKeepPerformEndCallAction', data: { callUUID: id } },
    { name: 'RNCallKeepPerformAnswerCallAction', data: { callUUID: id } },
  ]);
  const keep = h.load('./callkeep');
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep(); await h.settle();
  assert.equal(h.requests.filter(url => url.endsWith('/accept')).length, 1);
  assert.equal(h.requests.filter(url => url.endsWith('/end')).length, 1);
  assert.equal(h.values.has('ghostel_pending_answered_call_v1'), false);
});

test('cold-start audio activation is replayed even without a call UUID', async () => {
  const h = harness([{ name: 'RNCallKeepDidActivateAudioSession', data: null }]);
  await h.load('./callkeep').setupCallKeep();
  assert.deepEqual(h.audio, ['activate']);
});

test('system mute reaches the active media consumer', async () => {
  const h = harness(); const keep = h.load('./callkeep'); const received = [];
  keep.subscribeToCallKeepActions(event => received.push(event));
  await keep.setupCallKeep();
  h.events.get('didPerformSetMutedCallAction')({ callUUID: id, muted: true });
  assert.equal(received[0].action, 'mute');
  assert.equal(received[0].muted, true);
});

function screenCallback(name, scope) {
  const source = fs.readFileSync(path.resolve(__dirname, '../app/call/[id].tsx'), 'utf8');
  const tree = ts.createSourceFile('call.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) callback = node.initializer.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(callback, `Missing screen callback ${name}`);
  const script = ts.transpileModule(`globalThis.handler = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const context = vm.createContext(scope);
  vm.runInContext(script, context);
  return context.handler;
}

test('hanging diagnostics and HTTP cannot delay microphone cleanup on hangup', async () => {
  const order = [];
  const handler = screenCallback('endCall', {
    id, conversationIdParam: 'chat', endedRef: { current: false }, peerIdRef: { current: 'peer' },
    wsSendRef: { current: () => order.push('signal') },
    reportCallDiag: () => new Promise(() => {}),
    api: { post: () => new Promise(() => {}) },
    cleanup: async () => order.push('microphone-stopped'),
    cacheTerminatedCallId: async () => {}, clearActiveCallState: async () => {}, clearPendingAnsweredCall: async () => {},
    setStatus() {}, setErrMsg() {}, endIncomingCallNative() {}, returnToChat() {}, setTimeout() {},
  });
  await handler('Hung up');
  assert.equal(order[0], 'microphone-stopped');
  assert.deepEqual(order, ['microphone-stopped', 'signal']);
});

test('audio setup waits for a real native activation and survives interruption', async () => {
  let activates = 0;
  let deactivates = 0;
  const h = harness();
  // Load this module directly so the test exercises the bridge instead of its callkeep mock.
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/webrtcAudioSession.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, setTimeout, clearTimeout,
    require: name => name === 'react-native' ? { Platform: { OS: 'ios' } } : {
      getWebRTC: () => ({ RTCAudioSession: {
        audioSessionDidActivate: () => activates++, audioSessionDidDeactivate: () => deactivates++,
      } }),
    },
  });
  const audio = module.exports;
  let ready = false;
  const waiting = audio.waitForWebRtcAudioSession(500).then(value => { ready = value; });
  await h.settle(); assert.equal(ready, false);
  audio.activateWebRtcAudioSession(); audio.activateWebRtcAudioSession();
  await waiting; assert.equal(ready, true); assert.equal(activates, 1);
  audio.deactivateWebRtcAudioSession();
  assert.equal(await audio.waitForWebRtcAudioSession(5), false);
  assert.equal(deactivates, 1);
});

test('a delayed answer-route retry cannot replace an already mounted call screen', async () => {
  const h = harness(); const keep = h.load('./callkeep');
  const router = { replace: href => h.routes.push(href) };
  keep.bindCallKeepBridge({ router, wsSend() {} });
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep();
  h.events.get('answerCall')({ callUUID: id }); await h.settle();
  assert.equal(h.routes.length, 1);
  let completeLookup;
  h.api.get = () => new Promise(resolve => { completeLookup = resolve; });
  keep.bindCallKeepBridge({ router, wsSend() {} }); await h.settle();
  assert.equal(typeof completeLookup, 'function');
  const unmount = keep.registerMountedCallScreen(id);
  completeLookup({ data: { status: 'answered' } }); await h.settle();
  assert.equal(h.routes.length, 1);
  unmount();
});

test('an in-flight route lookup cannot reopen a call terminated while it was pending', async () => {
  const h = harness(); const keep = h.load('./callkeep');
  const router = { replace: href => h.routes.push(href) };
  keep.bindCallKeepBridge({ router, wsSend() {} });
  await keep.hydrateIncomingCallNative(info); await keep.setupCallKeep();
  h.events.get('answerCall')({ callUUID: id }); await h.settle();
  let completeLookup;
  h.api.get = () => new Promise(resolve => { completeLookup = resolve; });
  keep.bindCallKeepBridge({ router, wsSend() {} }); await h.settle();
  await h.load('./callState').cacheTerminatedCallId(id, 'ENDED');
  completeLookup({ data: { status: 'answered' } }); await h.settle();
  assert.equal(h.routes.length, 1);
});

test('stopping iOS ringback leaves the CallKit audio session active', () => {
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/callRingback.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  for (const platform of ['ios', 'android']) {
    let audioActive = true; let pauses = 0; let nativeStops = 0;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: name => {
      if (name === 'react') return { useCallback: fn => fn, useRef: value => ({ current: value }), useMemo: fn => fn(), useEffect() {} };
      if (name === './iosRingback') return { createIosRingback: () => ({ start: async () => {}, stop: () => { nativeStops++; } }) };
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo-audio') return { useAudioPlayer: (_, options) => ({
        play() {}, seekTo() {}, pause() { pauses++; if (!options?.keepAudioSessionActive) audioActive = false; },
      }) };
      throw Error(name);
    } });
    const ringback = module.exports.useCallRingback('ringtone', true, 'call');
    ringback.startRingback(); ringback.stopRingback(); ringback.stopRingback();
    assert.equal(pauses, platform === 'ios' ? 0 : 1);
    assert.equal(nativeStops, platform === 'ios' ? 2 : 0);
    assert.equal(audioActive, platform === 'ios');
  }
});

test('cold-start auth must finish before mounting the one-shot call media owner', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../app/call/[id].tsx'), 'utf8');
  const tree = ts.createSourceFile('call.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'CallScreen');
  const script = ts.transpileModule(declaration.getText(tree).replace('export default ', '') + '\nglobalThis.render = CallScreen;', {
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText;
  let loading = true;
  const context = vm.createContext({ useAuth: () => ({ loading }), React: { createElement: (type) => ({ type }) },
    SafeAreaView: 'safe', ActivityIndicator: 'loading', AuthenticatedCallScreen: 'media-owner', styles: { safe: {} } });
  vm.runInContext(script, context);
  assert.equal(context.render().type, 'safe');
  loading = false;
  assert.equal(context.render().type, 'media-owner');
});

test('native CallKit patch configures audio without manually activating it and is idempotent', () => {
  const { patchCallKeepIos } = require('../scripts/patch-callkeep-ios');
  const native = fs.readFileSync(path.resolve(__dirname, '../node_modules/react-native-callkeep/ios/RNCallKeep/RNCallKeep.m'), 'utf8');
  const unpatched = native.replace('    // Ghostel: CallKit alone activates the configured audio session.', '    [audioSession setActive:TRUE error:nil];');
  const patched = patchCallKeepIos(unpatched);
  const configuration = patched.slice(patched.indexOf('- (void)configureAudioSession\n{')).split('\n}\n')[0];
  assert.ok(configuration.includes('setCategory:AVAudioSessionCategoryPlayAndRecord'));
  assert.ok(configuration.includes('setMode:mode'));
  assert.equal(configuration.includes('setActive:'), false);
  assert.ok(patched.includes('sendEventWithNameWrapper:RNCallKeepDidActivateAudioSession'));
  assert.equal(patchCallKeepIos(patched), patched);
});

test('existing iOS keys migrate accessibility without changing key bytes or biometric access', () => {
  if (process.platform !== 'darwin') return;
  const { patchSecureStoreIos } = require('../scripts/patch-secure-store-ios');
  const native = fs.readFileSync(path.resolve(__dirname, '../node_modules/expo-secure-store/ios/SecureStoreModule.swift'), 'utf8');
  const patched = patchSecureStoreIos(native);
  assert.equal(patchSecureStoreIos(patched), patched);
  const start = patched.indexOf('  private func update(');
  const end = patched.indexOf('  private func searchKeyChain(', start);
  assert.ok(start >= 0 && end > start);
  const fixture = fs.readFileSync(path.join(__dirname, 'secure-store-migration.swift'), 'utf8');
  const run = require('node:child_process').spawnSync('swift', ['-'], {
    input: fixture.replace('  // UPDATE_METHOD', patched.slice(start, end)), encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Existing key migrated/);
});

test('native ringback cancels delayed loads after answer and can play on the next call', async () => {
  const requests = []; const starts = []; const stops = [];
  const module = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/iosRingback.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, console, require: name => {
    if (name === 'expo-asset') return { Asset: { fromModule: () => ({ downloadAsync: () => new Promise(resolve => requests.push(resolve)) }) } };
    if (name === 'react-native') return { NativeModules: { RNCallKeep: {
      startGhostelRingback: async (...args) => starts.push(args), stopGhostelRingback: id => stops.push(id),
    } } };
    throw Error(name);
  } });
  const tone = module.exports.createIosRingback('asset', 'first');
  const pending = tone.start(); await tone.start();
  assert.equal(requests.length, 1);
  tone.stop(); requests.shift()({ localUri: 'file:///tone.mp3' }); await pending;
  assert.equal(starts.length, 0, 'answer must cancel an unresolved asset load');
  const second = module.exports.createIosRingback('asset', 'second');
  const next = second.start(); requests.shift()({ localUri: 'file:///tone.mp3' }); await next;
  assert.deepEqual(starts, [['second', 'file:///tone.mp3']]);
  tone.stop(); assert.equal(stops.at(-1), 'first', 'old cleanup is scoped to the old call');
  second.stop(); assert.equal(stops.at(-1), 'second');
});

test('native ringback never changes CallKit session activation, category or mode', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/callkeep-ringback.m.txt'), 'utf8');
  assert.doesNotMatch(source, /setActive|setCategory|setMode/);
  assert.match(source, /AVAudioPlayer alloc/);
  assert.match(source, /numberOfLoops = -1/);
  assert.match(source, /isEqualToString:callId.lowercaseString/);
  assert.match(source, /url.isFileURL/);
});
