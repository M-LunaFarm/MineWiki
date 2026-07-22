const PLATFORM_FILE_PREFIX = '/v1/files/';
const PUBLIC_FILE_PREFIX = '/api/v1/files/';
const MEDIA_ATTRIBUTE_PATTERN = /\b(src|poster|href|data-wiki-file-src)=(['"])(\/v1\/files\/[^'"]*)\2/giu;

/**
 * Rewrites only API-backed wiki media attributes. Other links, CDN URLs,
 * absolute URLs, and data URLs remain byte-for-byte unchanged.
 *
 * @param {string} html
 * @param {{ platformOrigin?: string | null }} [options]
 */
export function rewriteWikiRenderedMedia(html, options = {}) {
  const platformOrigin = options.platformOrigin?.trim();
  const publicPrefix = platformOrigin
    ? new URL(PUBLIC_FILE_PREFIX, `${platformOrigin.replace(/\/$/u, '')}/`).toString()
    : PUBLIC_FILE_PREFIX;
  return html.replace(MEDIA_ATTRIBUTE_PATTERN, (_match, attribute, quote, value) => {
    const suffix = value.slice(PLATFORM_FILE_PREFIX.length);
    return `${attribute}=${quote}${publicPrefix}${suffix}${quote}`;
  });
}
