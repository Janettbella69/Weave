const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
const bytes = value => Uint8Array.from(value.match(/.{2}/g) || [], x => parseInt(x,16));
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(24)));
export async function hash(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))); }
async function key(secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) throw Error('服务端尚未配置密钥加密，请联系管理员');
  return crypto.subtle.importKey('raw',bytes(secret),'AES-GCM',false,['encrypt','decrypt']);
}
export async function seal(value, secret, owner) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(owner)},await key(secret),encoder.encode(value));
  return hex(iv)+':'+hex(new Uint8Array(encrypted));
}
export async function unseal(value, secret, owner) {
  const [iv,cipher]=value.split(':');
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(owner)},await key(secret),bytes(cipher)));
}
// The same key and AES-GCM as seal(), for bytes (a WeChat photo) that should not be turned into text first.
export async function sealBytes(value, secret, owner) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(owner)},await key(secret),value);
  return {iv:hex(iv),data:new Uint8Array(encrypted)};
}
export async function unsealBytes({iv,data}, secret, owner) {
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:encoder.encode(owner)},await key(secret),data));
}
