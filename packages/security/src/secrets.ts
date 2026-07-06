import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const SECRET_PREFIX = 'enc:v1:';
const IV_BYTES = 12;

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(SECRET_PREFIX));
}

export function encryptSecret(value: string, keyMaterial: string): string {
  if (isEncryptedSecret(value)) {
    return value;
  }
  const key = normalizeKey(keyMaterial);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

export function decryptSecret(value: string, keyMaterial: string): string {
  if (!isEncryptedSecret(value)) {
    return value;
  }
  const key = normalizeKey(keyMaterial);
  const payload = Buffer.from(value.slice(SECRET_PREFIX.length), 'base64url');
  if (payload.length <= IV_BYTES + 16) {
    throw new Error('Encrypted secret payload is invalid.');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = payload.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeKey(keyMaterial: string): Buffer {
  const trimmed = keyMaterial.trim();
  if (!trimmed) {
    throw new Error('Encryption key is required.');
  }
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // Fall through to hashing arbitrary key material.
  }
  return createHash('sha256').update(trimmed).digest();
}
