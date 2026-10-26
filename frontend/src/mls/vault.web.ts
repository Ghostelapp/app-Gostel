import type { Vault } from './types';
declare global { interface Window { ghostelMLSVault?: { load(user: string): Promise<{state: Vault | null; revision: string | null}>; save(user: string, revision: string | null, state: Vault): Promise<string> } } }
const desktopTails = new Map<string, Promise<unknown>>();
const DB = 'ghostel-mls-v1';
function request<T>(r: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
async function database(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('vaults'); return request(r);
}
function complete(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('MLS transaction aborted')); }); }
export async function withVault<T>(user: string, action: (state: Vault | null, save: (state: Vault) => Promise<void>) => Promise<T>): Promise<T> {
  const desktop = window.ghostelMLSVault;
  if (desktop) {
    const previous = desktopTails.get(user) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const stored = await desktop.load(user); let revision = stored.revision;
      return action(stored.state, async next => { revision = await desktop.save(user, revision, next); });
    });
    desktopTails.set(user, job);
    try { return await job; } finally { if (desktopTails.get(user) === job) desktopTails.delete(user); }
  }
  if (!navigator.locks || !globalThis.crypto?.subtle) throw new Error('MLS needs a secure browser context and exclusive storage locks');
  return navigator.locks.request(`${DB}:${user}`, async () => {
    const db = await database();
    try {
      const stored: any = await request(db.transaction('vaults').objectStore('vaults').get(user));
      const key: CryptoKey = stored?.key || await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const aad = new TextEncoder().encode(`${DB}:${user}`);
      let state: Vault | null = null;
      if (stored) {
        const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.nonce, additionalData: aad }, key, stored.ciphertext);
        try { state = JSON.parse(new TextDecoder().decode(bytes)); } finally { new Uint8Array(bytes).fill(0); }
      }
      return await action(state, async next => {
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const plain = new TextEncoder().encode(JSON.stringify(next));
        let ciphertext: ArrayBuffer;
        try { ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plain); } finally { plain.fill(0); }
        const tx = db.transaction('vaults', 'readwrite', { durability: 'strict' }); const done = complete(tx);
        tx.objectStore('vaults').put({ key, nonce, ciphertext }, user); await done;
      });
    } finally { db.close(); }
  });
}
