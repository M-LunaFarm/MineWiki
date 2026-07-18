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
  seoTitle: null,
  seoDescription: null,
  seoIndexingEnabled: true,
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

test('server wiki SEO text is bounded, single-line, and keeps indexing explicit', () => {
  const normalized = normalizeServerWikiContentSettings({
    ...emptySettings,
    seoTitle: '  Example\nWiki\u0000 ',
    seoDescription: ' Public\t documentation ',
    seoIndexingEnabled: false,
  });
  assert.equal(normalized.seoTitle, 'Example Wiki');
  assert.equal(normalized.seoDescription, 'Public documentation');
  assert.equal(normalized.seoIndexingEnabled, false);
  assert.throws(
    () => normalizeServerWikiContentSettings({ ...emptySettings, seoTitle: 'a'.repeat(71) }),
    hasErrorCode('SERVER_WIKI_SEO_TOO_LONG'),
  );
});

test('server wiki presentation keeps bounded indentation compatible with restricted content', () => {
  const rendered = renderServerWikiPresentation({
    contributionPolicySource: '기여 원칙\n 세부 설명',
    editHelpSource: '편집 도움말\n 예시를 확인하세요.',
    topNoticeSource: '공지\n 점검 시간은 02:00입니다.',
    bottomNoticeSource: null,
  });

  assert.match(rendered.policyHtml ?? '', /<div class="wiki-indent"><p>세부 설명<\/p><\/div>/u);
  assert.match(rendered.editHelpHtml ?? '', /<div class="wiki-indent"><p>예시를 확인하세요\.<\/p><\/div>/u);
  assert.match(rendered.topNoticeHtml ?? '', /<div class="wiki-indent"><p>점검 시간은 02:00입니다\.<\/p><\/div>/u);
  assert.throws(
    () => normalizeServerWikiContentSettings({
      ...emptySettings,
      topNoticeSource: '공지\n [[파일:secret.png]]',
    }),
    hasErrorCode('SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP'),
  );
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
