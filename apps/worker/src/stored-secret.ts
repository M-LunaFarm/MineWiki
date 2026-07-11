import { decryptSecret, isEncryptedSecret } from '@minewiki/security';

export function decryptStoredSecret(value: string | null | undefined): string | null {
  if (!value || !isEncryptedSecret(value)) {
    return value ?? null;
  }
  const key = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new Error('APP_ENCRYPTION_KEY is required to load encrypted worker credentials.');
  }
  return decryptSecret(value, key);
}
