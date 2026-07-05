import { BadRequestException } from '@nestjs/common';

export function decodeBase64(input: string): Buffer {
  const trimmed = input.trim();
  const commaIndex = trimmed.indexOf(',');
  const payload = commaIndex >= 0 ? trimmed.slice(commaIndex + 1) : trimmed;
  try {
    return Buffer.from(payload, 'base64');
  } catch (error) {
    throw new BadRequestException('이미지 데이터를 디코드할 수 없습니다.');
  }
}
