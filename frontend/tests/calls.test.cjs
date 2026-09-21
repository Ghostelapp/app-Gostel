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
