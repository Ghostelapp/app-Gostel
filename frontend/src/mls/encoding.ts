const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function b64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=') + (i + 2 < bytes.length ? alphabet[n & 63] : '=');
  }
  return out;
}
export function unb64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 4) {
    const n = (alphabet.indexOf(value[i]) << 18) | (alphabet.indexOf(value[i + 1]) << 12) | (Math.max(0, alphabet.indexOf(value[i + 2])) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]));
    out.push((n >>> 16) & 255); if (value[i + 2] !== '=') out.push((n >>> 8) & 255); if (value[i + 3] !== '=') out.push(n & 255);
  }
  const bytes = new Uint8Array(out); if (b64(bytes) !== value) throw new Error('Non-canonical base64'); return bytes;
}
export function utf8(value: string): Uint8Array { return Uint8Array.from(unescape(encodeURIComponent(value)), c => c.charCodeAt(0)); }
export function text(value: Uint8Array): string { return decodeURIComponent(escape(Array.from(value, c => String.fromCharCode(c)).join(''))); }
