import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export function normalizeContactEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254) {
    throw new BadRequestException({ code: 'contact_email_invalid', message: '올바른 이메일을 입력해 주세요.' });
  }
  return normalized;
}

export function accountGroupFingerprint(accountIds: readonly string[]): string {
  return hashContactValue([...accountIds].sort().join('\n'));
}

export function hashContactValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function maskContactEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export function invalidContactEmailToken(): BadRequestException {
  return new BadRequestException({ code: 'contact_email_change_token_invalid', message: '유효하지 않거나 만료된 이메일 변경 토큰입니다.' });
}
