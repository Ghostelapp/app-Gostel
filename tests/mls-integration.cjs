const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { client, root } = require('./helpers/mls-client.cjs');
async function room(members = ['alice','bob']) {
  const response = await fetch(root + '/test/room', { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type':'application/json' }, body: JSON.stringify({ members }) });
  assert.equal(response.status, 200); return (await response.json()).id;
}
async function setup(members = ['alice','bob']) {
  const clients = Object.fromEntries(members.map(user => [user, client(user)]));
  const id = await room(members);
  for (const user of members) await clients[user].lib.enrollMLS(user);
  for (const user of members) {
    const directory = await clients[user].lib.directoryMLS(user,id);
    // Only devices belonging to this isolated test instance are approved.
    const devices = directory.devices.filter(d => members.some(u => clients[u].disk.value.device.device_id === d.device_id));
    await clients[user].lib.approveMLS(user,id,devices);
  }
  await clients.alice.lib.initializeMLS('alice',id);
  return { id, ...clients };
}
async function raw(id) { return (await fetch(root + '/test/events/' + id)).json(); }

test('WASM + TypeScript + FastAPI + MongoDB: exchange, restart and encrypted server storage', async () => {
  const { id, alice, bob } = await setup();
  const sent = await alice.lib.sendMLS('alice',id,{kind:'text',content:'secret visible only to peers'});
  assert.equal((await bob.lib.messagesMLS('bob',id))[0].content,sent.content);
  const restarted = client('bob',bob.disk);
  await restarted.lib.sendMLS('bob',id,{kind:'text',content:'reply after process restart'});
  const messages = await alice.lib.messagesMLS('alice',id);
  assert.equal(messages.length,2); assert.equal(messages[1].content,'reply after process restart');
  const events = await raw(id);
  assert.ok(!JSON.stringify(events).includes('secret visible only to peers'));
  assert.deepEqual(events.map(e=>e.seq),[1,2,3,4,5]);
});

test('lost acknowledgment: restart retransmits identical ciphertext exactly once', async () => {
  const { id, alice, bob } = await setup();
  alice.faults.loseApplicationReply = true;
  await assert.rejects(alice.lib.sendMLS('alice',id,{kind:'text',content:'one durable message'}),/lost response/);
  const before = await raw(id); assert.equal(before.length,3);
  const restarted = client('alice',alice.disk);
  assert.equal((await restarted.lib.messagesMLS('alice',id)).length,1);
  const after = await raw(id); assert.equal(after.length,3); assert.equal(after[2].message,before[2].message);
  assert.equal((await bob.lib.messagesMLS('bob',id)).length,1);
});

test('failed durable save never releases generated ciphertext to delivery', async () => {
  const { id, alice } = await setup();
  const before = await raw(id);
  await assert.rejects(alice.lib.sendMLS('alice',id,{kind:'text',content:'x'.repeat(10001)}),/Invalid authenticated/);
  assert.equal((await raw(id)).length,before.length);
  alice.faults.failSave = true;
  await assert.rejects(alice.lib.sendMLS('alice',id,{kind:'text',content:'must not escape'}),/storage failure/);
  assert.equal((await raw(id)).length,before.length);
});

test('unverified device roster cannot join; protocol downgrade is blocked locally', async () => {
  const { id, alice, bob } = await setup();
  await assert.rejects(alice.lib.assertMLSProtocol('alice',{id,e2ee_protocol:'nacl-box-v1'}),/downgrade/);
  const unknown = client('carol'); await unknown.lib.enrollMLS('carol');
  await assert.rejects(unknown.lib.messagesMLS('carol',id),/Verify/);
  const directory = await bob.lib.directoryMLS('bob',id);
  const changed = structuredClone(directory.devices); changed[0].signature_key = crypto.randomBytes(32).toString('base64');
  await assert.rejects(bob.lib.approveMLS('bob',id,changed));
});

test('concurrent commits have one winner; rejected sender can synchronize and retry', async () => {
  const { id, alice, bob } = await setup(); await bob.lib.messagesMLS('bob',id);
  const results = await Promise.allSettled([
    alice.lib.sendMLS('alice',id,{kind:'text',content:'alice race'}),
    bob.lib.sendMLS('bob',id,{kind:'text',content:'bob race'}),
  ]);
  assert.ok(results.some(r=>r.status==='fulfilled'));
  // Depending on scheduling both may succeed in distinct ordered epochs.
  for (const [index, user] of ['alice','bob'].entries()) if (results[index].status === 'rejected') {
    const c = user === 'alice' ? alice : bob;
    await c.lib.messagesMLS(user,id);
    await c.lib.sendMLS(user,id,{kind:'text',content:'retried safely'});
  }
  assert.equal((await alice.lib.messagesMLS('alice',id)).length,2);
  assert.equal((await bob.lib.messagesMLS('bob',id)).length,2);
  const events = await raw(id); assert.equal(new Set(events.map(e=>e.seq)).size,events.length);
});

test('three-party group and encrypted reaction event work without server plaintext', async () => {
  const { id, alice, bob, carol } = await setup(['alice','bob','carol']);
  const sent = await alice.lib.sendMLS('alice',id,{kind:'text',content:'group secret'});
  await bob.lib.messagesMLS('bob',id);
  await bob.lib.sendMLS('bob',id,{kind:'reaction',content:'👍',target_id:sent.id,active:true});
  const received = await carol.lib.messagesMLS('carol',id);
  assert.equal(received[0].content,'group secret'); assert.equal(received[0].reactions['👍'][0],'bob');
  assert.ok(!JSON.stringify(await raw(id)).includes('👍'));
});

test('revoked device freezes room; unrelated user cannot enumerate its devices', async () => {
  const { id, alice, bob } = await setup();
  const mallory = client('mallory'); await mallory.lib.enrollMLS('mallory');
  await assert.rejects(mallory.lib.directoryMLS('mallory',id),e=>e.response?.status === 404);
  await bob.api.delete('/mls/devices/' + bob.disk.value.device.device_id);
  await assert.rejects(alice.lib.sendMLS('alice',id,{kind:'text',content:'blocked after revocation'}));
  assert.equal((await raw(id)).length,1);
});

test('legacy insertion is atomically forbidden after MLS activation', async () => {
  const {id} = await setup();
  const response = await fetch(root + '/test/legacy/' + id, {method:'POST',headers:{authorization:'Bearer alice'}});
  assert.equal(response.status,409);
});

test('KeyPackage claims are one-time and retries return the original claim', async () => {
  const alice=client('alice'), bob=client('bob'); await alice.lib.enrollMLS('alice'); await bob.lib.enrollMLS('bob');
  const id=await room(), target=bob.disk.value.device.device_id, own=alice.disk.value.device.device_id;
  const claim=id=>alice.api.post(`/mls/conversations/${idRoom}/packages/${target}/${id}`,null,{params:{device_id:own}});
  const idRoom=id, first=crypto.randomUUID(), second=crypto.randomUUID();
  const [a,b]=await Promise.all([claim(first),claim(second)]);
  assert.notEqual(a.data.package,b.data.package);
  assert.equal((await claim(first)).data.package,a.data.package);
});

test('invalid device possession proof is rejected before device creation', async () => {
  const mallory=client('mallory');
  await assert.rejects(mallory.api.post('/mls/devices',{device_id:crypto.randomUUID(),signature_key:crypto.randomBytes(32).toString('base64'),session_proof:Buffer.alloc(64).toString('base64'),key_packages:[]}),e=>e.response?.status===403);
});

test('encrypted deletion accepts only the original sender', async () => {
  const {id,alice,bob}=await setup();
  const sent=await alice.lib.sendMLS('alice',id,{kind:'text',content:'sender controls deletion'});
  await bob.lib.messagesMLS('bob',id);
  await bob.lib.sendMLS('bob',id,{kind:'delete',content:'',target_id:sent.id});
  assert.equal((await alice.lib.messagesMLS('alice',id)).length,1);
  await alice.lib.sendMLS('alice',id,{kind:'delete',content:'',target_id:sent.id});
  assert.equal((await bob.lib.messagesMLS('bob',id)).length,0);
});


test('revoked login session cannot rebind or revoke MLS devices', async () => {
  const c=client('mallory'); await c.lib.enrollMLS('mallory');
  const response=await fetch(root+'/test/revoke-session',{method:'POST',headers:{authorization:'Bearer mallory'}});
  assert.equal(response.status,200);
  await assert.rejects(c.api.delete('/mls/devices/'+c.disk.value.device.device_id),e=>e.response?.status===401);
  c.lib.resetMLSSession('mallory');
  await assert.rejects(c.lib.enrollMLS('mallory'),e=>e.response?.status===401);
});
