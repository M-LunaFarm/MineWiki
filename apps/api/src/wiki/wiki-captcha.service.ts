import { BadRequestException, Injectable } from '@nestjs/common';
import { CaptchaService } from '../captcha/captcha.service';

@Injectable()
export class WikiCaptchaService {
  constructor(private readonly captcha: CaptchaService) {}

  isRequired(): boolean {
    return this.captcha.isCaptchaRequired();
  }

  async assertVerified(token?: string | null, remoteIp?: string | null): Promise<void> {
    if (!this.isRequired()) return;
    const result = await this.captcha.verifyCaptcha(token, remoteIp ?? undefined);
    if (result.success) return;
    throw new BadRequestException({
      message: '새 Wiki 콘텐츠를 만들기 전에 로봇 방지 확인을 완료해 주세요.',
      code: 'WIKI_CAPTCHA_REQUIRED',
    });
  }
}
