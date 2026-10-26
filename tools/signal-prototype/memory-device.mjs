// TEST-ONLY integration harness. Never use this unencrypted volatile store in
// production. All cryptographic operations are delegated to official libsignal.
import { randomInt, randomUUID } from 'node:crypto';
import * as signal from '@signalapp/libsignal-client';

const bytesEqual = (a,b) => Buffer.from(a).equals(Buffer.from(b));
const keyOf = address => `${address.name()}.${address.deviceId()}`;

export class MemoryDevice {
  constructor(deviceId = 1) {
    this.address = signal.ProtocolAddress.new(randomUUID(),deviceId);
    this.identity = signal.IdentityKeyPair.generate();
    this.registrationId = randomInt(1,16380);
    this.sessions = new Map();
    this.pins = new Map();
    this.preKeys = new Map();
    this.signedKeys = new Map();
    this.kyberKeys = new Map();
  }
  // In tests these pins come directly from the other local device. Production
  // requires an independent authenticated verification/device-linking ceremony.
  verifyPeer(peer) { this.pins.set(keyOf(peer.address),peer.identity.publicKey.serialize()); }
  async getIdentityKey() { return this.identity.privateKey; }
  async getIdentityKeyPair() { return this.identity; }
  async getLocalRegistrationId() { return this.registrationId; }
  async getIdentity(address) {
    const value = this.pins.get(keyOf(address));
    return value ? signal.PublicKey.deserialize(value) : null;
  }
  async isTrustedIdentity(address, key) {
    const pin = this.pins.get(keyOf(address));
    return !!pin && bytesEqual(pin,key.serialize());
  }
  async saveIdentity(address,key) {
    if (!await this.isTrustedIdentity(address,key)) throw new Error('Unverified identity');
    return signal.IdentityChange.NewOrUnchanged;
  }
  async saveSession(address,record) { this.sessions.set(keyOf(address),record.serialize()); }
  async getSession(address) {
    const value = this.sessions.get(keyOf(address));
    return value ? signal.SessionRecord.deserialize(value) : null;
  }
  async getExistingSessions(addresses) {
    return Promise.all(addresses.map(async address => {
      const record = await this.getSession(address);
      if (!record) throw new Error('Session missing');
      return record;
    }));
  }
  async savePreKey(id,record) { this.preKeys.set(id,record.serialize()); }
  async getPreKey(id) {
    if (!this.preKeys.has(id)) throw new Error('Prekey missing');
    return signal.PreKeyRecord.deserialize(this.preKeys.get(id));
  }
  async removePreKey(id) { this.preKeys.delete(id); }
  async saveSignedPreKey(id,record) { this.signedKeys.set(id,record.serialize()); }
  async getSignedPreKey(id) {
    if (!this.signedKeys.has(id)) throw new Error('Signed prekey missing');
    return signal.SignedPreKeyRecord.deserialize(this.signedKeys.get(id));
  }
  async saveKyberPreKey(id,record) { this.kyberKeys.set(id,record.serialize()); }
  async getKyberPreKey(id) {
    if (!this.kyberKeys.has(id)) throw new Error('Kyber prekey missing');
    return signal.KyberPreKeyRecord.deserialize(this.kyberKeys.get(id));
  }
  async markKyberPreKeyUsed(id) { this.kyberKeys.delete(id); }

  async publicBundle({badSignature=false} = {}) {
    const prekey = signal.PrivateKey.generate();
    const signed = signal.PrivateKey.generate();
    const kyber = signal.KEMKeyPair.generate();
    const id = randomInt(1,0x7fffffff);
    const signature = this.identity.privateKey.sign(signed.getPublicKey().serialize());
    const kyberSignature = this.identity.privateKey.sign(kyber.getPublicKey().serialize());
    await this.savePreKey(id,signal.PreKeyRecord.new(id,prekey.getPublicKey(),prekey));
    await this.saveSignedPreKey(id,signal.SignedPreKeyRecord.new(id,Date.now(),signed.getPublicKey(),signed,signature));
    await this.saveKyberPreKey(id,signal.KyberPreKeyRecord.new(id,Date.now(),kyber,kyberSignature));
    const publishedSignature = Uint8Array.from(signature);
    if (badSignature) publishedSignature[0] ^= 1;
    return signal.PreKeyBundle.new(this.registrationId,this.address.deviceId(),
      id,prekey.getPublicKey(),id,signed.getPublicKey(),publishedSignature,
      this.identity.publicKey,id,kyber.getPublicKey(),kyberSignature);
  }
  async establish(peerAddress,bundle) {
    await signal.processPreKeyBundle(bundle,peerAddress,this.address,this,this);
  }
  async encrypt(peerAddress,text) {
    const message = await signal.signalEncrypt(new TextEncoder().encode(text),peerAddress,this.address,this,this);
    return { type:message.type(), bytes:message.serialize() };
  }
  async decrypt(peerAddress,packet) {
    let plaintext;
    if (packet.type === signal.CiphertextMessageType.PreKey) {
      plaintext = await signal.signalDecryptPreKey(signal.PreKeySignalMessage.deserialize(packet.bytes),
        peerAddress,this.address,this,this,this,this,this);
    } else if (packet.type === signal.CiphertextMessageType.Whisper) {
      plaintext = await signal.signalDecrypt(signal.SignalMessage.deserialize(packet.bytes),
        peerAddress,this.address,this,this);
    } else {
      throw new Error('Unsupported protocol message type');
    }
    return new TextDecoder().decode(plaintext);
  }
}
