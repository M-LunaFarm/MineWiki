const MAX_SEARCH_VECTOR_TERMS = 50_000;
const WORD_PATTERN = /[\p{Letter}\p{Number}]+/gu;

export function buildWikiSearchVector(values: readonly string[]): string {
  const terms = new Set<string>();
  for (const value of values) {
    for (const word of normalizedWords(value)) {
      const characters = [...word];
      for (const size of [1, 2, 3]) {
        if (characters.length < size) continue;
        for (let index = 0; index <= characters.length - size; index += 1) {
          terms.add(searchGramToken(characters.slice(index, index + size)));
          if (terms.size >= MAX_SEARCH_VECTOR_TERMS) return [...terms].join(' ');
        }
      }
    }
  }
  return [...terms].join(' ');
}

export function buildWikiSearchBooleanQuery(value: string): string {
  const terms = new Set<string>();
  for (const word of normalizedWords(value)) {
    const characters = [...word];
    const size = Math.min(characters.length, 3);
    for (let index = 0; index <= characters.length - size; index += 1) {
      terms.add(searchGramToken(characters.slice(index, index + size)));
    }
  }
  return [...terms].map((term) => `+${term}`).join(' ');
}

function normalizedWords(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').match(WORD_PATTERN) ?? [];
}

function searchGramToken(characters: readonly string[]): string {
  return `mw${characters.map((character) => character.codePointAt(0)!.toString(36)).join('z')}`;
}
