import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  normalizeServerWikiContentSettings,
  renderServerWikiPresentation,
  sourceAuditSummary,
} from './server-wiki-content-settings';

const emptySettings = {
  expectedVersion: 0,
  contributionPolicySource: null,
  editHelpSource: null,
  topNoticeSource: null,
  bottomNoticeSource: null,
  requireContributionPolicyAck: false,
};

test('server wiki presentation renders only restricted safe markup', () => {
  const rendered = renderServerWikiPresentation({
    contributionPolicySource: '== 기여 정책 ==\n * 예의를 지켜 주세요.\n * [[도움말:문법|문법 도움말]]',
    editHelpSource: "'''요약'''을 구체적으로 작성해 주세요.",
    topNoticeSource: '[https://minewiki.kr MineWiki] 공식 서버 문서입니다.',
    bottomNoticeSource: '문의: support@minewiki.kr',
  });

  assert.match(rendered.policyHtml ?? '', /기여 정책/u);
  assert.match(rendered.policyHtml ?? '', /wiki-list/u);
  assert.match(rendered.editHelpHtml ?? '', /<strong>요약<\/strong>/u);
  assert.match(rendered.topNoticeHtml ?? '', /https:\/\/minewiki\.kr/u);
});

test('server wiki presentation rejects active and document-level markup', () => {
  assert.throws(
    () => normalizeServerWikiContentSettings({
      ...emptySettings,
      contributionPolicySource: '[[파일:secret.png]]',
    }),
    hasErrorCode('SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP'),
  );
  assert.throws(
    () => normalizeServerWikiContentSettings({
      ...emptySettings,
      topNoticeSource: '== 공지 제목 ==',
    }),
    hasErrorCode('SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP'),
  );
  assert.throws(
    () => normalizeServerWikiContentSettings({
      ...emptySettings,
      editHelpSource: '[http://example.com 안전하지 않은 링크]',
    }),
    hasErrorCode('SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP'),
  );
  assert.throws(
    () => normalizeServerWikiContentSettings({
      ...emptySettings,
      contributionPolicySource: '> [[파일:secret.png]]',
    }),
    hasErrorCode('SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP'),
  );
  assert.throws(
    () => normalizeServerWikiContentSettings({
      ...emptySettings,
      topNoticeSource: '>  * 공지에서는 목록 금지',
    }),
    hasErrorCode('SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP'),
  );
});

function hasErrorCode(code: string) {
  return (error: unknown): boolean => {
    if (!(error instanceof BadRequestException)) return false;
    const response = error.getResponse();
    return typeof response === 'object' && response !== null && 'code' in response
      && response.code === code;
  };
}

test('empty policy disables mandatory acknowledgement and source audit contains no raw text', () => {
  const normalized = normalizeServerWikiContentSettings({
    ...emptySettings,
    contributionPolicySource: '  \r\n ',
    requireContributionPolicyAck: true,
  });
  assert.equal(normalized.contributionPolicySource, null);
  assert.equal(normalized.requireContributionPolicyAck, false);

  const audit = sourceAuditSummary('private policy body');
  assert.equal(audit.bytes, 19);
  assert.match(audit.sha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(audit).includes('private policy body'), false);
});
