import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpCodeAt(secret: string, timestampMs = Date.now()): string {
  return totpCodeForStep(secret, totpStep(timestampMs));
}

export function verifyTotpCode(
  secret: string,
  code: string,
  timestampMs = Date.now(),
  window = 1,
): bigint | null {
  if (!Number.isInteger(window) || window < 0 || window > 2) return null;
  if (!/^\d{6}$/.test(code)) return null;
  const expected = Buffer.from(code);
  const current = totpStep(timestampMs);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + BigInt(offset);
    if (step < 0n) continue;
    const candidate = Buffer.from(totpCodeForStep(secret, step));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return step;
  }
  return null;
}

export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new RangeError('Recovery code count must be between 1 and 20.');
  }
  return Array.from({ length: count }, () => {
    const raw = encodeBase32(randomBytes(10));
    return raw.match(/.{1,4}/g)!.join('-');
  });
}

export function normalizeRecoveryCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z2-7]{4}(?:[- ]?[A-Z2-7]{4}){3}$/.test(normalized)) return '';
  return normalized.replace(/[- ]/g, '');
}

export function hashRecoveryCode(value: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(value)).digest('hex');
}

function totpStep(timestampMs: number): bigint {
  return BigInt(Math.floor(timestampMs / 1000 / TOTP_PERIOD_SECONDS));
}

function totpCodeForStep(secret: string, step: bigint): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(step);
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** TOTP_DIGITS);
  return value.toString().padStart(TOTP_DIGITS, '0');
}

function encodeBase32(value: Buffer): string {
  let bits = 0;
  let buffer = 0;
  let output = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new Error('Invalid TOTP secret.');
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
