import { decryptSecret, encryptSecret, isEncryptedSecret } from '@minewiki/security';

export function encryptAppSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const key = encryptionKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_ENCRYPTION_KEY is required to store secrets in production.');
    }
    return value;
  }
  return encryptSecret(value, key);
}

export function decryptAppSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (!isEncryptedSecret(value)) {
    return value;
  }
  const key = encryptionKey();
  if (!key) {
    throw new Error('APP_ENCRYPTION_KEY is required to read encrypted secrets.');
  }
  return decryptSecret(value, key);
}

function encryptionKey(): string | undefined {
  const key = process.env.APP_ENCRYPTION_KEY?.trim();
  return key || undefined;
}
