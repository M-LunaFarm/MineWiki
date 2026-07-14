import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { fetchWithTimeout } from '../common/http/external-fetch';

interface CaptchaVerificationResult {
  readonly success: boolean;
  readonly errors?: string[];
}

@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);
  private readonly turnstileSecret: string | undefined;
  private readonly hcaptchaSecret: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.turnstileSecret = normalizeSecret(this.config.getOptional('TURNSTILE_SECRET_KEY'));
    this.hcaptchaSecret = normalizeSecret(this.config.getOptional('HCAPTCHA_SECRET_KEY'));
  }

  isTurnstileEnabled(): boolean {
    return Boolean(this.turnstileSecret);
  }

  isHCaptchaEnabled(): boolean {
    return Boolean(this.hcaptchaSecret);
  }

  isCaptchaRequired(): boolean {
    return this.isTurnstileEnabled() || this.isHCaptchaEnabled();
  }

  async verifyCaptcha(
    token?: string | null,
    remoteIp?: string
  ): Promise<CaptchaVerificationResult> {
    if (!this.isCaptchaRequired()) {
      return { success: true };
    }

    const normalized = token?.trim();
    if (!normalized || normalized.length < 10) {
      return { success: false, errors: ['missing_token'] };
    }

    if (this.isTurnstileEnabled()) {
      const result = await this.validateTurnstile(normalized, remoteIp);
      if (result.success || !this.isHCaptchaEnabled()) {
        return result;
      }
    }

    if (this.isHCaptchaEnabled()) {
      return this.validateHCaptcha(normalized, remoteIp);
    }

    return { success: false, errors: ['verification_unavailable'] };
  }

  async validateTurnstile(
    token?: string | null,
    remoteIp?: string
  ): Promise<CaptchaVerificationResult> {
    if (!this.turnstileSecret) {
      return { success: true };
    }

    if (!token || token.trim().length < 10) {
      return { success: false, errors: ['missing_token'] };
    }

    const params = new URLSearchParams({
      secret: this.turnstileSecret,
      response: token
    });
    if (remoteIp) {
      params.append('remoteip', remoteIp);
    }

    try {
      const response = await fetchWithTimeout('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          'Turnstile verification failed'
        );
        return { success: false, errors: ['gateway_error'] };
      }

      const result = (await response.json()) as CaptchaVerificationResult;
      if (!result.success) {
        this.logger.warn(
          { remoteIp, errors: result.errors },
          'Turnstile token rejected'
        );
      }
      return result;
    } catch (error) {
      this.logger.error({ err: error }, 'Turnstile verification network error');
      return { success: false, errors: ['network_error'] };
    }
  }

  async validateHCaptcha(
    token?: string | null,
    remoteIp?: string
  ): Promise<CaptchaVerificationResult> {
    if (!this.hcaptchaSecret) {
      return { success: true };
    }

    if (!token || token.trim().length < 10) {
      return { success: false, errors: ['missing_token'] };
    }

    const params = new URLSearchParams({
      secret: this.hcaptchaSecret,
      response: token
    });
    if (remoteIp) {
      params.append('remoteip', remoteIp);
    }

    try {
      const response = await fetchWithTimeout('https://hcaptcha.com/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          'hCaptcha verification failed'
        );
        return { success: false, errors: ['gateway_error'] };
      }

      const result = (await response.json()) as {
        success?: boolean;
        'error-codes'?: string[];
      };

      if (!result.success) {
        this.logger.warn(
          { remoteIp, errors: result['error-codes'] },
          'hCaptcha token rejected'
        );
        return { success: false, errors: result['error-codes'] };
      }

      return { success: true };
    } catch (error) {
      this.logger.error({ err: error }, 'hCaptcha verification network error');
      return { success: false, errors: ['network_error'] };
    }
  }
}

function normalizeSecret(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
