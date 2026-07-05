import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'p',
  'strong',
  'em',
  'ul',
  'ol',
  'li',
  'a',
  'code',
  'pre',
  'blockquote',
  'hr',
  'br'
];

export function renderSafeMarkdown(markdown: string): string {
  const rawHtml = marked(markdown, {
    gfm: true,
    breaks: true
  });

  return sanitizeHtml(rawHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel']
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer nofollow',
        target: '_blank'
      })
    }
  });
}

export function extractMarkdownImageUrls(markdown: string): string[] {
  const unique = new Set<string>();
  const markdownPattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const htmlPattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;

  for (const match of markdown.matchAll(markdownPattern)) {
    const normalized = normalizeImageUrl(match[1] ?? '');
    if (normalized) {
      unique.add(normalized);
    }
  }

  for (const match of markdown.matchAll(htmlPattern)) {
    const normalized = normalizeImageUrl(match[2] ?? '');
    if (normalized) {
      unique.add(normalized);
    }
  }

  return Array.from(unique);
}

export function stripMarkdownImages(markdown: string): string {
  const markdownPattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  const htmlPattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
  return markdown
    .replace(markdownPattern, '')
    .replace(htmlPattern, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeImageUrl(candidate: string): string | null {
  const trimmed = candidate.trim().replace(/^<|>$/g, '');
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }

  return null;
}
