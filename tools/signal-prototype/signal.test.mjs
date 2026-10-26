import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryDevice} from './memory-device.mjs';

async function pair() {
  const alice = new MemoryDevice();
  const bob = new MemoryDevice();
  alice.verifyPeer(bob);
  bob.verifyPeer(alice);
  await alice.establish(bob.address,await bob.publicBundle());
  return {alice,bob};
}

test('official libsignal: signed hybrid prekey handshake and bidirectional session', async () => {
  const {alice,bob} = await pair();
  const first = await alice.encrypt(bob.address,'secret hello');
  assert.equal(await bob.decrypt(alice.address,first),'secret hello');
  assert.equal(bob.preKeys.size,0);
  assert.equal(bob.kyberKeys.size,0);
  assert.equal(await alice.decrypt(bob.address,await bob.encrypt(alice.address,'reply')),'reply');
  assert.equal(await bob.decrypt(alice.address,await alice.encrypt(bob.address,'next message')),'next message');
});

test('official libsignal: rejects replay after successful delivery', async () => {
  const {alice,bob} = await pair();
  const first = await alice.encrypt(bob.address,'once');
  await bob.decrypt(alice.address,first);
  await alice.decrypt(bob.address,await bob.encrypt(alice.address,'ack'));
  const next = await alice.encrypt(bob.address,'only once');
  await bob.decrypt(alice.address,next);
  await assert.rejects(bob.decrypt(alice.address,next), /duplicate|old counter/i);
});

test('official libsignal: tamper rejection leaves the valid packet decryptable', async () => {
  const {alice,bob} = await pair();
  await bob.decrypt(alice.address,await alice.encrypt(bob.address,'hello'));
  await alice.decrypt(bob.address,await bob.encrypt(alice.address,'reply'));
  const packet = await alice.encrypt(bob.address,'valid');
  const altered = {type:packet.type, bytes:Uint8Array.from(packet.bytes)};
  altered.bytes[altered.bytes.length-1] ^= 1;
  await assert.rejects(bob.decrypt(alice.address,altered));
  assert.equal(await bob.decrypt(alice.address,packet),'valid');
});

test('official libsignal: out-of-order messages are accepted once', async () => {
  const {alice,bob} = await pair();
  await bob.decrypt(alice.address,await alice.encrypt(bob.address,'hello'));
  await alice.decrypt(bob.address,await bob.encrypt(alice.address,'reply'));
  const a = await alice.encrypt(bob.address,'a');
  const b = await alice.encrypt(bob.address,'b');
  assert.equal(await bob.decrypt(alice.address,b),'b');
  assert.equal(await bob.decrypt(alice.address,a),'a');
  await assert.rejects(bob.decrypt(alice.address,a), /duplicate|old counter/i);
});

test('official libsignal: forged signed prekey is rejected', async () => {
  const alice = new MemoryDevice(), bob = new MemoryDevice();
  alice.verifyPeer(bob);
  await assert.rejects(alice.establish(bob.address,await bob.publicBundle({badSignature:true})));
  assert.equal(alice.sessions.size,0);
});

test('official libsignal: unverified and replaced identities are rejected', async () => {
  const alice = new MemoryDevice(), bob = new MemoryDevice(), mallory = new MemoryDevice();
  const bundle = await bob.publicBundle();
  await assert.rejects(alice.establish(bob.address,bundle));
  alice.verifyPeer(bob);
  await assert.rejects(alice.establish(bob.address,await mallory.publicBundle()));
  assert.equal(alice.sessions.size,0);
});
