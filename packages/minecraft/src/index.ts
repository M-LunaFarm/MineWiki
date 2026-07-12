import { z } from 'zod';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export const minecraftUuidSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
    'Invalid Minecraft UUID',
  )
  .transform((value) => normalizeMinecraftUuid(value));

export const minecraftNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(16)
  .regex(/^[A-Za-z0-9_]+$/);

export function normalizeMinecraftUuid(raw: string): string {
  const normalized = raw.replace(/-/g, '').trim().toLowerCase();
  if (normalized.length !== 32 || /[^0-9a-f]/u.test(normalized)) {
    throw new Error('Invalid Minecraft UUID');
  }
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join('-');
}

export function normalizeMinecraftName(raw: string): string {
  return minecraftNameSchema.parse(raw);
}

export function normalizeMinecraftServerHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Minecraft server host is required');
  }
  if (
    trimmed.includes('://') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('@') ||
    /\s/u.test(trimmed)
  ) {
    throw new Error('Minecraft server host must not include a URL, path, credentials, or spaces');
  }

  const unwrapped = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  const withoutTrailingDot = unwrapped.replace(/\.+$/u, '');
  if (isIP(withoutTrailingDot) !== 0) {
    return withoutTrailingDot.toLowerCase();
  }
  if (withoutTrailingDot.includes(':')) {
    throw new Error('Minecraft server port must be entered separately');
  }

  const ascii = domainToASCII(withoutTrailingDot.toLowerCase());
  if (!ascii || ascii.length > 253) {
    throw new Error('Minecraft server host is invalid');
  }
  if (
    !ascii.includes('.') ||
    ascii === 'localhost' ||
    ascii.endsWith('.localhost') ||
    ascii.endsWith('.local') ||
    ascii.endsWith('.internal') ||
    ascii.endsWith('.lan')
  ) {
    throw new Error('Minecraft server host must be a public domain or IP address');
  }
  const labels = ascii.split('.');
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new Error('Minecraft server host is invalid');
  }
  return ascii;
}
