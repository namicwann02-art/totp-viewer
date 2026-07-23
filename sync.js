// Encrypted sync via Telegram Cloud Storage.
// Telegram only ever sees the AES-GCM ciphertext — the passphrase that
// derives the decryption key is never sent anywhere, it only lives in
// this page's memory for the current session.

const META_KEY = 'totp_sync_meta';
const CHUNK_PREFIX = 'totp_sync_chunk_';
const MAX_CHUNK_CHARS = 3500; // Telegram CloudStorage value limit is 4096 chars

function hasCloudStorage() {
  return !!(window.Telegram?.WebApp?.CloudStorage);
}

function cloudGetItem(key) {
  return new Promise((resolve, reject) => {
    window.Telegram.WebApp.CloudStorage.getItem(key, (err, value) => {
      if (err) reject(new Error(err));
      else resolve(value || null);
    });
  });
}

function cloudGetItems(keys) {
  return new Promise((resolve, reject) => {
    window.Telegram.WebApp.CloudStorage.getItems(keys, (err, values) => {
      if (err) reject(new Error(err));
      else resolve(values || {});
    });
  });
}

function cloudSetItem(key, value) {
  return new Promise((resolve, reject) => {
    window.Telegram.WebApp.CloudStorage.setItem(key, value, (err, ok) => {
      if (err) reject(new Error(err));
      else resolve(ok);
    });
  });
}

function cloudRemoveItems(keys) {
  if (keys.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.Telegram.WebApp.CloudStorage.removeItems(keys, (err, ok) => {
      if (err) reject(new Error(err));
      else resolve(ok);
    });
  });
}

// --- crypto helpers ---

function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

function bytesToB64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 600000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptJSON(obj, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(ciphertext)),
  };
}

// Throws if the passphrase is wrong (AES-GCM auth tag check fails).
async function decryptJSON(envelope, passphrase) {
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const key = await deriveKey(passphrase, salt);
  const ciphertext = b64ToBytes(envelope.data);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// --- remote read/write (chunked to fit Telegram's per-key size limit) ---

async function fetchRemoteEnvelope() {
  const metaRaw = await cloudGetItem(META_KEY);
  if (!metaRaw) return null;
  const meta = JSON.parse(metaRaw);
  const chunkKeys = Array.from({ length: meta.chunks }, (_, i) => CHUNK_PREFIX + i);
  const values = await cloudGetItems(chunkKeys);
  const data = chunkKeys.map(k => values[k] || '').join('');
  return { salt: meta.salt, iv: meta.iv, data };
}

async function pullAccounts(passphrase) {
  const envelope = await fetchRemoteEnvelope();
  if (!envelope) return null; // no remote vault yet
  return decryptJSON(envelope, passphrase);
}

async function pushAccounts(accounts, passphrase) {
  const envelope = await encryptJSON(accounts, passphrase);
  const chunks = [];
  for (let i = 0; i < envelope.data.length; i += MAX_CHUNK_CHARS) {
    chunks.push(envelope.data.slice(i, i + MAX_CHUNK_CHARS));
  }

  const prevMetaRaw = await cloudGetItem(META_KEY);
  const prevChunkCount = prevMetaRaw ? JSON.parse(prevMetaRaw).chunks : 0;

  for (let i = 0; i < chunks.length; i++) {
    await cloudSetItem(CHUNK_PREFIX + i, chunks[i]);
  }
  if (prevChunkCount > chunks.length) {
    const staleKeys = [];
    for (let i = chunks.length; i < prevChunkCount; i++) staleKeys.push(CHUNK_PREFIX + i);
    await cloudRemoveItems(staleKeys);
  }
  await cloudSetItem(META_KEY, JSON.stringify({ salt: envelope.salt, iv: envelope.iv, chunks: chunks.length }));
}

async function remoteVaultExists() {
  const metaRaw = await cloudGetItem(META_KEY);
  return !!metaRaw;
}

window.Sync = { hasCloudStorage, pullAccounts, pushAccounts, remoteVaultExists };
