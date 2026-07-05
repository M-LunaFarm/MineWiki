import crypto from 'node:crypto';

export function normalizeTitle(input: string) {
  return decodeURIComponent(input)
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugifyTitle(input: string) {
  return normalizeTitle(input).replace(/\s+/g, '_');
}

export function normalizeSearch(input: string) {
  return normalizeTitle(input).toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
}

const CHO = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ'
];

export function chosung(input: string) {
  return [...normalizeTitle(input)]
    .map((char) => {
      const code = char.charCodeAt(0) - 0xac00;
      if (code < 0 || code > 11171) return char;
      return CHO[Math.floor(code / 588)] ?? char;
    })
    .join('');
}

export function hashContent(input: string) {
  return crypto.createHash('sha256').update(input).digest('hex');
}
