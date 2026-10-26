import * as Crypto from 'expo-crypto';
import { api } from '../api';
import { invokeMLS } from './runtime';
import { withVault } from './vault';
import { b64, unb64, utf8 } from './encoding';
import type { Vault, Device, PublicDevice, Room } from './types';
const enrolled = new Map<string, Promise<void>>();
const checkedAt = new Map<string, number>();
const deviceKey = (d: Device) => `${d.user_id}/${d.device_id}`;
const sameRoster = (a: Device[], b: Device[]) => JSON.stringify(a.map(deviceKey).sort()) === JSON.stringify(b.map(deviceKey).sort());
type Save = (v: Vault) => Promise<void>;
async function run(v: Vault, command: unknown) {
  const result = await invokeMLS({ device: v.device, master: v.master, state: v.state || null, command });
  v.state = result.state; return result.output;
}
async function use<T>(user: string, f: (v: Vault, save: Save) => Promise<T>): Promise<T> {
  return withVault(user, async (state, save) => {
    let v = state;
    if (!v) {
      v = { version: 1, device: { user_id: user, device_id: Crypto.randomUUID() }, master: b64(await Crypto.getRandomBytesAsync(32)), verified: {}, rooms: {} };
      const identity = await run(v, { op: 'identity' }); v.publicKey = b64(new Uint8Array(identity.signature_key));
      v.verified[deviceKey(v.device)] = v.publicKey; await save(v);
    }
    if (v.version !== 1 || v.device.user_id !== user) throw new Error('MLS vault account mismatch');
    return f(v, save);
  });
}
export function resetMLSSession(user: string) { enrolled.delete(user); }
export async function enrollMLS(user: string): Promise<void> {
  if (Date.now() - (checkedAt.get(user) || 0) > 300000) enrolled.delete(user);
  if (!enrolled.has(user)) {
    const job = (async () => {
      const { data: capabilities } = await api.get('/mls/capabilities');
      if (!capabilities.enabled) throw new Error('MLS is not enabled on this server');
      const { data: binding } = await api.get('/mls/session');
      await use(user, async (v, save) => {
        const proof = await run(v, { op: 'authorize_session', session_id: binding.session_id });
        await save(v);
        const publish = (packages: string[]) => api.post('/mls/devices', { device_id: v.device.device_id, signature_key: v.publicKey, session_proof: proof, key_packages: packages });
        let status = await publish(v.enrollment || []);
        if (v.enrollment) { delete v.enrollment; await save(v); }
        if (status.data.available < 16) {
          v.enrollment = [];
          for (let i = status.data.available; i < 32; i++) v.enrollment.push(await run(v, { op: 'key_package' }));
          await save(v); // Private keys and publication batch precede network IO.
          await publish(v.enrollment);
          delete v.enrollment; await save(v);
        }
        checkedAt.set(user, Date.now());
      });
    })();
    checkedAt.set(user, Date.now());
    enrolled.set(user, job); job.catch(() => { if (enrolled.get(user) === job) enrolled.delete(user); });
  }
  return enrolled.get(user)!;
}
export async function directoryMLS(user: string, conversation: string) {
  await enrollMLS(user);
  const { data } = await api.get(`/mls/conversations/${conversation}/devices`);
  return use(user, async v => {
    const devices: PublicDevice[] = data.devices.filter((d: PublicDevice) => !data.protocol || data.device_ids.includes(d.device_id));
    for (const d of devices) if (d.device_id === v.device.device_id && (d.user_id !== user || d.signature_key !== v.publicKey)) throw new Error('Server substituted this device identity');
    return { ...data, devices, own: { ...v.device, signature_key: v.publicKey! }, approved: !!v.rooms[conversation] };
  });
}
export async function approveMLS(user: string, conversation: string, devices: PublicDevice[]) {
  await enrollMLS(user);
  await use(user, async (v, save) => {
    if (!devices.some(d => deviceKey(d) === deviceKey(v.device)) || devices.length < 2 || devices.length > 256) throw new Error('Incomplete MLS device roster');
    const roster = devices.map(({ user_id, device_id }) => ({ user_id, device_id }));
    const room = v.rooms[conversation];
    if (room && !sameRoster(room.roster, roster)) throw new Error('MLS membership changed. Create a new room with the verified devices.');
    for (const peer of devices) {
      await run(v, { op: 'verify', peer: { device: { user_id: peer.user_id, device_id: peer.device_id }, signature_key: Array.from(unb64(peer.signature_key)) } });
      v.verified[deviceKey(peer)] = peer.signature_key;
    }
    v.rooms[conversation] ||= { roster, seq: 0, epoch: 0, joined: false, messages: [] };
    await save(v);
  });
}
export async function hasMLSApproval(user: string, conversation: string) {
  return withVault(user, async v => !!v?.rooms[conversation]);
}
function display(event: any, body: any, sender: Device) {
  if (body.version !== 1 || body.id !== event.id || typeof body.content !== 'string' || body.content.length > 10000 || !['text', 'image', 'voice', 'file', 'reaction', 'delete'].includes(body.kind)) throw new Error('Invalid authenticated MLS application message');
  if (typeof body.created_at !== 'string' || !Number.isFinite(Date.parse(body.created_at))) throw new Error('Invalid MLS message timestamp');
  if (body.kind !== 'text' && body.kind !== 'reaction' && body.kind !== 'delete') {
    if (typeof body.attachment_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.attachment_id) || body.e2ee_attachment?.version !== 2 || typeof body.e2ee_attachment.key !== 'string' || unb64(body.e2ee_attachment.key).length !== 32 || unb64(body.e2ee_attachment.nonce).length !== 24 || typeof body.e2ee_attachment.mime !== 'string') throw new Error('Invalid MLS attachment');
  }
  return { kind: body.kind, attachment_id: body.attachment_id, duration_ms: body.duration_ms, e2ee_attachment: body.e2ee_attachment, target_id: body.target_id, active: body.active === true, id: event.id, conversation_id: event.conversation_id, sender_id: sender.user_id,
    sender_name: sender.user_id, created_at: body.created_at, encrypted: true, e2ee_version: 2, e2ee_decrypted: true,
    read_by: [], reactions: {}, content: body.content };
}
function cache(room: Room, message: any) {
  if (message.kind === 'delete') {
    if (typeof message.target_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.target_id)) return;
    const target = room.messages.find(m => m.id === message.target_id);
    if (target && target.sender_id !== message.sender_id) return;
    room.deletions ||= {}; room.deletions[message.target_id] = message.sender_id;
    room.messages = room.messages.filter(m => m.id !== message.target_id || m.sender_id !== message.sender_id);
  } else if (message.kind === 'reaction') {
    const target = room.messages.find(m => m.id === message.target_id);
    if (!target || !['👍', '❤️', '😂', '🎉', '🔒'].includes(message.content)) return;
    for (const users of Object.values(target.reactions || {}) as string[][]) { const i = users.indexOf(message.sender_id); if (i >= 0) users.splice(i, 1); }
    if (message.active) { target.reactions ||= {}; (target.reactions[message.content] ||= []).push(message.sender_id); }
  } else if (room.deletions?.[message.id] !== message.sender_id && !room.messages.some(m => m.id === message.id)) room.messages.push(message);
}
async function flush(v: Vault, conversation: string, room: Room, save: Save) {
  const outbox = room.outbox; if (!outbox) return;
  let event: any;
  try { event = (await api.post(`/mls/conversations/${conversation}/events`, outbox.request)).data; }
  catch (error: any) {
    if (error?.response?.status === 409) {
      // 409 is a definitive non-acceptance: idempotency lookup precedes sequence
      // validation on the server. Never roll the sending ratchet back.
      if (outbox.request.kind !== 'application') await run(v, { op: 'cancel', conversation, bootstrap: outbox.request.kind === 'bootstrap' });
      delete room.outbox; await save(v);
      throw new Error('Another device advanced this conversation. Synchronize and send again.');
    }
    throw error; // Unknown result: keep the exact ciphertext for retry.
  }
  if (event.kind !== outbox.request.kind || event.epoch !== room.epoch + (event.kind === 'application' ? 0 : 1) || event.id !== outbox.request.request_id || event.sender_device_id !== v.device.device_id || event.seq !== room.seq + 1 || event.message !== outbox.request.message) throw new Error('Invalid MLS delivery acknowledgment');
  if (outbox.request.kind !== 'application') {
    await run(v, { op: 'accept', conversation, roster: room.roster }); room.joined = true;
  } else cache(room, display(event, outbox.body, v.device));
  room.seq = event.seq; room.epoch = event.epoch; delete room.outbox;
  await save(v);
}
async function sync(v: Vault, conversation: string, room: Room, save: Save) {
  await flush(v, conversation, room, save);
  for (;;) {
    const { data } = await api.get(`/mls/conversations/${conversation}/events`, { params: { device_id: v.device.device_id, after: room.seq } });
    if (!Array.isArray(data.events)) throw new Error('Invalid MLS delivery response');
    for (const event of data.events) {
      if (event.seq !== room.seq + 1 || event.conversation_id !== conversation || event.sender_device_id === v.device.device_id) throw new Error('MLS delivery gap or unknown own message');
      if (event.kind === 'bootstrap') {
        if (room.joined || event.seq !== 1 || !sameRoster(room.roster, room.roster.filter(d => event.device_ids?.includes(d.device_id))) || event.device_ids.length !== room.roster.length) throw new Error('Unexpected MLS bootstrap roster');
        await run(v, { op: 'join', conversation, welcome: event.welcome, roster: room.roster }); room.joined = true;
      } else {
        if (!room.joined) throw new Error('MLS Welcome is missing');
        const result = await run(v, { op: 'receive', conversation, message: event.message, roster: room.roster });
        if (event.kind === 'application') {
          if (result.kind !== 'application' || result.sender.user_id !== event.sender_id || result.sender.device_id !== event.sender_device_id) throw new Error('MLS sender binding mismatch');
          cache(room, display(event, JSON.parse(result.body), result.sender));
        } else if (event.kind !== 'commit' || result.kind !== 'commit') throw new Error('MLS event type mismatch');
      }
      if (event.epoch !== room.epoch + (event.kind === 'application' ? 0 : 1)) throw new Error('MLS epoch sequence mismatch');
      room.seq = event.seq; room.epoch = event.epoch;
      // Authenticate/decrypt, local history and receive cursor commit together.
      await save(v);
    }
    if (room.seq >= data.head) return;
    if (!data.events.length) throw new Error('MLS delivery stream is truncated');
  }
}
export async function initializeMLS(user: string, conversation: string) {
  await enrollMLS(user);
  await use(user, async (v, save) => {
    const room = v.rooms[conversation]; if (!room) throw new Error('Verify all device fingerprints first');
    if (room.outbox) { await flush(v, conversation, room, save); return; }
    if (room.joined) return;
    room.claimId ||= Crypto.randomUUID(); await save(v);
    const packages: string[] = [];
    for (const d of room.roster) if (d.device_id !== v.device.device_id) {
      const { data } = await api.post(`/mls/conversations/${conversation}/packages/${d.device_id}/${room.claimId}`, null, { params: { device_id: v.device.device_id } }); packages.push(data.package);
    }
    await run(v, { op: 'create', conversation });
    const added = await run(v, { op: 'add', conversation, packages, roster: room.roster });
    room.outbox = { request: { device_id: v.device.device_id, request_id: Crypto.randomUUID(), expected_seq: 0, epoch: 0, kind: 'bootstrap', message: added.message, welcome: added.welcome, device_ids: room.roster.map(d => d.device_id) } };
    await save(v); await flush(v, conversation, room, save);
  });
}
export async function messagesMLS(user: string, conversation: string) {
  await enrollMLS(user);
  return use(user, async (v, save) => {
    const room = v.rooms[conversation]; if (!room) throw new Error('Verify the MLS devices in Conversation security first');
    await sync(v, conversation, room, save); return room.messages;
  });
}
export async function sendMLS(user: string, conversation: string, payload: any) {
  await enrollMLS(user);
  return use(user, async (v, save) => {
    const room = v.rooms[conversation]; if (!room) throw new Error('Verify the MLS device roster first');
    const id = Crypto.randomUUID();
    const body = { ...payload, version: 1, id, created_at: new Date().toISOString() };
    // Validate before publishing anything, so a malformed local payload cannot
    // create an accepted event that this same client will refuse to consume.
    display({ id, conversation_id: conversation }, body, v.device);
    const encoded = JSON.stringify(body);
    if (utf8(encoded).length > 65536) throw new Error('MLS message exceeds the encrypted payload limit');
    await sync(v, conversation, room, save);
    // Fresh UpdatePath before each application send gives regular PCS recovery,
    // with the update durably delivered before its application epoch is used.
    const update = await run(v, { op: 'update', conversation });
    room.outbox = { request: { device_id: v.device.device_id, request_id: Crypto.randomUUID(), expected_seq: room.seq, epoch: room.epoch, kind: 'commit', message: update.message } };
    await save(v); await flush(v, conversation, room, save);
    if (body.attachment_id) await api.post(`/mls/conversations/${conversation}/attachments/${body.attachment_id}`);
    const message = await run(v, { op: 'encrypt', conversation, body: encoded, roster: room.roster });
    room.outbox = { request: { device_id: v.device.device_id, request_id: id, expected_seq: room.seq, epoch: room.epoch, kind: 'application', message }, body };
    await save(v); await flush(v, conversation, room, save);
    return room.messages.find(m => m.id === id) || null;
  });
}

export async function assertMLSProtocol(user: string, conversation: { id: string; e2ee_protocol?: string }) {
  return withVault(user, async v => {
    if (v?.rooms[conversation.id] && conversation.e2ee_protocol !== 'mls-v1') throw new Error('MLS protocol downgrade detected');
  });
}

export async function revokeMLSDevice(user: string, deviceId: string) {
  await api.delete(`/mls/devices/${deviceId}`);
  resetMLSSession(user);
}
