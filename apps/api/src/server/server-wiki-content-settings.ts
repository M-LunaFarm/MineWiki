import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  parseMarkup,
  renderDocument,
  type AstNode,
  type InlineNode,
} from '@minewiki/wiki-core';

export interface ServerWikiContentSources {
  readonly contributionPolicySource: string | null;
  readonly editHelpSource: string | null;
  readonly topNoticeSource: string | null;
  readonly bottomNoticeSource: string | null;
}

export interface ServerWikiContentSettingsInput extends ServerWikiContentSources {
  readonly expectedVersion: number;
  readonly requireContributionPolicyAck: boolean;
}

export const SERVER_WIKI_CONTENT_LIMITS = {
  contributionPolicySource: 8 * 1024,
  editHelpSource: 8 * 1024,
  topNoticeSource: 2 * 1024,
  bottomNoticeSource: 2 * 1024,
  total: 20 * 1024,
} as const;

type ContentField = keyof ServerWikiContentSources;

export function normalizeServerWikiContentSettings(
  input: ServerWikiContentSettingsInput,
): ServerWikiContentSettingsInput {
  const normalized = {
    expectedVersion: input.expectedVersion,
    contributionPolicySource: normalizeSource(input.contributionPolicySource),
    editHelpSource: normalizeSource(input.editHelpSource),
    topNoticeSource: normalizeSource(input.topNoticeSource),
    bottomNoticeSource: normalizeSource(input.bottomNoticeSource),
    requireContributionPolicyAck: input.requireContributionPolicyAck,
  };
  if (!normalized.contributionPolicySource) {
    normalized.requireContributionPolicyAck = false;
  }
  validateSources(normalized);
  return normalized;
}

export function renderServerWikiPresentation(sources: ServerWikiContentSources) {
  return {
    policyHtml: renderRestrictedSource(sources.contributionPolicySource, 'document'),
    editHelpHtml: renderRestrictedSource(sources.editHelpSource, 'document'),
    topNoticeHtml: renderRestrictedSource(sources.topNoticeSource, 'notice'),
    bottomNoticeHtml: renderRestrictedSource(sources.bottomNoticeSource, 'notice'),
  };
}

export function sourceAuditSummary(source: string | null) {
  if (!source) return { bytes: 0, sha256: null };
  return {
    bytes: Buffer.byteLength(source, 'utf8'),
    sha256: hashSource(source),
  };
}

function normalizeSource(value: string | null): string | null {
  const normalized = value?.replace(/\r\n?/gu, '\n').trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function validateSources(sources: ServerWikiContentSources): void {
  const fields = Object.keys(SERVER_WIKI_CONTENT_LIMITS).filter(
    (key): key is ContentField => key !== 'total',
  );
  let total = 0;
  for (const field of fields) {
    const source = sources[field];
    const bytes = source ? Buffer.byteLength(source, 'utf8') : 0;
    total += bytes;
    if (bytes > SERVER_WIKI_CONTENT_LIMITS[field]) {
      throw new BadRequestException({
        code: 'SERVER_WIKI_CONTENT_TOO_LARGE',
        field,
        maxBytes: SERVER_WIKI_CONTENT_LIMITS[field],
      });
    }
    if (source) {
      renderRestrictedSource(
        source,
        field === 'topNoticeSource' || field === 'bottomNoticeSource' ? 'notice' : 'document',
      );
    }
  }
  if (total > SERVER_WIKI_CONTENT_LIMITS.total) {
    throw new BadRequestException({
      code: 'SERVER_WIKI_CONTENT_TOTAL_TOO_LARGE',
      maxBytes: SERVER_WIKI_CONTENT_LIMITS.total,
    });
  }
}

function renderRestrictedSource(source: string | null, mode: 'document' | 'notice'): string | null {
  if (!source) return null;
  const parsed = parseMarkup(source);
  if (parsed.blockingErrors.length > 0) {
    throw new BadRequestException({
      code: 'SERVER_WIKI_CONTENT_INVALID_MARKUP',
      errors: parsed.blockingErrors.slice(0, 8),
    });
  }
  const invalid = findInvalidNode(parsed.ast, mode);
  if (invalid) {
    throw new BadRequestException({
      code: 'SERVER_WIKI_CONTENT_UNSUPPORTED_MARKUP',
      nodeType: invalid,
    });
  }
  return renderDocument(parsed.ast);
}

function findInvalidNode(nodes: readonly AstNode[], mode: 'document' | 'notice'): string | null {
  for (const node of nodes) {
    if (mode === 'notice' && node.type !== 'paragraph' && node.type !== 'blockquote' && node.type !== 'hr') {
      return node.type;
    }
    if (
      node.type !== 'heading'
      && node.type !== 'paragraph'
      && node.type !== 'list'
      && node.type !== 'blockquote'
      && node.type !== 'hr'
      && node.type !== 'codeblock'
    ) {
      return node.type;
    }
    if (node.type === 'paragraph') {
      const invalid = findInvalidInline(node.children);
      if (invalid) return invalid;
    }
    if (node.type === 'blockquote') {
      const invalid = findInvalidNode(node.children, mode);
      if (invalid) return invalid;
    }
    if (node.type === 'list') {
      for (const item of node.items) {
        const invalid = findInvalidInline(item.children) ?? findInvalidNode(item.nested, mode);
        if (invalid) return invalid;
      }
    }
  }
  return null;
}

function findInvalidInline(nodes: readonly InlineNode[]): string | null {
  for (const node of nodes) {
    if (
      node.type !== 'text'
      && node.type !== 'line_break'
      && node.type !== 'bold'
      && node.type !== 'italic'
      && node.type !== 'strike'
      && node.type !== 'underline'
      && node.type !== 'sup'
      && node.type !== 'sub'
      && node.type !== 'internal_link'
      && node.type !== 'external_link'
      && node.type !== 'code'
    ) {
      return node.type;
    }
    if (node.type === 'external_link') {
      try {
        if (new URL(node.href).protocol !== 'https:') return 'external_link_protocol';
      } catch {
        return 'external_link_url';
      }
    }
    if ('children' in node) {
      const invalid = findInvalidInline(node.children);
      if (invalid) return invalid;
    }
  }
  return null;
}

function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
