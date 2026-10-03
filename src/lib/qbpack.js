function textToBytes(value) {
  return new TextEncoder().encode(String(value || ''));
}

function bytesToText(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

function bytesFromBase64(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function canStreamBlob() {
  return typeof Blob !== 'undefined' && typeof Blob.prototype.stream === 'function';
}

async function gzipBytes(bytes) {
  if (typeof CompressionStream !== 'function' || !canStreamBlob()) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== 'function' || !canStreamBlob()) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deriveKey(password, salt, usages, kdf = {}) {
  if (!(globalThis.crypto && crypto.subtle)) throw new Error('This browser does not support Web Crypto.');
  const baseKey = await crypto.subtle.importKey('raw', textToBytes(password), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: Number(kdf.iterations) || 250000,
      hash: String(kdf.hash || 'SHA-256'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

export async function encryptQuestionBankPayload(questions, password, options = {}) {
  const plain = textToBytes(JSON.stringify(Array.isArray(questions) ? questions : []));
  const compressed = await gzipBytes(plain);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kdf = {
    name: 'PBKDF2',
    iterations: Number(options.iterations) || 250000,
    hash: 'SHA-256',
  };
  const key = await deriveKey(password, salt, ['encrypt'], kdf);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed));
  return JSON.stringify({
    format: 'qbpack-v1',
    cipher: 'AES-GCM-256',
    compression: typeof CompressionStream === 'function' && canStreamBlob() ? 'gzip' : 'none',
    kdf,
    salt_b64: bytesToBase64(salt),
    iv_b64: bytesToBase64(iv),
    ciphertext_b64: bytesToBase64(ciphertext),
  });
}

export async function decryptQuestionBankPayload(payloadText, password) {
  const envelope = typeof payloadText === 'string' ? JSON.parse(payloadText) : payloadText;
  if (!envelope || envelope.format !== 'qbpack-v1' || envelope.cipher !== 'AES-GCM-256') {
    throw new Error('Unsupported encrypted bank format.');
  }
  const salt = bytesFromBase64(envelope.salt_b64);
  const iv = bytesFromBase64(envelope.iv_b64);
  const ciphertext = bytesFromBase64(envelope.ciphertext_b64);
  const key = await deriveKey(password, salt, ['decrypt'], envelope.kdf || {});
  let decrypted;
  try {
    decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch (_error) {
    throw new Error('Password is incorrect, or this file is damaged.');
  }
  const packed = new Uint8Array(decrypted);
  const plain = envelope.compression === 'gzip' ? await gunzipBytes(packed) : packed;
  const parsed = JSON.parse(bytesToText(plain));
  return Array.isArray(parsed) ? parsed : [];
}
