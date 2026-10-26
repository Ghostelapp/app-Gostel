const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const ts=require('../frontend/node_modules/typescript');
const nacl=require('../frontend/node_modules/tweetnacl');
function harness(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ghostel-mls-native-'));
  const db=new DatabaseSync(path.join(dir,'vault.db'));
  const secure=new Map(); const fault={beforeAnchor:false,afterAnchor:false};
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const mocks={
    'expo-sqlite':{openDatabaseAsync:async()=>({execAsync:async sql=>db.exec(sql),getFirstAsync:async(sql,...args)=>db.prepare(sql).get(...args),runAsync:async(sql,...args)=>db.prepare(sql).run(...args)})},
    'expo-secure-store':{WHEN_UNLOCKED_THIS_DEVICE_ONLY:1,getItemAsync:async key=>secure.get(key)||null,setItemAsync:async(key,value)=>{if(fault.beforeAnchor)throw new Error('anchor before commit');secure.set(key,value);if(fault.afterAnchor)throw new Error('anchor reply lost');}},
    'expo-crypto':{getRandomBytesAsync:async n=>new Uint8Array(crypto.randomBytes(n)),CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(algorithm,value)=>crypto.createHash(algorithm).update(value).digest('hex')},
    'tweetnacl':nacl,
  };
  function fresh() {
    const cache={...mocks};
    const load=name=>{
      if(cache[name])return cache[name];
      const file=name==='./encoding'?'encoding.ts':'vault.ts';
      const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../frontend/src/mls',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
      const scope={exports:{},require:load,Uint8Array,JSON,Map,Error,encodeURIComponent,decodeURIComponent,escape,unescape};vm.runInNewContext(code,scope);return cache[name]=scope.exports;
    };return load('./vault').withVault;
  }
  return {fresh,db,secure,fault};
}
const value=n=>({version:1,device:{user_id:'alice',device_id:'test-device'},counter:n});
test('native vault commits encrypted SQLite state through its SecureStore anchor',async t=>{
  const h=harness(t), use=h.fresh();
  await use('alice',async(_,save)=>save(value(1)));
  assert.equal(await h.fresh()('alice',async state=>state.counter),1);
  const row=h.db.prepare('SELECT envelope FROM slots').get();assert.ok(!row.envelope.includes('counter'));
});
test('crash before secure anchor keeps previous state; crash after anchor recovers committed outbox',async t=>{
  const h=harness(t);await h.fresh()('alice',async(_,save)=>save(value(1)));
  h.fault.beforeAnchor=true;await assert.rejects(h.fresh()('alice',async(_,save)=>save(value(2))),/before commit/);h.fault.beforeAnchor=false;
  assert.equal(await h.fresh()('alice',async state=>state.counter),1);
  h.fault.afterAnchor=true;await assert.rejects(h.fresh()('alice',async(_,save)=>save(value(3))),/reply lost/);h.fault.afterAnchor=false;
  assert.equal(await h.fresh()('alice',async state=>state.counter),3);
});
test('restored old SQLite slot is rejected against the newer secure anchor',async t=>{
  const h=harness(t);await h.fresh()('alice',async(_,save)=>save(value(1)));
  const old=h.db.prepare('SELECT envelope FROM slots').get().envelope;
  await h.fresh()('alice',async(_,save)=>save(value(2)));
  const anchor=JSON.parse(h.secure.get('ghostel.mls.v1.alice'));
  h.db.prepare('UPDATE slots SET envelope=? WHERE name=?').run(old,`ghostel.mls.v1.alice.${anchor.slot}`);
  await assert.rejects(h.fresh()('alice',async state=>state),/rolled back/);
});
test('parallel native requests serialize without lost updates',async t=>{
  const h=harness(t),use=h.fresh();await use('alice',async(_,save)=>save(value(0)));
  await Promise.all(Array.from({length:20},()=>use('alice',async(state,save)=>{state.counter++;await save(state);} )));
  assert.equal(await use('alice',async state=>state.counter),20);
});
test('missing secure anchor cannot silently create a new identity over existing state',async t=>{
  const h=harness(t);await h.fresh()('alice',async(_,save)=>save(value(1)));h.secure.clear();
  await assert.rejects(h.fresh()('alice',async(_,save)=>save(value(2))),/key is missing/);
});
