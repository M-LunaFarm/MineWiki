import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly transporter?: Transporter;
  private readonly from?: string;
  private readonly logger = new Logger(EmailService.name);

  constructor(config: ConfigService) {
    const host = config.getOptional('SMTP_HOST');
    if (!host) {
      return;
    }
    const port = config.getNumber('SMTP_PORT', 587);
    const secure = config.getOptional('SMTP_SECURE') === 'true' || port === 465;
    const user = config.getOptional('SMTP_USER');
    const pass = config.getOptional('SMTP_PASS');

    this.from = config.getOptional('SMTP_FROM');
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  }

  isEnabled(): boolean {
    return Boolean(this.transporter && this.from);
  }

  async sendVerificationEmail(payload: {
    email: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    if (!this.transporter || !this.from) {
      throw new Error('SMTP is not configured.');
    }

    const subject = 'MineWiki Servers email verification';
    const expiresAt = payload.expiresAt.toISOString();
    const text = [
      'Your MineWiki Servers verification code:',
      payload.token,
      '',
      `Expires at: ${expiresAt}`
    ].join('\n');

    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject,
      text
    });
  }

  async sendPasswordResetEmail(payload: {
    email: string;
    token: string;
    expiresAt: Date;
    resetUrl?: string;
  }): Promise<void> {
    if (!this.transporter || !this.from) {
      throw new Error('SMTP is not configured.');
    }

    const subject = 'MineWiki Servers password reset';
    const expiresAt = payload.expiresAt.toISOString();
    const lines = [
      'Your MineWiki Servers password reset code:',
      payload.token,
      '',
      payload.resetUrl ? `Reset link: ${payload.resetUrl}` : undefined,
      `Expires at: ${expiresAt}`
    ].filter(Boolean);

    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject,
      text: lines.join('\n')
    });
  }

  logDeliveryFailure(error: unknown): void {
    this.logger.warn({ err: error }, 'Email delivery failed');
  }
}
