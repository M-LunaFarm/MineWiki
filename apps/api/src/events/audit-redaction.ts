import { Prisma } from '@prisma/client';

const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|credential|cookie)/i;

export function toAuditJson(value: unknown): Prisma.InputJsonValue {
  return redactAuditValue(value) as Prisma.InputJsonValue;
}

export function redactAuditValue(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key) && !isSafeAggregate(key, value)) return REDACTED;
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactValue(entryValue, entryKey);
    }
    return output;
  }
  if (typeof value === 'string') return sanitizeStringValue(value);
  if (['number', 'boolean'].includes(typeof value)) return value;
  return String(value);
}

function isSafeAggregate(key: string, value: unknown): boolean {
  return typeof value === 'number' && (key.endsWith('Count') || key === 'disabledPluginCredentials');
}

function sanitizeStringValue(value: string): string {
  if (!/[?&](verifyToken|completionToken|token|secret|access_token|refresh_token)=/i.test(value)) return value;
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key) || key === 'access_token' || key === 'refresh_token') parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    return value.replace(
      /([?&][^=]*(?:token|secret|authorization|access_token|refresh_token)[^=]*=)([^&]+)/gi,
      `$1${encodeURIComponent(REDACTED)}`,
    );
  }
}
