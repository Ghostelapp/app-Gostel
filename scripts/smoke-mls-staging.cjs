// Full production router against the loopback staging DB. No test auth endpoints.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {client,root}=require('../tests/helpers/mls-client.cjs');
if(root!=='http://127.0.0.1:18794')throw Error('Only the isolated local staging is accepted');
const secrets=JSON.parse(fs.readFileSync(path.join(__dirname,'../.cache/mls-staging/credentials.json'),'utf8'));
async function request(route,payload,token,method='POST'){
 console.log('Checking',method,route);
 const r=await fetch(root+'/api'+route,{method,headers:{'content-type':'application/json',connection:'close',...(token?{authorization:'Bearer '+token}:{})},body:method==='GET'?undefined:JSON.stringify(payload)});
 const data=await r.json();if(!r.ok)throw Error(`${route}: ${r.status}`);return data;
}
async function login(name){
 const payload={email:`mls-staging-${name}@example.com`,password:secrets[name]};
 try{return await request('/auth/login',payload);}catch{
  return request('/auth/register',{...payload,name:'Staging '+name,username:'mls_stage_'+name});
 }
}
(async()=>{
 const a=await login('alice'),b=await login('bob');
 const contacts=await request('/contacts',undefined,a.access_token,'GET');
 if(!contacts.some(u=>u.id===b.user.id)){
  const pending=await request('/contacts/invitations',undefined,b.access_token,'GET');
  const invitation=pending.incoming.find(i=>i.from_user_id===a.user.id)||await request('/contacts/invite',{username:b.user.username},a.access_token);
  await request('/contacts/invitations/'+invitation.id+'/accept',{},b.access_token);
 }
 const conv=await request('/conversations',{type:'direct',member_ids:[b.user.id],force_new:true},a.access_token);
 const alice=client(a.user.id,undefined,a.access_token),bob=client(b.user.id,undefined,b.access_token);
 try{
  for(const [auth,c] of [[a,alice],[b,bob]])await c.lib.enrollMLS(auth.user.id);
  for(const [auth,c] of [[a,alice],[b,bob]]){
   const directory=await c.lib.directoryMLS(auth.user.id,conv.id);
   const devices=directory.devices.filter(d=>[alice.disk.value.device.device_id,bob.disk.value.device.device_id].includes(d.device_id));
   await c.lib.approveMLS(auth.user.id,conv.id,devices);
  }
  await alice.lib.initializeMLS(a.user.id,conv.id);
  await alice.lib.sendMLS(a.user.id,conv.id,{kind:'text',content:'Synthetic staging MLS exchange'});
  assert.equal((await bob.lib.messagesMLS(b.user.id,conv.id))[0].content,'Synthetic staging MLS exchange');
  const restarted=client(b.user.id,bob.disk,b.access_token);
  await restarted.lib.sendMLS(b.user.id,conv.id,{kind:'text',content:'Reply after client restart'});
  assert.equal((await alice.lib.messagesMLS(a.user.id,conv.id)).length,2);
  const nacl=require('../frontend/node_modules/tweetnacl');
  const key=nacl.randomBytes(32),nonce=nacl.randomBytes(24),plain=Buffer.from('Synthetic encrypted staging attachment');
  const encrypted=nacl.secretbox(plain,nonce,key);
  const uploaded=await request('/uploads',{filename:'attachment.ghostel',mime:'application/octet-stream',data:Buffer.from(encrypted).toString('base64'),size:encrypted.length},a.access_token);
  await alice.lib.sendMLS(a.user.id,conv.id,{kind:'file',content:'',attachment_id:uploaded.id,e2ee_attachment:{version:2,key:Buffer.from(key).toString('base64'),nonce:Buffer.from(nonce).toString('base64'),mime:'text/plain',filename:'staging.txt',size:plain.length}});
  const received=(await restarted.lib.messagesMLS(b.user.id,conv.id)).find(m=>m.attachment_id===uploaded.id);
  assert.ok(received?.e2ee_attachment);
  const download=await request('/uploads/'+uploaded.id,undefined,b.access_token,'GET');
  assert.equal(Buffer.from(nacl.secretbox.open(Buffer.from(download.data,'base64'),Buffer.from(received.e2ee_attachment.nonce,'base64'),Buffer.from(received.e2ee_attachment.key,'base64'))).toString(),plain.toString());
  assert.equal(download.filename,'attachment.ghostel');
  const hydrated=await request('/conversations/'+conv.id,undefined,a.access_token,'GET');
  assert.equal(hydrated.e2ee_protocol,'mls-v1');
  const denied=await fetch(root+'/api/messages',{method:'POST',headers:{authorization:'Bearer '+a.access_token,'content-type':'application/json',connection:'close'},body:JSON.stringify({conversation_id:conv.id,content:'legacy rejected',kind:'text'})});
  assert.equal(denied.status,409);
  console.log('PASS: real auth/session, contact invitation, conversation, MLS exchange, restart, encrypted attachment upload/download, hydration and legacy rejection');
 }finally{
  for(const [auth,c] of [[a,alice],[b,bob]])if(c.disk.value?.device)await c.api.delete('/mls/devices/'+c.disk.value.device.device_id);
 }
})().catch(e=>{console.error(e.stack, e.cause?.code || e.cause?.message || '');process.exitCode=1;});
