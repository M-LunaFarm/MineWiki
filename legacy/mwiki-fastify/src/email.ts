import { google } from 'googleapis';
import { config } from './config.js';

function encodeHeader(value: string) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function encodeAddress(name: string, email: string) {
  return `${encodeHeader(name)} <${email}>`;
}

function base64Url(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function htmlEscape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function gmailClient() {
  if (!config.gmail.clientId || !config.gmail.clientSecret || !config.gmail.refreshToken) {
    throw new Error('gmail_not_configured');
  }
  const auth = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri
  );
  auth.setCredentials({ refresh_token: config.gmail.refreshToken });
  return google.gmail({ version: 'v1', auth });
}

export async function sendVerificationEmail(to: string, displayName: string, verificationUrl: string) {
  await sendActionEmail({
    to,
    subject: 'MineWiki 이메일 인증',
    text: [
      `${displayName}님, MineWiki 가입을 완료하려면 아래 링크를 열어 이메일을 인증하세요.`,
      '',
      verificationUrl,
      '',
      '본인이 요청하지 않았다면 이 메일을 무시해도 됩니다.'
    ],
    html: [
      `<p>${htmlEscape(displayName)}님, MineWiki 가입을 완료하려면 이메일 인증이 필요합니다.</p>`,
      `<p><a href="${htmlEscape(verificationUrl)}" style="display:inline-block;padding:10px 14px;background:#3366cc;color:#fff;text-decoration:none;border-radius:4px">이메일 인증하기</a></p>`,
      `<p>버튼이 열리지 않으면 아래 주소를 브라우저에 붙여넣으세요.</p><p>${htmlEscape(verificationUrl)}</p>`,
      '<p>본인이 요청하지 않았다면 이 메일을 무시해도 됩니다.</p>'
    ]
  });
}

export async function sendPasswordResetEmail(to: string, displayName: string, resetUrl: string) {
  await sendActionEmail({
    to,
    subject: 'MineWiki 비밀번호 재설정',
    text: [
      `${displayName}님, MineWiki 비밀번호를 다시 설정하려면 아래 링크를 여세요.`,
      '',
      resetUrl,
      '',
      '본인이 요청하지 않았다면 이 메일을 무시해도 됩니다.'
    ],
    html: [
      `<p>${htmlEscape(displayName)}님, MineWiki 비밀번호 재설정 요청이 접수되었습니다.</p>`,
      `<p><a href="${htmlEscape(resetUrl)}" style="display:inline-block;padding:10px 14px;background:#3366cc;color:#fff;text-decoration:none;border-radius:4px">비밀번호 재설정</a></p>`,
      `<p>버튼이 열리지 않으면 아래 주소를 브라우저에 붙여넣으세요.</p><p>${htmlEscape(resetUrl)}</p>`,
      '<p>본인이 요청하지 않았다면 이 메일을 무시해도 됩니다.</p>'
    ]
  });
}

async function sendActionEmail(input: { to: string; subject: string; text: string[]; html: string[] }) {
  const boundary = `minewiki-${Date.now().toString(36)}`;
  const text = input.text.join('\r\n');
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#202122">',
    ...input.html,
    '</body></html>'
  ].join('');
  const message = [
    `From: ${encodeAddress(config.gmail.senderName, config.gmail.senderEmail)}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}--`,
    ''
  ].join('\r\n');

  await gmailClient().users.messages.send({
    userId: 'me',
    requestBody: {
      raw: base64Url(message)
    }
  });
}
