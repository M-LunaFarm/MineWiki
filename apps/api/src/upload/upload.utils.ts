import { BadRequestException } from '@nestjs/common';

export function decodeBase64(input: string): Buffer {
  const trimmed = input.trim();
  const commaIndex = trimmed.indexOf(',');
  const payload = commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed;
  if (!payload || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)) {
    throw new BadRequestException('파일 데이터를 디코드할 수 없습니다.');
  }
  return Buffer.from(payload, 'base64');
}
