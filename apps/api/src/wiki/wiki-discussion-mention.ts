export const MAX_DISCUSSION_MENTION_TARGETS = 10;
const MAX_DISCUSSION_MENTION_OCCURRENCES = 100;

export interface WikiDiscussionMentionOccurrence {
  readonly username: string;
  readonly start: number;
  readonly end: number;
}

function isUsernameCharacter(value: string | undefined): boolean {
  if (!value) return false;
  const code = value.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || value === '_' || value === '-';
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

/**
 * Extracts bounded, whitespace-delimited ASCII wiki usernames in one pass.
 * Offsets are UTF-16 indices so they can be used directly with String#slice.
 */
export function extractDiscussionMentions(content: string): readonly WikiDiscussionMentionOccurrence[] {
  const occurrences: WikiDiscussionMentionOccurrence[] = [];
  const targets = new Set<string>();
  for (let index = 0; index < content.length && occurrences.length < MAX_DISCUSSION_MENTION_OCCURRENCES; index += 1) {
    if (content[index] !== '@' || (index > 0 && !isWhitespace(content[index - 1]))) continue;
    let end = index + 1;
    while (end < content.length && isUsernameCharacter(content[end])) end += 1;
    const length = end - index - 1;
    if (length < 1 || length > 64) {
      index = Math.max(index, end - 1);
      continue;
    }
    const username = content.slice(index + 1, end);
    const key = username.toLocaleLowerCase('en-US');
    if (!targets.has(key)) {
      if (targets.size >= MAX_DISCUSSION_MENTION_TARGETS) {
        index = end - 1;
        continue;
      }
      targets.add(key);
    }
    occurrences.push({ username, start: index, end });
    index = end - 1;
  }
  return occurrences;
}

export function uniqueDiscussionMentionUsernames(content: string): readonly string[] {
  const unique = new Map<string, string>();
  for (const mention of extractDiscussionMentions(content)) {
    const key = mention.username.toLocaleLowerCase('en-US');
    if (!unique.has(key)) unique.set(key, mention.username);
  }
  return [...unique.values()];
}
