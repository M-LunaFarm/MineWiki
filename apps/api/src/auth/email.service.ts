import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly transporter?: Transporter;
  private readonly from?: string;
  private readonly logger = new Logger(EmailService.name);
  private readonly siteUrl?: string;

  constructor(config: ConfigService) {
    this.siteUrl = config.getOptional('NEXT_PUBLIC_SITE_URL');
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

  async sendContactEmailChangeVerificationEmail(payload: {
    email: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    if (!this.transporter || !this.from) throw new Error('SMTP is not configured.');
    const baseUrl = this.siteUrl?.replace(/\/$/u, '');
    const confirmUrl = baseUrl
      ? `${baseUrl}/me/email-change/confirm?token=${encodeURIComponent(payload.token)}`
      : undefined;
    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject: 'MineWiki 연락 이메일 변경 확인',
      text: [
        'MineWiki 연락 이메일 변경을 확인해 주세요.',
        confirmUrl ? `확인 링크: ${confirmUrl}` : `확인 코드: ${payload.token}`,
        `만료 시각: ${payload.expiresAt.toISOString()}`,
        '',
        '본인이 요청하지 않았다면 이 메일을 무시해 주세요.'
      ].join('\n')
    });
  }

  async sendContactEmailChangedNotice(payload: {
    email: string;
    newEmailMasked: string;
    changedAt: Date;
  }): Promise<void> {
    if (!this.transporter || !this.from) throw new Error('SMTP is not configured.');
    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject: 'MineWiki 연락 이메일이 변경되었습니다',
      text: [
        `새 연락 이메일: ${payload.newEmailMasked}`,
        `변경 시각: ${payload.changedAt.toISOString()}`,
        '',
        '본인이 변경하지 않았다면 즉시 고객 지원에 문의해 주세요.'
      ].join('\n')
    });
  }

  async sendAccountDeletionCancellationEmail(payload: {
    email: string;
    cancelUrl: string;
    scheduledFor: Date;
  }): Promise<void> {
    if (!this.transporter || !this.from) {
      throw new Error('SMTP is not configured.');
    }
    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject: 'MineWiki 계정 종료 요청 및 취소 안내',
      text: [
        'MineWiki 계정 종료 요청이 접수되었습니다.',
        `처리 예정 시각: ${payload.scheduledFor.toISOString()}`,
        '',
        '14일 유예기간 안에 아래 링크에서 요청을 취소할 수 있습니다.',
        payload.cancelUrl,
        '',
        '본인이 요청하지 않았다면 즉시 취소하고 support@minewiki.kr로 문의해 주세요.'
      ].join('\n')
    });
  }

  async sendServerWikiCollaboratorInvitationEmail(payload: {
    email: string;
    serverName: string;
    roleLabel: string;
    inviterName: string;
    expiresAt: Date;
  }): Promise<void> {
    if (!this.transporter || !this.from) throw new Error('SMTP is not configured.');
    const baseUrl = this.siteUrl?.replace(/\/$/u, '');
    const invitationUrl = baseUrl ? `${baseUrl}/me#server-wiki-invitations` : undefined;
    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject: `${payload.serverName} 서버 위키 협업 초대`,
      text: [
        `${payload.inviterName}님이 ${payload.serverName} 서버 위키의 ${payload.roleLabel} 역할로 초대했습니다.`,
        invitationUrl ? `초대 확인: ${invitationUrl}` : 'MineWiki 내 계정 화면에서 초대를 확인해 주세요.',
        `만료 시각: ${payload.expiresAt.toISOString()}`,
        '',
        '권한은 초대를 수락하기 전까지 부여되지 않습니다.'
      ].join('\n')
    });
  }

  async sendServerOwnershipTransferRequestEmail(payload: {
    email: string;
    serverName: string;
    requesterName: string;
    expiresAt: Date;
  }): Promise<void> {
    if (!this.transporter || !this.from) throw new Error('SMTP is not configured.');
    const baseUrl = this.siteUrl?.replace(/\/$/u, '');
    const requestUrl = baseUrl ? `${baseUrl}/me#server-ownership-transfers` : undefined;
    await this.transporter.sendMail({
      from: this.from,
      to: payload.email,
      subject: `${payload.serverName} 서버 소유권 이전 요청`,
      text: [
        `${payload.requesterName}님이 ${payload.serverName} 서버의 소유권 이전을 요청했습니다.`,
        requestUrl ? `요청 확인: ${requestUrl}` : 'MineWiki 내 계정 화면에서 요청을 확인해 주세요.',
        `만료 시각: ${payload.expiresAt.toISOString()}`,
        '',
        '본인이 수락하기 전에는 서버 권한이 변경되지 않습니다.',
      ].join('\n'),
    });
  }

  logDeliveryFailure(error: unknown): void {
    this.logger.warn({ err: error }, 'Email delivery failed');
  }
}
