import {
  extractMarkdownImageUrls as extractMarkdownImageUrlsRuntime,
  renderSafeMarkdown as renderSafeMarkdownRuntime,
  stripMarkdownImages as stripMarkdownImagesRuntime,
} from './markdown-runtime.mjs';

export function renderSafeMarkdown(markdown: string): string {
  return renderSafeMarkdownRuntime(markdown);
}

export function extractMarkdownImageUrls(markdown: string): string[] {
  return extractMarkdownImageUrlsRuntime(markdown);
}

export function stripMarkdownImages(markdown: string): string {
  return stripMarkdownImagesRuntime(markdown);
}
