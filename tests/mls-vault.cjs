const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVault } = require('../frontend/desktop/mls-vault.cjs');
// Tests disk transaction/crypto behavior; this fake intentionally does not claim
// to test real Keychain/DPAPI integration, which requires native device QA.
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test-os-store', encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
function fixture(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ghostel-mls-vault-')); t.after(()=>fs.rmSync(directory,{recursive:true,force:true})); return { directory, vault:createVault(directory,safeStorage) }; }
const state = content => ({ version:1, device:{user_id:'alice',device_id:'phone'}, privateMessage:content });
test('desktop vault authenticates ciphertext and survives a new process instance',t=>{
  const {directory,vault} = fixture(t); assert.equal(vault.load('alice').state,null);
  const rev = vault.save('alice',null,state('private text'));
  assert.ok(!fs.readFileSync(path.join(directory,'alice.vault')).includes(Buffer.from('private text')));
  const reopened = createVault(directory,safeStorage).load('alice'); assert.equal(reopened.state.privateMessage,'private text'); assert.equal(reopened.revision,rev);
  const bytes = fs.readFileSync(path.join(directory,'alice.vault')); bytes[30] ^= 1; fs.writeFileSync(path.join(directory,'alice.vault'),bytes);
  assert.throws(()=>vault.load('alice'));
});
test('stale writer is rejected without overwriting the committed state',t=>{
  const {vault} = fixture(t); const rev = vault.save('alice',null,state('first'));
  vault.save('alice',rev,state('second'));
  assert.throws(()=>vault.save('alice',rev,state('stale')),/Concurrent/);
  assert.equal(vault.load('alice').state.privateMessage,'second');
});
test('lost OS-wrapped key never silently replaces an existing identity',t=>{
  const {directory,vault} = fixture(t); vault.save('alice',null,state('first'));
  fs.unlinkSync(path.join(directory,'alice.key'));
  assert.throws(()=>vault.load('alice'),/key missing/);
});
test('Linux plaintext fallback and path traversal are rejected',t=>{
  const {directory,vault} = fixture(t);
  assert.throws(()=>vault.load('../alice'),/Invalid MLS account/);
  const insecure=createVault(directory,{...safeStorage,getSelectedStorageBackend:()=> 'basic_text'});
  assert.throws(()=>insecure.save('alice',null,state('blocked')),/OS-protected/);
});
