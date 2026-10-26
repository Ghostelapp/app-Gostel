// Offline tests execute actual functions extracted from the application sources.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../frontend/node_modules/typescript');
const nacl = require('../frontend/node_modules/tweetnacl');
const crypto = require('node:crypto');
const b64 = x => Buffer.from(x).toString('base64');

function e2ee() {
  const storage = new Map();
  const source = fs.readFileSync(path.join(__dirname, '../frontend/src/e2ee.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mocks = {
    '@react-native-async-storage/async-storage': { getItem: async k => storage.get(k) || null, setItem: async (k,v) => storage.set(k,v) },
    'expo-crypto': { getRandomBytesAsync: async n => new Uint8Array(crypto.randomBytes(n)) },
    'expo-secure-store': {}, 'react-native': { Platform: { OS: 'web' } },
    './mls/client': { hasMLSApproval: async () => false },
    'tweetnacl': nacl, './api': { api: { post: async () => ({}) } },
  };
  const context = { exports: {}, require: name => { assert.ok(name in mocks); return mocks[name]; }, TextEncoder, TextDecoder, Uint8Array };
  vm.runInNewContext(compiled, context);
  return { api: context.exports, storage };
}

test('receiver rejects attacker key under a pinned sender ID', async () => {
  const {api, storage} = e2ee();
  const bob = await api.ensureE2EEIdentity('bob');
  const alice = nacl.box.keyPair();
  const mallory = nacl.box.keyPair();
  storage.set('ghostel_e2ee_verified_keys_v3.bob', JSON.stringify({alice: b64(alice.publicKey)}));
  const nonce = nacl.randomBytes(24);
  const forged = {sender_id:'alice',content:'[encrypted message]',encrypted:true,e2ee:{version:1,algorithm:'nacl-box-v1',sender_public_key:b64(mallory.publicKey),recipients:{bob:{nonce:b64(nonce),ciphertext:b64(nacl.box(new TextEncoder().encode('forged'),nonce,Buffer.from(bob.publicKey,'base64'),mallory.secretKey))}}}};
  const result = await api.decryptMessageForUser(forged, 'bob');
  assert.equal(result.e2ee_decrypted, false);
  assert.equal(result.content, api.E2EE_UNAVAILABLE_TEXT);
});

test('CONFIRMED OPEN: old ciphertext decrypts with current static key and can be relabelled/replayed', async () => {
  const {api} = e2ee();
  const alice = await api.ensureE2EEIdentity('alice');
  const bob = await api.ensureE2EEIdentity('bob');
  const conv = {type:'direct',members:[{id:'alice',e2ee_public_key:alice.publicKey},{id:'bob',e2ee_public_key:bob.publicKey}]};
  await api.trustConversationKeys(conv,'alice');
  await api.trustConversationKeys(conv,'bob');
  const message = await api.encryptTextForConversation('old secret',conv,'alice');
  const replay = {...message,sender_id:'alice',conversation_id:'different',id:'new'};
  assert.equal((await api.decryptMessageForUser(replay,'bob')).content,'old secret');
  assert.equal((await api.ensureE2EEIdentity('alice')).secretKey, alice.secretKey);
});

test('static fallback refuses parent traversal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'),'utf8');
  const fn = source.slice(source.indexOf('function findMatchingHtmlFile'), source.indexOf('// Serve static assets'));
  const context = {path,DIST_DIR:'/app/dist',fs:{existsSync:()=>true,statSync:()=>({isFile:()=>true})}};
  vm.runInNewContext(fn, context);
  assert.equal(context.findMatchingHtmlFile('/../backend/server.py'), null);
  assert.equal(context.findMatchingHtmlFile('/../../etc/passwd'), null);
  assert.equal(context.findMatchingHtmlFile('/index.html'), '/app/dist/index.html');
});

test('desktop opens only http(s) external URLs', async () => {
  const source = fs.readFileSync(path.join(__dirname,'../frontend/desktop/main.cjs'),'utf8');
  const fn = source.slice(source.indexOf('function openExternalWebUrl'), source.indexOf('function createWindow'));
  const opened=[];
  const context={URL,shell:{openExternal:async url=>opened.push(url)},log:()=>{}};
  vm.runInNewContext(fn,context);
  for(const url of ['file:///etc/passwd','javascript:alert(1)','custom:launch','invalid']) context.openExternalWebUrl(url);
  assert.deepEqual(opened,[]);
  context.openExternalWebUrl('https://example.test/');
  assert.deepEqual(opened,['https://example.test/']);
});

test('pinned legitimate sender decrypts text and attachment; changed pin rejects both', async () => {
  const {api, storage} = e2ee();
  const alice = await api.ensureE2EEIdentity('alice');
  const bob = await api.ensureE2EEIdentity('bob');
  const conv = {type:'direct',members:[{id:'alice',e2ee_public_key:alice.publicKey},{id:'bob',e2ee_public_key:bob.publicKey}]};
  await api.trustConversationKeys(conv,'alice');
  const text = await api.encryptTextForConversation('file caption',conv,'alice');
  const file = await api.encryptAttachmentForConversation(b64(Buffer.from('private file')),'text/plain',conv,'alice');
  const message = {...text,sender_id:'alice'};
  storage.set('ghostel_e2ee_verified_keys_v3.bob',JSON.stringify({alice:alice.publicKey}));
  assert.equal((await api.decryptMessageForUser(message,'bob')).content,'file caption');
  assert.equal((await api.decryptAttachmentForUser(file.data,file.e2ee_attachment,message,'bob')).data,b64(Buffer.from('private file')));
  storage.set('ghostel_e2ee_verified_keys_v3.bob',JSON.stringify({alice:b64(nacl.box.keyPair().publicKey)}));
  assert.equal((await api.decryptMessageForUser(message,'bob')).e2ee_decrypted,false);
  assert.equal(await api.decryptAttachmentForUser(file.data,file.e2ee_attachment,message,'bob'),null);
});

test('plaintext downgrade never renders server content, even as a system event', async () => {
  const {api} = e2ee();
  for (const kind of ['text','image','voice','file','system','call',undefined]) {
    for (const encrypted of [true,false,undefined]) {
      const result = await api.decryptMessageForUser({sender_id:'alice',kind,encrypted,content:'untrusted plaintext'},'bob');
      assert.notEqual(result.content,'untrusted plaintext');
      assert.equal(result.e2ee_decrypted,false);
    }
  }
  const result = await api.decryptMessageForUser({sender_id:'system',kind:'text',content:'phishing link'},'bob');
  assert.equal(result.content,api.SERVER_EVENT_TEXT);
});

test('attachment without encryption metadata is rejected', async () => {
  const {api} = e2ee();
  assert.equal(await api.decryptAttachmentForUser(b64(Buffer.from('plaintext')),null,{sender_id:'alice',content:''},'bob'),null);
});

test('new contacts and legacy TOFU pins require explicit verification', async () => {
  const {api,storage} = e2ee();
  const alice = await api.ensureE2EEIdentity('alice');
  const bob = await api.ensureE2EEIdentity('bob');
  const conv = {type:'direct',members:[{id:'alice',e2ee_public_key:alice.publicKey},{id:'bob',e2ee_public_key:bob.publicKey}]};
  storage.set('ghostel_e2ee_trusted_keys_v2.alice',JSON.stringify({bob:bob.publicKey}));
  assert.equal((await api.syncConversationKeyTrust(conv,'alice')).trusted,false);
  assert.equal(await api.encryptTextForConversation('secret',conv,'alice'),null);
  assert.equal(await api.encryptAttachmentForConversation('YQ==','text/plain',conv,'alice'),null);
  assert.equal(storage.has('ghostel_e2ee_verified_keys_v3.alice'),false);
  await api.trustConversationKeys(conv,'alice');
  assert.equal((await api.syncConversationKeyTrust(conv,'alice')).trusted,true);
  const message = {...await api.encryptTextForConversation('secret',conv,'alice'),sender_id:'alice'};
  assert.equal((await api.decryptMessageForUser(message,'bob')).e2ee_decrypted,false);
  await api.trustConversationKeys(conv,'bob');
  assert.equal((await api.decryptMessageForUser(message,'bob')).content,'secret');
});
