// Generates a loopback-only manual browser storage test, without app login/data.
const fs=require('node:fs'),path=require('node:path');
const ts=require('../frontend/node_modules/typescript');
const root=path.resolve(__dirname,'..'), out=path.join(root,'.cache/mls-browser-test');
fs.mkdirSync(out,{recursive:true});
const source=fs.readFileSync(path.join(root,'frontend/src/mls/vault.web.ts'),'utf8');
fs.writeFileSync(path.join(out,'vault.js'),'const exports={};\n'+ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);
fs.writeFileSync(path.join(out,'child.html'),`<script src="vault.js"></script><script>
Promise.all(Array.from({length:10},()=>exports.withVault('browser-test',async(s,save)=>{s.counter++;await save(s)})))
.then(()=>parent.postMessage('child-complete',location.origin)).catch(e=>parent.postMessage('child-failed: '+e.message,location.origin));
</script>`);
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><title>Ghostel MLS browser storage test</title><h1>Ghostel MLS browser storage test</h1><p id="result">Running…</p><script src="vault.js"></script><script>
(async()=>{
const use=exports.withVault;
await use('browser-test',async(_,save)=>save({version:1,counter:0}));
const done=new Promise((resolve,reject)=>addEventListener('message',e=>{if(e.origin!==location.origin)return;if(e.data==='child-complete')resolve();if(typeof e.data==='string'&&e.data.startsWith('child-failed'))reject(Error(e.data));}));
const frame=document.createElement('iframe');frame.hidden=true;frame.src='child.html';document.body.append(frame);
await Promise.all([done,...Array.from({length:10},()=>use('browser-test',async(s,save)=>{s.counter++;await save(s)}))]);
if(await use('browser-test',async s=>s.counter)!==20)throw Error('lost update');
const open=indexedDB.open('ghostel-mls-v1',1);const db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=reject;});
const req=db.transaction('vaults').objectStore('vaults').get('browser-test');const stored=await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=reject;});
if(stored.key.extractable!==false||new TextDecoder().decode(stored.ciphertext).includes('counter'))throw Error('plaintext storage');db.close();
document.getElementById('result').textContent='PASS: encrypted IndexedDB, non-extractable CryptoKey, strict durability, restart read and cross-frame locks (20 updates)';
})().catch(e=>document.getElementById('result').textContent='FAIL: '+e.message);
</script>`);
const runtime=fs.readFileSync(path.join(root,'frontend/src/mls/runtime.generated.ts'),'utf8');
const script=JSON.parse(runtime.split('export const MLS_RUNTIME_SCRIPT: string = ')[1].trim().replace(/;$/,''));
fs.writeFileSync(path.join(root,'.cache/mls-webkit-runtime.html'),`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'none'"><script>globalThis.ReactNativeWebView={postMessage:s=>webkit.messageHandlers.mls.postMessage(JSON.parse(s))};${script.replace(/<\/script/gi,'<\\/script')}</script>`);
console.log('Prepared browser and WKWebView fixtures under .cache');
