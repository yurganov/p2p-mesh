import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes, utf8ToBytes, sha256 };

export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
export const randHex = (n) => bytesToHex(rand(n));

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export function encrypt(key, obj) {
  const nonce = rand(12);
  const ct = gcm(key, nonce).encrypt(utf8ToBytes(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce);
  out.set(ct, 12);
  return out;
}
export function decrypt(key, blob) {
  const pt = gcm(key, blob.subarray(0, 12)).decrypt(blob.subarray(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

export const now = () => performance.now();
export const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
export const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
export const ms = (v) => (v == null ? '--' : v < 10 ? v.toFixed(1) : String(Math.round(v)));
