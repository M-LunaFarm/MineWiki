export const WIKI_EDITOR_FORMAT_ACTIONS = Object.freeze([
  'heading2',
  'heading3',
  'bold',
  'italic',
  'link',
  'unordered-list',
  'ordered-list',
  'quote',
  'code-block',
  'table',
  'callout',
  'footnote',
  'include',
]);

export function applyWikiEditorFormat(input, action) {
  const value = typeof input?.value === 'string' ? input.value : '';
  const selection = normalizeSelection(value, input?.selectionStart, input?.selectionEnd);

  switch (action) {
    case 'heading2':
      return applyHeading(value, selection, 2, '섹션 제목');
    case 'heading3':
      return applyHeading(value, selection, 3, '하위 제목');
    case 'bold':
      return wrapSelection(value, selection, "'''", "'''", '굵은 텍스트');
    case 'italic':
      return wrapSelection(value, selection, "''", "''", '기울임 텍스트');
    case 'link':
      return insertLink(value, selection);
    case 'unordered-list':
      return prefixSelectedLines(value, selection, ' * ', '목록 항목');
    case 'ordered-list':
      return prefixSelectedLines(value, selection, ' 1. ', '목록 항목');
    case 'quote':
      return prefixSelectedLines(value, selection, '> ', '인용문');
    case 'code-block':
      return insertBlock(value, selection, '{{{#!syntax text\n', '\n}}}', '코드');
    case 'table':
      return insertTable(value, selection);
    case 'callout':
      return insertBlock(
        value,
        selection,
        '{{{#!wiki style="border-left:4px solid #35e5b7;padding:12px"\n',
        '\n}}}',
        "'''안내'''\n안내 내용을 입력하세요.",
      );
    case 'footnote':
      return wrapSelection(value, selection, '[* ', ']', '각주 설명');
    case 'include':
      return wrapSelection(value, selection, '[include(', ')]', '틀:안내');
    default:
      return { value, selectionStart: selection.start, selectionEnd: selection.end };
  }
}

export function wikiEditorShortcutAction(event) {
  if (!event || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)) return null;
  const key = String(event.key ?? '').toLocaleLowerCase('en-US');
  if (key === 'b') return 'bold';
  if (key === 'i') return 'italic';
  if (key === 'k') return 'link';
  return null;
}

function normalizeSelection(value, start, end) {
  const normalizedStart = clampInteger(start, 0, value.length);
  const normalizedEnd = clampInteger(end, normalizedStart, value.length);
  return { start: normalizedStart, end: normalizedEnd };
}

function clampInteger(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function wrapSelection(value, selection, prefix, suffix, placeholder) {
  const selected = value.slice(selection.start, selection.end);
  if (
    selected
    && value.slice(selection.start - prefix.length, selection.start) === prefix
    && value.slice(selection.end, selection.end + suffix.length) === suffix
  ) {
    return replaceRange(
      value,
      selection.start - prefix.length,
      selection.end + suffix.length,
      selected,
      0,
      selected.length,
    );
  }
  const content = selected || placeholder;
  return replaceRange(
    value,
    selection.start,
    selection.end,
    `${prefix}${content}${suffix}`,
    prefix.length,
    prefix.length + content.length,
  );
}

function insertLink(value, selection) {
  const selected = value.slice(selection.start, selection.end);
  const target = '문서 제목';
  const label = selected || '표시할 텍스트';
  return replaceRange(
    value,
    selection.start,
    selection.end,
    `[[${target}|${label}]]`,
    2,
    2 + target.length,
  );
}

function insertBlock(value, selection, prefix, suffix, placeholder) {
  const selected = value.slice(selection.start, selection.end) || placeholder;
  const before = value.slice(0, selection.start);
  const after = value.slice(selection.end);
  const leadingBreak = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const trailingBreak = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
  const replacement = `${leadingBreak}${prefix}${selected}${suffix}${trailingBreak}`;
  const selectedOffset = leadingBreak.length + prefix.length;
  return replaceRange(
    value,
    selection.start,
    selection.end,
    replacement,
    selectedOffset,
    selectedOffset + selected.length,
  );
}

function insertTable(value, selection) {
  const placeholder = '||<thead>항목||설명||\n||값||내용||';
  const result = insertBlock(value, selection, '', '', placeholder);
  if (selection.start !== selection.end) return result;
  const labelStart = result.value.indexOf('항목', result.selectionStart);
  return {
    ...result,
    selectionStart: labelStart,
    selectionEnd: labelStart + '항목'.length,
  };
}

function applyHeading(value, selection, level, placeholder) {
  if (selection.start === selection.end) {
    const marker = '='.repeat(level);
    return insertBlock(value, selection, `${marker} `, ` ${marker}`, placeholder);
  }
  return replaceSelectedLines(value, selection, (line) => headingLine(line, level), placeholder);
}

function replaceSelectedLines(value, selection, transform, placeholder) {
  const range = selectedLineRange(value, selection, placeholder);
  const transformed = range.content.split('\n').map(transform).join('\n');
  return replaceRange(value, range.start, range.end, transformed, 0, transformed.length);
}

function prefixSelectedLines(value, selection, prefix, placeholder) {
  const range = selectedLineRange(value, selection, placeholder);
  const lines = range.content.split('\n');
  const alreadyPrefixed = lines.every((line) => !line || line.startsWith(prefix));
  const transformed = lines.map((line) => {
    if (!line) return line;
    return alreadyPrefixed ? line.slice(prefix.length) : `${prefix}${line}`;
  }).join('\n');
  return replaceRange(value, range.start, range.end, transformed, 0, transformed.length);
}

function selectedLineRange(value, selection, placeholder) {
  if (selection.start === selection.end) {
    return { start: selection.start, end: selection.end, content: placeholder };
  }
  const start = selection.start === 0 ? 0 : value.lastIndexOf('\n', selection.start - 1) + 1;
  const nextBreak = value.indexOf('\n', selection.end);
  const end = nextBreak === -1 ? value.length : nextBreak;
  return { start, end, content: value.slice(start, end) };
}

function headingLine(line, level) {
  if (!line.trim()) return line;
  const marker = '='.repeat(level);
  const existing = line.trim().match(/^={2,6}\s+(.+?)\s+={2,6}$/u);
  return `${marker} ${existing?.[1] ?? line.trim()} ${marker}`;
}

function replaceRange(value, start, end, replacement, relativeSelectionStart, relativeSelectionEnd) {
  return {
    value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
    selectionStart: start + relativeSelectionStart,
    selectionEnd: start + relativeSelectionEnd,
  };
}
