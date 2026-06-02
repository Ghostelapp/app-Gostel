import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import nacl from 'tweetnacl';
import { api } from './api';

const ALGORITHM = 'nacl-box-v1' as const;
const IDENTITY_PREFIX = 'ghostel_e2ee_identity_v1:';
const TRUST_PREFIX = 'ghostel_e2ee_trusted_keys_v1:';
const PLACEHOLDER = '[encrypted message]';
export const E2EE_UNAVAILABLE_TEXT = 'Encrypted message unavailable on this device';

type Algorithm = typeof ALGORITHM;

export type E2EEIdentity = {
  algorithm: Algorithm;
  publicKey: string;
  secretKey: string;
  createdAt: string;
};

export type E2EEUser = {
  id: string;
  e2ee_public_key?: string | null;
};

export type E2EEConversation = {
  type: 'direct' | 'group';
  members: E2EEUser[];
};

export type E2EEKeyTrustStatus = {
  ready: boolean;
  trusted: boolean;
  missingMemberIds: string[];
  changedMemberIds: string[];
  fingerprints: Record<string, string>;
};

export type E2EEPayload = {
  version: 1;
  algorithm: Algorithm;
  sender_public_key: string;
  sender_user_id?: string;
  recipients: Record<string, { nonce: string; ciphertext: string }>;
};

export type E2EEAttachmentPayload = {
  version: 1;
  algorithm: 'nacl-secretbox-v1';
  nonce: string;
  mime: string;
  size?: number | null;
  key_recipients: Record<string, { nonce: string; ciphertext: string }>;
};

export type E2EEMessageLike = {
  sender_id: string;
  content: string;
  kind?: string;
  encrypted?: boolean;
  e2ee?: E2EEPayload | null;
  e2ee_attachment?: E2EEAttachmentPayload | null;
  e2ee_decrypted?: boolean;
};

const canUseSecureStore = Platform.OS !== 'web';
const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function identityKey(userId: string): string {
  return `${IDENTITY_PREFIX}${userId}`;
}

function trustedKeysKey(userId: string): string {
  return `${TRUST_PREFIX}${userId}`;
}

async function getStoredIdentity(userId: string): Promise<E2EEIdentity | null> {
  const key = identityKey(userId);
  let raw: string | null = null;
  if (canUseSecureStore) {
    try {
      raw = await SecureStore.getItemAsync(key);
    } catch {
      raw = null;
    }
  }
  if (!raw) raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as E2EEIdentity;
    if (
      parsed.algorithm === ALGORITHM &&
      parsed.publicKey &&
      parsed.secretKey
    ) {
      return parsed;
    }
  } catch {
    /* regenerate below */
  }
  return null;
}

async function setStoredIdentity(userId: string, identity: E2EEIdentity): Promise<void> {
  const key = identityKey(userId);
  const raw = JSON.stringify(identity);
  if (canUseSecureStore) {
    try {
      await SecureStore.setItemAsync(key, raw);
      await AsyncStorage.removeItem(key);
      return;
    } catch {
      /* web/fallback below */
    }
  }
  await AsyncStorage.setItem(key, raw);
}

async function getTrustedPublicKeys(userId: string): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(trustedKeysKey(userId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

async function setTrustedPublicKeys(
  userId: string,
  keys: Record<string, string>,
): Promise<void> {
  await AsyncStorage.setItem(trustedKeysKey(userId), JSON.stringify(keys));
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += b64chars[(n >> 18) & 63];
    out += b64chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? b64chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? b64chars[n & 63] : '=';
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = b64chars.indexOf(clean[i]);
    const c2 = b64chars.indexOf(clean[i + 1]);
    const c3 = clean[i + 2] === '=' ? -1 : b64chars.indexOf(clean[i + 2]);
    const c4 = clean[i + 3] === '=' ? -1 : b64chars.indexOf(clean[i + 3]);
    if (c1 < 0 || c2 < 0) continue;
    const n = (c1 << 18) | (c2 << 12) | ((c3 < 0 ? 0 : c3) << 6) | (c4 < 0 ? 0 : c4);
    bytes.push((n >> 16) & 255);
    if (c3 >= 0) bytes.push((n >> 8) & 255);
    if (c4 >= 0) bytes.push(n & 255);
  }
  return new Uint8Array(bytes);
}

export function publicKeyFingerprint(publicKey?: string | null): string {
  const clean = (publicKey || '').trim();
  if (!clean) return '';
  const digest = nacl.hash(base64ToBytes(clean));
  const hex = Array.from(digest.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return (hex.match(/.{1,4}/g) || [hex]).join(' ');
}

function buildTrustStatus(
  conversation: E2EEConversation | null | undefined,
  currentUserId: string | null | undefined,
  trustedKeys: Record<string, string>,
): E2EEKeyTrustStatus {
  const members = conversation?.members || [];
  const missingMemberIds: string[] = [];
  const changedMemberIds: string[] = [];
  const fingerprints: Record<string, string> = {};

  if (!conversation || !currentUserId || members.length < 2) {
    return {
      ready: false,
      trusted: false,
      missingMemberIds,
      changedMemberIds,
      fingerprints,
    };
  }

  for (const member of members) {
    if (member.id === currentUserId) continue;
    const publicKey = (member.e2ee_public_key || '').trim();
    if (!publicKey) {
      missingMemberIds.push(member.id);
      continue;
    }
    fingerprints[member.id] = publicKeyFingerprint(publicKey);
    if (trustedKeys[member.id] && trustedKeys[member.id] !== publicKey) {
      changedMemberIds.push(member.id);
    }
  }

  const ready = missingMemberIds.length === 0;
  return {
    ready,
    trusted: ready && changedMemberIds.length === 0,
    missingMemberIds,
    changedMemberIds,
    fingerprints,
  };
}

function utf8ToBytes(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value);
  }
  const escaped = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i += 1) {
    if (escaped[i] === '%') {
      bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(escaped.charCodeAt(i));
    }
  }
  return new Uint8Array(bytes);
}

function bytesToUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  let escaped = '';
  for (const byte of bytes) {
    escaped += `%${byte.toString(16).padStart(2, '0')}`;
  }
  return decodeURIComponent(escaped);
}

export async function ensureE2EEIdentity(userId: string): Promise<E2EEIdentity> {
  const existing = await getStoredIdentity(userId);
  if (existing) return existing;

  const secretKey = await Crypto.getRandomBytesAsync(nacl.box.secretKeyLength);
  const pair = nacl.box.keyPair.fromSecretKey(secretKey);
  const identity: E2EEIdentity = {
    algorithm: ALGORITHM,
    publicKey: bytesToBase64(pair.publicKey),
    secretKey: bytesToBase64(pair.secretKey),
    createdAt: new Date().toISOString(),
  };
  await setStoredIdentity(userId, identity);
  return identity;
}

export async function registerE2EEKey(userId: string): Promise<E2EEIdentity> {
  const identity = await ensureE2EEIdentity(userId);
  await api.post('/e2ee/keys', {
    public_key: identity.publicKey,
    algorithm: identity.algorithm,
  });
  return identity;
}

export function isConversationE2EEReady(
  conversation: E2EEConversation | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!conversation || !currentUserId) return false;
  if ((conversation.members || []).length < 2) return false;
  return conversation.members.every(
    (member) => member.id === currentUserId || !!member.e2ee_public_key,
  );
}

export async function syncConversationKeyTrust(
  conversation: E2EEConversation | null | undefined,
  currentUserId: string | null | undefined,
): Promise<E2EEKeyTrustStatus> {
  if (!conversation || !currentUserId) {
    return buildTrustStatus(conversation, currentUserId, {});
  }

  const trustedKeys = await getTrustedPublicKeys(currentUserId);
  const nextTrustedKeys = { ...trustedKeys };
  let changed = false;

  for (const member of conversation.members || []) {
    if (member.id === currentUserId) continue;
    const publicKey = (member.e2ee_public_key || '').trim();
    if (!publicKey) continue;
    if (!nextTrustedKeys[member.id]) {
      nextTrustedKeys[member.id] = publicKey;
      changed = true;
    }
  }

  if (changed) {
    await setTrustedPublicKeys(currentUserId, nextTrustedKeys);
  }

  return buildTrustStatus(conversation, currentUserId, nextTrustedKeys);
}

export async function trustConversationKeys(
  conversation: E2EEConversation,
  currentUserId: string,
): Promise<E2EEKeyTrustStatus> {
  const trustedKeys = await getTrustedPublicKeys(currentUserId);
  const nextTrustedKeys = { ...trustedKeys };

  for (const member of conversation.members || []) {
    if (member.id === currentUserId) continue;
    const publicKey = (member.e2ee_public_key || '').trim();
    if (publicKey) {
      nextTrustedKeys[member.id] = publicKey;
    }
  }

  await setTrustedPublicKeys(currentUserId, nextTrustedKeys);
  return buildTrustStatus(conversation, currentUserId, nextTrustedKeys);
}

export async function encryptTextForConversation(
  plaintext: string,
  conversation: E2EEConversation,
  currentUserId: string,
): Promise<{ content: string; encrypted: true; e2ee: E2EEPayload } | null> {
  if (!isConversationE2EEReady(conversation, currentUserId)) return null;

  const identity = await ensureE2EEIdentity(currentUserId);
  await api.post('/e2ee/keys', {
    public_key: identity.publicKey,
    algorithm: identity.algorithm,
  });
  const senderSecretKey = base64ToBytes(identity.secretKey);
  const messageBytes = utf8ToBytes(plaintext);
  const recipients: E2EEPayload['recipients'] = {};

  for (const member of conversation.members) {
    const publicKey = member.id === currentUserId ? identity.publicKey : member.e2ee_public_key;
    if (!publicKey) return null;
    const nonce = await Crypto.getRandomBytesAsync(nacl.box.nonceLength);
    const ciphertext = nacl.box(
      messageBytes,
      nonce,
      base64ToBytes(publicKey),
      senderSecretKey,
    );
    recipients[member.id] = {
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
    };
  }

  return {
    content: PLACEHOLDER,
    encrypted: true,
    e2ee: {
      version: 1,
      algorithm: ALGORITHM,
      sender_public_key: identity.publicKey,
      recipients,
    },
  };
}

export async function encryptAttachmentForConversation(
  base64Data: string,
  mime: string,
  conversation: E2EEConversation,
  currentUserId: string,
): Promise<{ data: string; e2ee_attachment: E2EEAttachmentPayload } | null> {
  if (!isConversationE2EEReady(conversation, currentUserId)) return null;

  const identity = await ensureE2EEIdentity(currentUserId);
  await api.post('/e2ee/keys', {
    public_key: identity.publicKey,
    algorithm: identity.algorithm,
  });

  const fileKey = await Crypto.getRandomBytesAsync(nacl.secretbox.keyLength);
  const fileNonce = await Crypto.getRandomBytesAsync(nacl.secretbox.nonceLength);
  const plaintextBytes = base64ToBytes(base64Data);
  const ciphertext = nacl.secretbox(plaintextBytes, fileNonce, fileKey);
  const senderSecretKey = base64ToBytes(identity.secretKey);
  const keyRecipients: E2EEAttachmentPayload['key_recipients'] = {};

  for (const member of conversation.members) {
    const publicKey = member.id === currentUserId ? identity.publicKey : member.e2ee_public_key;
    if (!publicKey) return null;
    const keyNonce = await Crypto.getRandomBytesAsync(nacl.box.nonceLength);
    const wrappedKey = nacl.box(
      fileKey,
      keyNonce,
      base64ToBytes(publicKey),
      senderSecretKey,
    );
    keyRecipients[member.id] = {
      nonce: bytesToBase64(keyNonce),
      ciphertext: bytesToBase64(wrappedKey),
    };
  }

  return {
    data: bytesToBase64(ciphertext),
    e2ee_attachment: {
      version: 1,
      algorithm: 'nacl-secretbox-v1',
      nonce: bytesToBase64(fileNonce),
      mime,
      size: plaintextBytes.length,
      key_recipients: keyRecipients,
    },
  };
}

export async function decryptMessageForUser<T extends E2EEMessageLike>(
  message: T,
  currentUserId: string | null | undefined,
): Promise<T> {
  if (!message.e2ee) return message;
  if (!currentUserId || message.e2ee.algorithm !== ALGORITHM) {
    return { ...message, content: E2EE_UNAVAILABLE_TEXT, e2ee_decrypted: false };
  }

  const identity = await getStoredIdentity(currentUserId);
  const recipient = message.e2ee.recipients?.[currentUserId];
  if (!identity || !recipient) {
    return { ...message, content: E2EE_UNAVAILABLE_TEXT, e2ee_decrypted: false };
  }

  try {
    const opened = nacl.box.open(
      base64ToBytes(recipient.ciphertext),
      base64ToBytes(recipient.nonce),
      base64ToBytes(message.e2ee.sender_public_key),
      base64ToBytes(identity.secretKey),
    );
    if (!opened) {
      return { ...message, content: E2EE_UNAVAILABLE_TEXT, e2ee_decrypted: false };
    }
    return { ...message, content: bytesToUtf8(opened), e2ee_decrypted: true };
  } catch {
    return { ...message, content: E2EE_UNAVAILABLE_TEXT, e2ee_decrypted: false };
  }
}

export async function decryptMessagesForUser<T extends E2EEMessageLike>(
  messages: T[],
  currentUserId: string | null | undefined,
): Promise<T[]> {
  return Promise.all(messages.map((message) => decryptMessageForUser(message, currentUserId)));
}

export async function decryptAttachmentForUser(
  base64Data: string,
  payload: E2EEAttachmentPayload | null | undefined,
  message: E2EEMessageLike,
  currentUserId: string | null | undefined,
): Promise<{ data: string; mime: string } | null> {
  if (!payload) return { data: base64Data, mime: '' };
  if (
    !currentUserId ||
    payload.algorithm !== 'nacl-secretbox-v1' ||
    !message.e2ee ||
    message.e2ee.algorithm !== ALGORITHM
  ) {
    return null;
  }

  const identity = await getStoredIdentity(currentUserId);
  const wrappedKey = payload.key_recipients?.[currentUserId];
  if (!identity || !wrappedKey) return null;

  try {
    const fileKey = nacl.box.open(
      base64ToBytes(wrappedKey.ciphertext),
      base64ToBytes(wrappedKey.nonce),
      base64ToBytes(message.e2ee.sender_public_key),
      base64ToBytes(identity.secretKey),
    );
    if (!fileKey) return null;

    const opened = nacl.secretbox.open(
      base64ToBytes(base64Data),
      base64ToBytes(payload.nonce),
      fileKey,
    );
    if (!opened) return null;
    return { data: bytesToBase64(opened), mime: payload.mime };
  } catch {
    return null;
  }
}
