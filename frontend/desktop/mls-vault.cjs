const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicWrite(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
function createVault(directory, safeStorage) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  function paths(user) {
    if (typeof user !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(user)) throw new Error('Invalid MLS account');
    return { key: path.join(directory, `${user}.key`), state: path.join(directory, `${user}.vault`) };
  }
  function keyFor(files) {
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('An OS-protected key store is required for MLS');
    if (!fs.existsSync(files.key)) {
      if (fs.existsSync(files.state)) throw new Error('MLS key missing; refusing identity replacement');
      const secret = crypto.randomBytes(32);
      try { atomicWrite(files.key, safeStorage.encryptString(secret.toString('base64'))); } finally { secret.fill(0); }
    }
    return Buffer.from(safeStorage.decryptString(fs.readFileSync(files.key)), 'base64');
  }
  function revision(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
  return {
    load(user) {
      const files = paths(user);
      if (!fs.existsSync(files.state) && !fs.existsSync(files.key)) return { state: null, revision: null };
      const key = keyFor(files);
      try {
        if (!fs.existsSync(files.state)) return { state: null, revision: null };
        const bytes = fs.readFileSync(files.state);
        if (bytes.length < 28 || bytes.length > 64 * 1024 * 1024) throw new Error('Invalid MLS vault size');
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
        cipher.setAAD(Buffer.from(`ghostel-mls-v1:${user}`)); cipher.setAuthTag(bytes.subarray(12,28));
        const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
        try { return { state: JSON.parse(plain.toString('utf8')), revision: revision(bytes) }; } finally { plain.fill(0); }
      } finally { key.fill(0); }
    },
    save(user, expectedRevision, state) {
      const files = paths(user), key = keyFor(files);
      try {
        const current = fs.existsSync(files.state) ? revision(fs.readFileSync(files.state)) : null;
        if (current !== expectedRevision) throw new Error('Concurrent MLS vault modification');
        if (state?.device?.user_id !== user || state.version !== 1) throw new Error('MLS account binding mismatch');
        const plain = Buffer.from(JSON.stringify(state));
        try {
          if (plain.length > 64 * 1024 * 1024 - 28) throw new Error('MLS vault size limit');
          const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
          cipher.setAAD(Buffer.from(`ghostel-mls-v1:${user}`));
          const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
          const bytes = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]); atomicWrite(files.state, bytes); return revision(bytes);
        } finally { plain.fill(0); }
      } finally { key.fill(0); }
    },
  };
}
module.exports = { createVault };
