import { z } from 'zod';

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
