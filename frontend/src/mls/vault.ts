import type { SQLiteDatabase } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import nacl from 'tweetnacl';
import { b64, unb64, utf8, text } from './encoding';
import type { Vault } from './types';
let databasePromise: Promise<SQLiteDatabase> | undefined;
function database() {
  return databasePromise ||= import('expo-sqlite').then(async SQLite => {
    const db = await SQLite.openDatabaseAsync('ghostel-mls-v1.db');
    await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; CREATE TABLE IF NOT EXISTS slots (name TEXT PRIMARY KEY NOT NULL, envelope TEXT NOT NULL);');
    return db;
  });
}
async function readSlot(name: string) { return (await (await database()).getFirstAsync<{ envelope: string }>('SELECT envelope FROM slots WHERE name = ?', name))?.envelope || null; }
async function writeSlot(name: string, envelope: string) { await (await database()).runAsync('INSERT INTO slots(name, envelope) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET envelope=excluded.envelope', name, envelope); }
const tails = new Map<string, Promise<unknown>>();
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export async function withVault<T>(user: string, action: (state: Vault | null, save: (state: Vault) => Promise<void>) => Promise<T>): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(user)) throw new Error('Invalid MLS account');
  const previous = tails.get(user) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const name = `ghostel.mls.v1.${user}`;
    const raw = await SecureStore.getItemAsync(name);
    let anchor: { key: string; slot: number; hash: string } | null = raw ? JSON.parse(raw) : null;
    let state: Vault | null = null;
    const key = anchor ? unb64(anchor.key) : await Crypto.getRandomBytesAsync(32);
    try {
      if (anchor) {
        const envelope = await readSlot(`${name}.${anchor.slot}`);
        if (!envelope || await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, envelope) !== anchor.hash) throw new Error('MLS state missing or rolled back. Device recovery is required.');
        const { nonce, ciphertext } = JSON.parse(envelope);
        const plain = nacl.secretbox.open(unb64(ciphertext), unb64(nonce), key);
        if (!plain) throw new Error('MLS vault authentication failed');
        try { state = JSON.parse(text(plain)); } finally { plain.fill(0); }
      }
      return await action(state, async next => {
        if (!anchor && (await readSlot(`${name}.0`) || await readSlot(`${name}.1`))) throw new Error('MLS secure key is missing. Refusing to replace this identity.');
        const nonce = await Crypto.getRandomBytesAsync(24);
        const plain = utf8(JSON.stringify(next));
        let ciphertext: Uint8Array;
        try { ciphertext = nacl.secretbox(plain, nonce, key); } finally { plain.fill(0); }
        const envelope = JSON.stringify({ nonce: b64(nonce), ciphertext: b64(ciphertext) });
        const slot = anchor ? 1 - anchor.slot : 0;
        // Prepare a new encrypted slot first; only the atomic Keychain/Keystore
        // anchor replacement commits it. Never emit a ciphertext before this.
        await writeSlot(`${name}.${slot}`, envelope);
        const nextAnchor = { key: b64(key), slot, hash: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, envelope) };
        await SecureStore.setItemAsync(name, JSON.stringify(nextAnchor), options);
        anchor = nextAnchor;
      });
    } finally { key.fill(0); }
  });
  tails.set(user, job); try { return await job; } finally { if (tails.get(user) === job) tails.delete(user); }
}
