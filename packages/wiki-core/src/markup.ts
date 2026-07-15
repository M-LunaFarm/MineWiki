import sanitizeHtml from 'sanitize-html';
import type {
  AstNode,
  InlineNode,
  ParsedDocument,
  WikiListKind,
  WikiListNode,
  WikiTableCell,
  WikiTableOptions
} from './types.js';
import { parseLinkTarget, wikiLinkKey, wikiUrl } from './namespaces.js';
import { normalizeTitle, slugifyTitle } from './normalize.js';

export const WIKI_RENDERER_VERSION = 'minewiki-bwm-0.7.0';
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_FOLDING_DEPTH = 16;
const MAX_LIST_DEPTH = 32;
const MAX_INCLUDE_OCCURRENCES = 20;
const MAX_INCLUDE_PARAMS = 32;
const MAX_INCLUDE_PARAM_KEY_LENGTH = 64;
const MAX_INCLUDE_PARAM_VALUE_BYTES = 4096;
const MAX_INCLUDE_PARAM_BYTES = 32 * 1024;
const INCLUDE_PARAM_KEY = /^[A-Za-z0-9가-힣_]+$/u;

const componentNameMap: Record<string, string> = {
  '문서 상태': 'document_status',
  '몹 정보': 'mob_info',
  '블록 정보': 'block_info',
  '아이템 정보': 'item_info',
  '모드 정보': 'mod_info',
  '서버 정보': 'server_info',
  조합법: 'crafting_recipe',
  '명령어 정보': 'command_info',
  각주: 'references',
  접기: 'fold',
  '공식 영역': 'official_area',
  '서버 사건 서술 주의': 'server_notice',
  '데이터 표': 'data_table',
  인용: 'quote_box',
  표: 'simple_table',
  '드롭 표': 'drop_table',
  제련법: 'smelting_recipe',
  양조법: 'brewing_recipe',
  '주민 거래': 'villager_trade',
  '에디션 차이': 'edition_diff',
  '버전 역사': 'version_history',
  '모드 버전표': 'mod_version_table',
  '개발 문서 상태': 'develop_status',
  'API 정보': 'api_info',
  '패킷 정보': 'packet_info',
  '데이터 타입': 'data_type_info',
  '버전 지원표': 'version_support',
  '코드 예제': 'code_example',
  '경고 박스': 'warning_box',
  '공식 문서 링크': 'official_doc_link',
  '의존성 정보': 'dependency_info',
  'Gradle/Maven 설정': 'gradle_setup',
  'Gradle 설정': 'gradle_setup',
  'Maven 설정': 'maven_setup',
  'NBT 구조': 'nbt_structure',
  '프로토콜 필드 표': 'protocol_fields',
  '대문 소개': 'front_intro',
  '대문 검색': 'front_search',
  '대문 카드': 'front_card',
  '서버 운영자 안내': 'server_operator_notice'
};

const allowedTags = [
  'a',
  'p',
  'strong',
  'em',
  'code',
  'pre',
  'kbd',
  'samp',
  'mark',
  'small',
  'br',
  'ruby',
  'rp',
  'rt',
  'img',
  'figure',
  'figcaption',
  'blockquote',
  'caption',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'hr',
  's',
  'u',
  'sup',
  'sub',
  'section',
  'nav',
  'aside',
  'details',
  'summary'
];

export function parseMarkup(raw: string, foldingDepth = 0): ParsedDocument {
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) {
    return rejectedDocument('문서 크기 제한을 초과했습니다.');
  }
  if (foldingDepth > MAX_FOLDING_DEPTH) {
    return rejectedDocument('접기 블록 중첩 제한을 초과했습니다.');
  }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const ast: AstNode[] = [];
  const links = new Set<string>();
  const categories = new Set<string>();
  const includes: string[] = [];
  const components: Array<{ name: string; props: Record<string, string> }> = [];
  const errors: string[] = [];
  const blockingErrors: string[] = [];
  const footnotes: string[] = [];
  let redirectTarget: string | null = null;

  const firstRealLine = lines.find((line) => line.trim().length > 0)?.trim() ?? '';
  const redirect = firstRealLine.match(/^#(?:넘겨주기|REDIRECT)\s+\[\[(.+?)\]\]/i);
  if (redirect) {
    redirectTarget = redirect[1];
    ast.push({ type: 'redirect', target: redirectTarget });
  }

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] ?? '';
    if (!line.trim()) continue;
    if (i === 0 && redirectTarget) continue;

    const syntaxBlock = line.match(/^\{\{\{#!(?:syntax|highlight)\s+([A-Za-z0-9_+-]+)\s*$/);
    if (syntaxBlock) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]?.trim() !== '}}}') {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      ast.push({ type: 'codeblock', lang: syntaxBlock[1] ?? null, code: codeLines.join('\n') });
      continue;
    }

    if (line.trim() === '{{{') {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]?.trim() !== '}}}') {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      ast.push({ type: 'codeblock', lang: null, code: codeLines.join('\n') });
      continue;
    }

    const foldingBlock = line.match(/^\{\{\{#!folding\s*(.*)$/);
    if (foldingBlock) {
      const bodyLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]?.trim() !== '}}}') {
        bodyLines.push(lines[i] ?? '');
        i += 1;
      }
      const nested = parseMarkup(bodyLines.join('\n'), foldingDepth + 1);
      nested.links.forEach((link) => links.add(link));
      nested.categories.forEach((categoryTitle) => categories.add(categoryTitle));
      nested.includes.forEach((target) => includes.push(target));
      nested.components.forEach((component) => components.push(component));
      nested.footnotes.forEach((note) => footnotes.push(note));
      nested.errors.forEach((error) => errors.push(error));
      nested.blockingErrors.forEach((error) => blockingErrors.push(error));
      ast.push({ type: 'folding', title: parseInline(foldingBlock[1]?.trim() || '펼치기', links, errors, blockingErrors, footnotes), children: nested.ast });
      continue;
    }

    const include = parseIncludeLine(line);
    if (include) {
      if ('error' in include) {
        blockingErrors.push(include.error);
      } else if (includes.length >= MAX_INCLUDE_OCCURRENCES) {
        blockingErrors.push(`include 문서는 문서당 ${MAX_INCLUDE_OCCURRENCES}개까지 사용할 수 있습니다.`);
      } else {
        includes.push(include.target);
        ast.push({
          type: 'include',
          target: include.target,
          params: include.params,
          state: 'unresolved'
        });
      }
      continue;
    }

    const toc = line.trim().match(/^\[(?:목차|tableofcontents)(?:\((hide)\))?\]$/i);
    if (toc) {
      ast.push({ type: 'toc', collapsed: Boolean(toc[1]) });
      continue;
    }

    const codeblock = line.match(/^<codeblock(?:\s+lang="([^"]+)")?>$/);
    if (codeblock) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]?.match(/^<\/codeblock>$/)) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      ast.push({ type: 'codeblock', lang: codeblock[1] ?? null, code: codeLines.join('\n') });
      continue;
    }

    const componentStart = line.match(/^\{\{([^|}\n]+)\s*$/);
    if (componentStart) {
      const props: Record<string, string> = {};
      let content = '';
      i += 1;
      while (i < lines.length && !lines[i]?.trim().endsWith('}}')) {
        content += `${lines[i] ?? ''}\n`;
        i += 1;
      }
      const closeLine = lines[i]?.replace(/\}\}\s*$/, '') ?? '';
      content += closeLine;
      for (const row of content.split('\n')) {
        const prop = row.match(/^\|([^=]+)=(.*)$/);
        if (prop) props[prop[1].trim()] = prop[2].trim();
      }
      const name = componentNameMap[componentStart[1].trim()] ?? componentStart[1].trim();
      ast.push({ type: 'component', name, props });
      components.push({ name, props });
      continue;
    }

    const inlineComponent = line.match(/^\{\{(.+?)\}\}$/);
    if (inlineComponent) {
      const name = componentNameMap[inlineComponent[1].trim()] ?? inlineComponent[1].trim();
      ast.push({ type: 'component', name, props: {} });
      components.push({ name, props: {} });
      continue;
    }

    const inlineCategories = [...line.matchAll(/\[\[분류:([^|\]]+)(?:\|[^\]]*)?\]\]/g)];
    if (inlineCategories.length > 0) {
      for (const category of inlineCategories) {
        const title = normalizeTitle(category[1] ?? '');
        if (title) categories.add(title);
      }
      line = line.replace(/\[\[분류:([^|\]]+)(?:\|[^\]]*)?\]\]/g, '').trimEnd();
      if (!line.trim()) {
        for (const category of inlineCategories) {
          const title = normalizeTitle(category[1] ?? '');
          if (title) ast.push({ type: 'category', title });
        }
        continue;
      }
    }

    const heading = line.match(/^(={2,4})\s*(.+?)\s*\1$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      ast.push({ type: 'heading', level, text, id: makeHeadingId(text), startLine: i + 1 });
      continue;
    }

    if (/^-{4,}$/.test(line.trim())) {
      ast.push({ type: 'hr' });
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]?.startsWith('>')) {
        quoteLines.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      ast.push({ type: 'blockquote', children: parseInline(quoteLines.join('\n'), links, errors, blockingErrors, footnotes) });
      continue;
    }

    const tableStart = parseWikiTableStart(line, lines[i + 1]);
    if (tableStart) {
      const rows: WikiTableCell[][] = [];
      const tableOptions: WikiTableOptions = {};
      const caption = tableStart.caption === null
        ? []
        : parseInline(tableStart.caption, links, errors, blockingErrors, footnotes);
      if (tableStart.firstRow !== null) {
        const cells = parseWikiTableRow(tableStart.firstRow, tableOptions, links, errors, blockingErrors, footnotes);
        if (cells.length > 0) rows.push(cells);
      }
      if (tableStart.consumeNextLine) i += 1;
      while (i < lines.length && lines[i]?.trim().startsWith('||')) {
        const cells = parseWikiTableRow(lines[i] ?? '', tableOptions, links, errors, blockingErrors, footnotes);
        if (cells.length > 0) rows.push(cells);
        i += 1;
      }
      i -= 1;
      ast.push({ type: 'wiki_table', caption, rows, options: tableOptions });
      continue;
    }

    const file = line.match(/^\[\[파일:([^|\]]+)(?:\|([^|\]]+))?(?:\|([^|\]]+))?\]\]$/);
    if (file) {
      const fileName = file[1].trim();
      validateWikiFileName(fileName, blockingErrors);
      const thumbnail = file[2]?.trim() === '섬네일';
      const caption = file[3]?.trim() || (!thumbnail ? file[2]?.trim() : '') || null;
      ast.push({ type: 'file', fileName, thumbnail, caption });
      continue;
    }

    if (parseWikiListLine(line)) {
      const listBlock: string[] = [];
      while (i < lines.length && parseWikiListLine(lines[i] ?? '')) {
        listBlock.push(lines[i] ?? '');
        i += 1;
      }
      i -= 1;
      ast.push(...parseWikiListBlock(listBlock, links, errors, blockingErrors, footnotes));
      continue;
    }

    ast.push({ type: 'paragraph', children: parseInline(line, links, errors, blockingErrors, footnotes) });
  }

  const headings = ast.filter((node): node is Extract<AstNode, { type: 'heading' }> => node.type === 'heading');
  const seenHeadings = new Set<string>();
  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    heading.endLine = (next?.startLine ?? lines.length + 1) - 1;
    if (seenHeadings.has(heading.id)) {
      blockingErrors.push(`중복 제목 앵커가 있습니다: ${heading.text}`);
    }
    seenHeadings.add(heading.id);
  });

  if (!components.some((component) => component.name === 'document_status')) {
    errors.push('문서 상태 컴포넌트가 없습니다.');
  }
  if (categories.size === 0 && !redirectTarget) {
    errors.push('분류가 없습니다.');
  }
  if (!components.some((component) => ['mob_info', 'item_info', 'block_info', 'mod_info', 'server_info', 'api_info', 'packet_info', 'data_type_info', 'develop_status'].includes(component.name))) {
    errors.push('정보 컴포넌트가 없습니다.');
  }
  if (/<\s*(script|style|iframe|object|embed|img)\b/i.test(raw) || /\son[a-z]+\s*=/i.test(raw)) {
    blockingErrors.push('허용되지 않은 HTML이 포함되어 있습니다.');
  }

  return {
    ast,
    links: [...links],
    categories: [...categories],
    includes,
    components,
    headings: headings.map((heading) => ({
      level: heading.level,
      title: heading.text,
      anchor: heading.id,
      startLine: heading.startLine ?? 1,
      endLine: heading.endLine ?? heading.startLine ?? 1
    })),
    footnotes,
    redirectTarget,
    plainText: raw
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .replace(/\[\[분류:.+?\]\]/g, ' ')
      .replace(/\[\[(.+?)(?:\|(.+?))?\]\]/g, '$2$1')
      .replace(/'{2,3}/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    errors,
    blockingErrors
  };
}

function rejectedDocument(message: string): ParsedDocument {
  return {
    ast: [],
    links: [],
    categories: [],
    includes: [],
    components: [],
    headings: [],
    footnotes: [],
    redirectTarget: null,
    plainText: '',
    errors: [],
    blockingErrors: [message]
  };
}

type ParsedIncludeLine =
  | { target: string; params: Record<string, string> }
  | { error: string };

function parseIncludeLine(line: string): ParsedIncludeLine | null {
  const trimmed = line.trim();
  if (!/^\[include\(/i.test(trimmed)) return null;
  const match = trimmed.match(/^\[include\(([\s\S]*)\)\]$/i);
  if (!match) return { error: 'include 문법이 올바르지 않습니다.' };
  const parts = splitIncludeArguments(match[1] ?? '');
  const target = normalizeTitle(parts.shift() ?? '');
  if (!target || target.includes('@') || Buffer.byteLength(target, 'utf8') > 255) {
    return { error: 'include 대상 문서명이 올바르지 않습니다.' };
  }
  if (parts.length > MAX_INCLUDE_PARAMS) {
    return { error: `include 매개변수는 ${MAX_INCLUDE_PARAMS}개까지 사용할 수 있습니다.` };
  }
  const params: Record<string, string> = {};
  let totalBytes = 0;
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) return { error: 'include 매개변수는 키=값 형식이어야 합니다.' };
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1);
    if (!INCLUDE_PARAM_KEY.test(key) || key.length > MAX_INCLUDE_PARAM_KEY_LENGTH) {
      return { error: `include 매개변수 키가 올바르지 않습니다: ${key || '(빈 키)'}` };
    }
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return { error: `include 매개변수가 중복되었습니다: ${key}` };
    }
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > MAX_INCLUDE_PARAM_VALUE_BYTES) {
      return { error: `include 매개변수 값이 너무 큽니다: ${key}` };
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + valueBytes;
    if (totalBytes > MAX_INCLUDE_PARAM_BYTES) {
      return { error: 'include 매개변수 전체 크기 제한을 초과했습니다.' };
    }
    params[key] = value;
  }
  return { target, params };
}

function splitIncludeArguments(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  parts.push(current.trim());
  return parts;
}

interface ParsedWikiListLine {
  indent: number;
  kind: WikiListKind;
  start: number;
  content: string;
}

function parseWikiListLine(line: string): ParsedWikiListLine | null {
  const match = line.match(/^([ \t]*)(\*|1\.|a\.|A\.|i\.|I\.)(?:#(\d+))?[ \t]+(.*)$/u);
  if (!match) return null;
  const marker = match[2] ?? '*';
  let content = match[4] ?? '';
  let start = Math.max(1, Math.min(1_000_000, Number(match[3]) || 1));
  const legacyStart = content.match(/^#(\d+)(?:\s+|$)/);
  if (legacyStart) {
    start = Math.max(1, Math.min(1_000_000, Number(legacyStart[1]) || 1));
    content = content.slice(legacyStart[0].length);
  }
  const kindMap: Record<string, WikiListKind> = {
    '*': 'unordered',
    '1.': 'decimal',
    'a.': 'lower-alpha',
    'A.': 'upper-alpha',
    'i.': 'lower-roman',
    'I.': 'upper-roman'
  };
  return {
    indent: (match[1] ?? '').replace(/\t/g, '  ').length,
    kind: kindMap[marker] ?? 'unordered',
    start,
    content
  };
}

function parseWikiListBlock(
  lines: readonly string[],
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[]
): WikiListNode[] {
  const entries = lines.map(parseWikiListLine).filter((entry): entry is ParsedWikiListLine => entry !== null);
  if (entries.length === 0) return [];
  const baseIndent = Math.min(...entries.map((entry) => entry.indent));
  for (const entry of entries) {
    entry.indent -= baseIndent;
    if (entry.indent > MAX_LIST_DEPTH) {
      const warning = `목록 중첩은 ${MAX_LIST_DEPTH}단계까지 사용할 수 있습니다.`;
      if (!blockingErrors.includes(warning)) blockingErrors.push(warning);
      entry.indent = MAX_LIST_DEPTH;
    }
  }

  const parseLevel = (startIndex: number, indent: number): { lists: WikiListNode[]; nextIndex: number } => {
    const lists: WikiListNode[] = [];
    let index = startIndex;
    while (index < entries.length) {
      const entry = entries[index]!;
      if (entry.indent < indent) break;
      if (entry.indent > indent) {
        const previousList = lists[lists.length - 1];
        const previousItem = previousList?.items[previousList.items.length - 1];
        if (!previousItem) break;
        const nested = parseLevel(index, entry.indent);
        previousItem.nested.push(...nested.lists);
        index = nested.nextIndex;
        continue;
      }

      const list: WikiListNode = { type: 'list', kind: entry.kind, start: entry.start, items: [] };
      while (index < entries.length) {
        const current = entries[index]!;
        if (current.indent !== indent || current.kind !== list.kind) break;
        const item = {
          children: parseInline(current.content, links, errors, blockingErrors, footnotes),
          nested: [] as WikiListNode[]
        };
        list.items.push(item);
        index += 1;
        while (index < entries.length && entries[index]!.indent > indent) {
          const nested = parseLevel(index, entries[index]!.indent);
          item.nested.push(...nested.lists);
          index = nested.nextIndex;
        }
      }
      lists.push(list);
    }
    return { lists, nextIndex: index };
  };

  return parseLevel(0, entries[0]!.indent).lists;
}

function parseWikiTableRow(
  line: string,
  tableOptions: WikiTableOptions,
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[]
): WikiTableCell[] {
  const cells: WikiTableCell[] = [];
  let pendingColspan = 1;
  for (const rawCell of splitWikiTableRow(line)) {
    if (!rawCell.trim()) {
      pendingColspan = Math.min(1000, pendingColspan + 1);
      continue;
    }
    const cell: WikiTableCell = { children: [], colspan: pendingColspan, rowspan: 1 };
    pendingColspan = 1;
    let content = rawCell;
    while (content.startsWith('<')) {
      const end = content.indexOf('>');
      if (end < 0) break;
      const modifier = content.slice(1, end).trim();
      if (!applyWikiTableModifier(modifier, cell, tableOptions, errors)) break;
      content = content.slice(end + 1);
    }
    if (!cell.align) {
      const startsWithSpace = /^\s/u.test(content);
      const endsWithSpace = /\s$/u.test(content);
      if (startsWithSpace && endsWithSpace) cell.align = 'center';
      else if (startsWithSpace) cell.align = 'right';
      else if (endsWithSpace) cell.align = 'left';
    }
    cell.children = parseInline(content.trim(), links, errors, blockingErrors, footnotes);
    cells.push(cell);
  }
  return cells;
}

interface WikiTableStart {
  caption: string | null;
  firstRow: string | null;
  consumeNextLine: boolean;
}

function parseWikiTableStart(line: string, nextLine: string | undefined): WikiTableStart | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('||')) {
    return { caption: null, firstRow: null, consumeNextLine: false };
  }

  // NamuMark captions are written as `|caption|` immediately before the
  // first `||...||` row. thetree also accepts the compact `|caption|||...||`
  // form, so retain the first row when it is present on the same line.
  const compactSeparator = trimmed.indexOf('|||', 1);
  if (compactSeparator > 0 && trimmed.endsWith('||')) {
    return {
      caption: unescapeWikiTableCaption(trimmed.slice(1, compactSeparator)),
      firstRow: trimmed.slice(compactSeparator + 1),
      consumeNextLine: true
    };
  }
  if (trimmed.startsWith('|') && !trimmed.startsWith('||') && trimmed.endsWith('|') && nextLine?.trim().startsWith('||')) {
    return {
      caption: unescapeWikiTableCaption(trimmed.slice(1, -1)),
      firstRow: null,
      consumeNextLine: true
    };
  }
  return null;
}

function unescapeWikiTableCaption(value: string) {
  return value.replace(/\\\|/g, '|').trim();
}

function applyWikiTableModifier(
  modifier: string,
  cell: WikiTableCell,
  table: WikiTableOptions,
  errors: string[]
): boolean {
  const colspan = modifier.match(/^-(\d+)$/);
  if (colspan) {
    cell.colspan = clampTableSpan(colspan[1]);
    return true;
  }
  const rowspan = modifier.match(/^([v^])?\|(\d+)$/);
  if (rowspan) {
    cell.rowspan = clampTableSpan(rowspan[2]);
    if (rowspan[1] === '^') cell.verticalAlign = 'top';
    if (rowspan[1] === 'v') cell.verticalAlign = 'bottom';
    return true;
  }
  if (modifier === '(' || modifier === ':' || modifier === ')') {
    cell.align = modifier === '(' ? 'left' : modifier === ':' ? 'center' : 'right';
    return true;
  }
  if (modifier.toLowerCase() === 'thead') {
    cell.header = true;
    return true;
  }

  const tableModifier = modifier.match(/^table\s*(align|width|bgcolor|color|bordercolor)=(.+)$/i);
  if (tableModifier) {
    const name = tableModifier[1]!.toLowerCase();
    const value = tableModifier[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (name === 'align') {
      if (value === 'left' || value === 'center' || value === 'right') table.align ??= value;
      else addTableModifierWarning(errors, modifier);
    } else if (name === 'width') {
      const size = normalizeTableSize(value);
      if (size) table.width ??= size;
      else addTableModifierWarning(errors, modifier);
    } else {
      const colors = normalizeTableColorPair(value);
      if (!colors) addTableModifierWarning(errors, modifier);
      else if (name === 'bgcolor') {
        table.backgroundColor ??= colors.light;
        if (colors.dark) table.darkBackgroundColor ??= colors.dark;
      } else if (name === 'color') {
        table.color ??= colors.light;
        if (colors.dark) table.darkColor ??= colors.dark;
      } else {
        table.borderColor ??= colors.light;
        if (colors.dark) table.darkBorderColor ??= colors.dark;
      }
    }
    return true;
  }

  const cellModifier = modifier.match(/^(width|height|bgcolor|color)=(.+)$/i);
  if (cellModifier) {
    const name = cellModifier[1]!.toLowerCase();
    const value = cellModifier[2]!.trim();
    if (name === 'width' || name === 'height') {
      const size = normalizeTableSize(value);
      if (!size) addTableModifierWarning(errors, modifier);
      else if (name === 'width') cell.width ??= size;
      else cell.height ??= size;
    } else {
      const colors = normalizeTableColorPair(value);
      if (!colors) addTableModifierWarning(errors, modifier);
      else if (name === 'bgcolor') {
        cell.backgroundColor ??= colors.light;
        if (colors.dark) cell.darkBackgroundColor ??= colors.dark;
      } else {
        cell.color ??= colors.light;
        if (colors.dark) cell.darkColor ??= colors.dark;
      }
    }
    return true;
  }

  const shorthandColors = normalizeTableColorPair(modifier);
  if (shorthandColors) {
    cell.backgroundColor ??= shorthandColors.light;
    if (shorthandColors.dark) cell.darkBackgroundColor ??= shorthandColors.dark;
    return true;
  }
  return false;
}

function addTableModifierWarning(errors: string[], modifier: string) {
  const warning = `올바르지 않은 표 제어자를 무시했습니다: <${modifier.slice(0, 80)}>`;
  if (!errors.includes(warning)) errors.push(warning);
}

function clampTableSpan(value: string | undefined) {
  return Math.max(1, Math.min(1000, Number(value) || 1));
}

function normalizeTableSize(value: string) {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(px|%)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) return null;
  return `${amount}${match[2]?.toLowerCase() ?? 'px'}`;
}

function normalizeTableColor(value: string) {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^[a-z]{1,32}$/i.test(color)) return color;
  return null;
}

function normalizeTableColorPair(value: string): { light: string; dark?: string } | null {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length < 1 || parts.length > 2) return null;
  const light = normalizeTableColor(parts[0] ?? '');
  const dark = parts.length === 2 ? normalizeTableColor(parts[1] ?? '') : null;
  if (!light || (parts.length === 2 && !dark)) return null;
  return { light, ...(dark ? { dark } : {}) };
}

function validateWikiFileName(fileName: string, blockingErrors: string[]) {
  if (!fileName || !/^[^<>:"|?*\\/]+$/.test(fileName)) {
    const warning = `파일명에 금지 문자가 포함되어 있습니다: ${fileName || '(빈 파일명)'}`;
    if (!blockingErrors.includes(warning)) blockingErrors.push(warning);
  }
}

/**
 * Applies include parameters to an already parsed AST. Values therefore remain
 * plain data and cannot inject new wiki syntax, HTML, or nested includes.
 */
export function applyIncludeParametersToAst(
  ast: readonly AstNode[],
  params: Readonly<Record<string, string>>,
  headingPrefix: string
): AstNode[] {
  const replace = (value: string) => value.replace(
    /@([A-Za-z0-9가-힣_]+)(?:=([^@\n]*))?@/gu,
    (_match, key: string, fallback: string | undefined) => params[key] ?? fallback ?? ''
  );
  const inline = (nodes: readonly InlineNode[]): InlineNode[] => nodes.map((node) => {
    if (node.type === 'internal_link') return { ...node, target: replace(node.target), label: replace(node.label) };
    if (node.type === 'external_link') return { ...node, href: replace(node.href), label: replace(node.label) };
    if (node.type === 'code') return { ...node, code: replace(node.code) };
    if (node.type === 'file') return {
      ...node,
      fileName: replace(node.fileName),
      caption: node.caption === null ? null : replace(node.caption)
    };
    if (node.type === 'unsupported_macro') return { ...node };
    if (node.type === 'line_break' || node.type === 'clearfix') return { ...node };
    if (node.type === 'anchor') return { ...node, id: normalizeMacroAnchor(replace(node.id)) };
    if (node.type === 'ruby') return { ...node, text: replace(node.text), ruby: replace(node.ruby) };
    return { ...node, text: replace(node.text) };
  });
  const list = (node: WikiListNode): WikiListNode => ({
    ...node,
    items: node.items.map((item) => ({
      children: inline(item.children),
      nested: item.nested.map(list)
    }))
  });
  return ast.map((node): AstNode => {
    if (node.type === 'heading') {
      const text = replace(node.text);
      return { ...node, text, id: `${headingPrefix}${makeHeadingId(text)}` };
    }
    if (node.type === 'paragraph' || node.type === 'blockquote') return { ...node, children: inline(node.children) };
    if (node.type === 'list') return list(node);
    if (node.type === 'wiki_table') return {
      ...node,
      caption: inline(node.caption),
      rows: node.rows.map((row) => row.map((cell) => ({ ...cell, children: inline(cell.children) })))
    };
    if (node.type === 'folding') return {
      ...node,
      title: inline(node.title),
      children: applyIncludeParametersToAst(node.children, params, headingPrefix)
    };
    if (node.type === 'component') return {
      ...node,
      props: Object.fromEntries(Object.entries(node.props).map(([key, value]) => [key, replace(value)]))
    };
    if (node.type === 'category') return { ...node, title: replace(node.title) };
    if (node.type === 'file') return {
      ...node,
      fileName: replace(node.fileName),
      caption: node.caption === null ? null : replace(node.caption)
    };
    if (node.type === 'redirect') return { ...node, target: replace(node.target) };
    if (node.type === 'include') return {
      ...node,
      target: replace(node.target),
      params: Object.fromEntries(Object.entries(node.params).map(([key, value]) => [key, replace(value)])),
      children: node.children ? applyIncludeParametersToAst(node.children, params, headingPrefix) : undefined
    };
    // Literal code blocks deliberately do not interpolate include parameters.
    return { ...node };
  });
}

function parseInline(
  input: string,
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[]
): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /(?<file>\[\[파일:(?<fileName>[^|\]]+)(?:\|(?<fileOption>[^|\]]+))?(?:\|(?<fileCaption>[^|\]]+))?\]\])|(?<refXml><ref>(?<refXmlText>.*?)<\/ref>)|(?<refShort>\[\*(?<refName>[^\s\]]+)?\s*(?<refShortText>[^\]]+?)\])|(?<code><code>(?<codeText>.*?)<\/code>)|(?<color>\{\{\{#(?<colorValue>[A-Za-z0-9#(),._-]+)\s+(?<colorText>.+?)\}\}\})|(?<size>\{\{\{(?<sizeValue>[+-]\d+)\s+(?<sizeText>.+?)\}\}\})|(?<externalWiki>\[\[(?<externalWikiHref>https?:\/\/[^\]|]+)(?:\|(?<externalWikiLabel>.+?))?\]\])|(?<internal>\[\[(?<internalTarget>.+?)(?:\|(?<internalLabel>.+?))?\]\])|(?<external>\[(?<externalHref>https?:\/\/[^\s\]]+)\s+(?<externalLabel>.+?)\])|(?<macro>\[(?<macroName>[A-Za-z가-힣][A-Za-z0-9가-힣_-]*)(?:\((?<macroArgs>[^\]\n]*)\))?\])|(?<bold>'''(?<boldText>.+?)''')|(?<italic>''(?<italicText>.+?)'')|(?<strikeTilde>~~(?<strikeTildeText>.+?)~~)|(?<strikeDash>--(?<strikeDashText>.+?)--)|(?<underline>__(?<underlineText>.+?)__)|(?<sup>\^\^(?<supText>.+?)\^\^)|(?<sub>,,(?<subText>.+?),,)/gu;
  let last = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index! > last) nodes.push({ type: 'text', text: input.slice(last, match.index) });
    const group = match.groups ?? {};
    if (group.file !== undefined) {
      const fileName = group.fileName?.trim() ?? '';
      validateWikiFileName(fileName, blockingErrors);
      const thumbnail = group.fileOption?.trim() === '섬네일';
      const caption = group.fileCaption?.trim() || (!thumbnail ? group.fileOption?.trim() : '') || null;
      nodes.push({ type: 'file', fileName, thumbnail, caption });
    } else if (group.refXml !== undefined || group.refShort !== undefined) {
      const note = group.refXmlText ?? group.refShortText ?? '';
      if (!note.trim()) errors.push('빈 각주가 있습니다.');
      footnotes.push(note);
      nodes.push({ type: 'ref', text: note });
    } else if (group.code !== undefined) {
      nodes.push({ type: 'code', code: group.codeText ?? '' });
    } else if (group.color !== undefined) {
      nodes.push({ type: 'color', color: normalizeInlineColor(group.colorValue ?? ''), text: group.colorText ?? '' });
    } else if (group.size !== undefined) {
      nodes.push({ type: 'size', delta: normalizeInlineSize(group.sizeValue ?? ''), text: group.sizeText ?? '' });
    } else if (group.externalWiki !== undefined) {
      const href = group.externalWikiHref ?? '';
      nodes.push({ type: 'external_link', href, label: group.externalWikiLabel ?? href });
    } else if (group.internal !== undefined) {
      const target = normalizeTitle(group.internalTarget ?? '');
      links.add(target);
      nodes.push({ type: 'internal_link', target, label: group.internalLabel ?? target });
    } else if (group.external !== undefined) {
      const href = group.externalHref ?? '';
      nodes.push({ type: 'external_link', href, label: group.externalLabel ?? href });
    } else if (group.macro !== undefined) {
      const name = (group.macroName ?? '').slice(0, 64);
      const macro = parseSafeInlineMacro(name, group.macroArgs, errors);
      nodes.push(macro);
    } else if (group.bold !== undefined) {
      nodes.push({ type: 'bold', text: group.boldText ?? '' });
    } else if (group.italic !== undefined) {
      nodes.push({ type: 'italic', text: group.italicText ?? '' });
    } else if (group.strikeTilde !== undefined || group.strikeDash !== undefined) {
      nodes.push({ type: 'strike', text: group.strikeTildeText ?? group.strikeDashText ?? '' });
    } else if (group.underline !== undefined) {
      nodes.push({ type: 'underline', text: group.underlineText ?? '' });
    } else if (group.sup !== undefined) {
      nodes.push({ type: 'sup', text: group.supText ?? '' });
    } else if (group.sub !== undefined) {
      nodes.push({ type: 'sub', text: group.subText ?? '' });
    }
    last = match.index! + match[0].length;
  }
  if (last < input.length) nodes.push({ type: 'text', text: input.slice(last) });
  return nodes;
}

function parseSafeInlineMacro(name: string, rawArgs: string | undefined, errors: string[]): InlineNode {
  const normalizedName = name.toLowerCase();
  if (normalizedName === 'br' && rawArgs === undefined) return { type: 'line_break' };
  if (normalizedName === 'clearfix' && rawArgs === undefined) return { type: 'clearfix' };
  if (normalizedName === 'anchor' && rawArgs !== undefined) {
    const id = normalizeMacroAnchor(rawArgs);
    if (id) return { type: 'anchor', id };
  }
  if (normalizedName === 'ruby' && rawArgs !== undefined) {
    const [text = '', ...parameters] = splitMacroArguments(rawArgs);
    let ruby = '';
    let color: string | null = null;
    for (const parameter of parameters) {
      if (parameter.startsWith('ruby=')) ruby = parameter.slice('ruby='.length);
      else if (parameter.startsWith('color=')) color = normalizeTableColor(parameter.slice('color='.length));
    }
    if (text && ruby) return { type: 'ruby', text, ruby, color };
  }
  const warning = `지원되지 않는 매크로입니다: ${name}`;
  if (!errors.includes(warning)) errors.push(warning);
  return { type: 'unsupported_macro', name };
}

function splitMacroArguments(value: string) {
  const values: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === ',') {
      values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  values.push(current.trim());
  return values;
}

function normalizeMacroAnchor(value: string) {
  const trimmed = value.trim();
  if (/[^A-Za-z0-9가-힣_.:\s-]/u.test(trimmed)) return '';
  return trimmed
    .replace(/\s+/gu, '_')
    .slice(0, 128);
}

export interface RenderOptions {
  missingLinks?: Set<string>;
  /** Route prefix used for unqualified links inside an isolated subwiki. */
  internalLinkBasePath?: string;
  files?: Record<string, { url: string; mimeType: string; originalName: string; license?: string | null; sourceUrl?: string | null; sourceText?: string | null }>;
  officialAreas?: Record<string, { status: string; lastModifiedAt?: string | null; renewalRequiredAt?: string | null }>;
  dataTables?: Record<string, { caption: string; headers: string[]; rows: string[][] }>;
  /** Internal heading scope shared by folding blocks, but not transclusions. */
  tocHeadings?: ReadonlyArray<{ level: number; text: string; id: string }>;
}

export function renderDocument(ast: AstNode[], options: RenderOptions = {}): string {
  const footnotes: string[] = [];
  const tocHeadings = options.tocHeadings ?? collectTocHeadings(ast);
  const html = ast
    .map((node) => {
      if (node.type === 'heading') return `<h${node.level} id="${escapeAttr(node.id)}">${escapeHtml(node.text)}</h${node.level}>`;
      if (node.type === 'paragraph') return `<p>${renderInline(node.children, footnotes, options)}</p>`;
      if (node.type === 'list') return renderWikiList(node, footnotes, options);
      if (node.type === 'blockquote') return `<blockquote class="wiki-quote">${renderInline(node.children, footnotes, options)}</blockquote>`;
      if (node.type === 'hr') return '<hr>';
      if (node.type === 'wiki_table') return renderWikiTable(node.caption, node.rows, node.options, footnotes, options);
      if (node.type === 'folding') return `<details class="fold wiki-fold"><summary>${renderInline(node.title, footnotes, options)}</summary>${renderDocument(node.children, { ...options, tocHeadings })}</details>`;
      if (node.type === 'toc') return renderTableOfContents(tocHeadings, node.collapsed);
      if (node.type === 'include') {
        if (node.state === 'resolved' && node.children) {
          return `<section class="wiki-transclusion">${renderDocument(node.children, options)}</section>`;
        }
        const message = node.state === 'unavailable'
          ? '포함 문서를 불러올 수 없습니다.'
          : '포함 문서는 저장한 뒤 표시됩니다.';
        return `<aside class="wiki-include-notice">${message}</aside>`;
      }
      if (node.type === 'category') return '';
      if (node.type === 'file') return renderFile(node.fileName, node.thumbnail, node.caption, options);
      if (node.type === 'redirect') return `<p class="notice">넘겨주기: ${renderInternalLink(node.target, node.target, options)}</p>`;
      if (node.type === 'codeblock') {
        return `<pre class="codeblock" data-lang="${escapeAttr(node.lang ?? '')}"><code>${escapeHtml(node.code)}</code></pre>`;
      }
      return renderComponent(node.name, node.props, options);
    })
    .join('\n');
  const footnoteHtml =
    footnotes.length > 0
      ? `<section class="footnotes"><h2>각주</h2><ol>${footnotes
          .map((note, index) => `<li id="fn-${index + 1}">${escapeHtml(note)}</li>`)
          .join('')}</ol></section>`
      : '';
  return sanitizeHtml(`${html}${footnoteHtml}`, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'class', 'rel', 'target', 'title'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      pre: ['class', 'data-lang'],
      code: ['class'],
      div: ['class', 'data-*', 'style'],
      aside: ['class'],
      figure: ['class'],
      img: ['src', 'alt', 'loading'],
      figcaption: ['class'],
      section: ['class'],
      nav: ['class', 'aria-label'],
      blockquote: ['class'],
      caption: ['class'],
      span: ['class', 'style', 'title', 'id'],
      ruby: ['class'],
      rt: ['class'],
      rp: ['class'],
      s: ['class'],
      u: ['class'],
      sup: ['class'],
      sub: ['class'],
      table: ['class', 'data-table-key', 'style'],
      th: ['class', 'colspan', 'rowspan', 'style'],
      td: ['class', 'colspan', 'rowspan', 'style'],
      details: ['class', 'open'],
      ul: ['class'],
      ol: ['class', 'start', 'type'],
      li: ['class'],
      summary: ['class']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedStyles: {
      span: {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i, /^[a-z]+$/i],
        'font-size': [/^\d+(\.\d+)?em$/]
      },
      div: {
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        'margin-left': [/^auto$/],
        'margin-right': [/^auto$/]
      },
      table: {
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        border: [/^2px solid (?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-background-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-border-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i]
      },
      th: {
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        height: [/^\d+(?:\.\d+)?(?:px|%)$/],
        color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'text-align': [/^(?:left|center|right)$/],
        'vertical-align': [/^(?:top|middle|bottom)$/],
        '--wiki-dark-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-background-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i]
      },
      td: {
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        height: [/^\d+(?:\.\d+)?(?:px|%)$/],
        color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'text-align': [/^(?:left|center|right)$/],
        'vertical-align': [/^(?:top|middle|bottom)$/],
        '--wiki-dark-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-background-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i]
      }
    }
  });
}

function collectTocHeadings(ast: readonly AstNode[]): Array<{ level: number; text: string; id: string }> {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  for (const node of ast) {
    if (node.type === 'heading') headings.push(node);
    // Included headings belong to their own heading scope and must not leak into
    // the caller's table of contents.
    if (node.type === 'folding') headings.push(...collectTocHeadings(node.children));
  }
  return headings;
}

function renderTableOfContents(
  headings: ReadonlyArray<{ level: number; text: string; id: string }>,
  collapsed: boolean
) {
  if (headings.length === 0) {
    return '<aside class="wiki-toc-empty">목차에 표시할 제목이 없습니다.</aside>';
  }
  const counters = [0, 0, 0];
  const items = headings.map((heading) => {
    const depth = Math.max(0, Math.min(2, heading.level - 2));
    counters[depth] = (counters[depth] ?? 0) + 1;
    for (let index = depth + 1; index < counters.length; index += 1) counters[index] = 0;
    const number = counters.slice(0, depth + 1).filter(Boolean).join('.');
    return `<li class="wiki-toc-level-${depth + 1}"><a href="#${escapeAttr(heading.id)}"><span>${number}</span>${escapeHtml(heading.text)}</a></li>`;
  }).join('');
  return `<nav class="wiki-toc" aria-label="문서 목차"><details${collapsed ? '' : ' open'}><summary>목차</summary><ol>${items}</ol></details></nav>`;
}

export function renderInline(nodes: InlineNode[], footnotes: string[], options: RenderOptions = {}) {
  return nodes
    .map((node) => {
      if (node.type === 'text') return escapeHtml(node.text);
      if (node.type === 'line_break') return '<br>';
      if (node.type === 'clearfix') return '<span class="wiki-clearfix"></span>';
      if (node.type === 'anchor') return node.id ? `<span class="wiki-anchor" id="${escapeAttr(node.id)}"></span>` : '';
      if (node.type === 'ruby') {
        const ruby = node.color
          ? `<span style="color: ${escapeAttr(node.color)}">${escapeHtml(node.ruby)}</span>`
          : escapeHtml(node.ruby);
        return `<ruby>${escapeHtml(node.text)}<rp>(</rp><rt>${ruby}</rt><rp>)</rp></ruby>`;
      }
      if (node.type === 'bold') return `<strong>${escapeHtml(node.text)}</strong>`;
      if (node.type === 'italic') return `<em>${escapeHtml(node.text)}</em>`;
      if (node.type === 'strike') return `<s>${escapeHtml(node.text)}</s>`;
      if (node.type === 'underline') return `<u>${escapeHtml(node.text)}</u>`;
      if (node.type === 'sup') return `<sup>${escapeHtml(node.text)}</sup>`;
      if (node.type === 'sub') return `<sub>${escapeHtml(node.text)}</sub>`;
      if (node.type === 'color') return `<span class="${inlineColorClass(node.color)}" style="color: ${escapeAttr(node.color)}">${escapeHtml(node.text)}</span>`;
      if (node.type === 'size') return `<span class="wiki-size" style="font-size: ${inlineSizeEm(node.delta)}em">${escapeHtml(node.text)}</span>`;
      if (node.type === 'code') return `<code>${escapeHtml(node.code)}</code>`;
      if (node.type === 'external_link') {
        return `<a href="${escapeAttr(node.href)}" rel="nofollow noopener" target="_blank">${escapeHtml(node.label)}</a>`;
      }
      if (node.type === 'internal_link') return renderInternalLink(node.target, node.label, options);
      if (node.type === 'file') return renderFile(node.fileName, node.thumbnail, node.caption, options, true);
      if (node.type === 'unsupported_macro') {
        return `<span class="wiki-macro-warning" title="지원되지 않는 매크로">지원하지 않는 매크로: [${escapeHtml(node.name)}]</span>`;
      }
      const index = footnotes.push(node.text);
      return `<sup><a href="#fn-${index}">[${index}]</a></sup>`;
    })
    .join('');
}

export function collectWikiFileNames(ast: readonly AstNode[], output = new Set<string>()): Set<string> {
  const collectInline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') output.add(node.fileName);
    }
  };
  const collectList = (list: WikiListNode) => {
    for (const item of list.items) {
      collectInline(item.children);
      for (const nested of item.nested) collectList(nested);
    }
  };

  for (const node of ast) {
    if (node.type === 'file') output.add(node.fileName);
    else if (node.type === 'paragraph' || node.type === 'blockquote') collectInline(node.children);
    else if (node.type === 'list') collectList(node);
    else if (node.type === 'wiki_table') {
      collectInline(node.caption);
      for (const row of node.rows) for (const cell of row) collectInline(cell.children);
    } else if (node.type === 'folding' || (node.type === 'include' && node.children)) {
      collectWikiFileNames(node.children, output);
    }
  }
  return output;
}

function renderInternalLink(target: string, label: string, options: RenderOptions = {}) {
  const parsed = parseLinkTarget(target);
  const missing = options.missingLinks?.has(wikiLinkKey(target));
  const className = missing ? 'wiki-link missing' : 'wiki-link';
  const titleAttr = missing ? ' title="문서 없음"' : '';
  const unqualified = parsed.namespace === 'main' && !target.includes(':');
  const href = unqualified && options.internalLinkBasePath
    ? `${options.internalLinkBasePath.replace(/\/$/, '')}/${slugifyTitle(parsed.title)
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`
    : wikiUrl(parsed.namespace, parsed.title);
  return `<a class="${className}" href="${href}"${titleAttr}>${escapeHtml(label)}</a>`;
}

function renderComponent(name: string, props: Record<string, string>, options: RenderOptions = {}) {
  const rows = Object.entries(props)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(formatComponentValue(key, value))}</td></tr>`)
    .join('');

  if (name === 'document_status') {
    return `<aside class="doc-status"><strong>${escapeHtml(props['상태'] ?? '상태 없음')}</strong><span>${escapeHtml(
      props['기준'] ?? ''
    )}</span><small>${escapeHtml(props['사유'] ?? formatComponentValue('확인일', props['확인일'] ?? ''))}</small></aside>`;
  }
  if (name === 'front_intro') return `<section class="front-wiki-component"><h2>${escapeHtml(props['제목'] ?? 'MineWiki')}</h2><p>${escapeHtml(props['설명'] ?? '')}</p></section>`;
  if (name === 'front_search') return `<section class="front-wiki-component"><form class="search-page" action="/search" method="get"><input name="q" placeholder="${escapeAttr(props['예시'] ?? '검색')}"><button>검색</button></form></section>`;
  if (name === 'front_card') {
    const links = Object.entries(props)
      .filter(([key, value]) => /^링크\d+$/.test(key) && value)
      .map(([, value]) => renderSearchLink(value))
      .join(' · ');
    const target = props['대상'] ?? '/wiki';
    const title = props['제목'] ?? '문서';
    const heading = isSafeLocalHref(target) ? `<a href="${escapeAttr(target)}">${escapeHtml(title)}</a>` : renderInternalLink(target, title, options);
    return `<section class="front-wiki-component"><h2>${heading}</h2><p>${escapeHtml(props['설명'] ?? '')}</p><p>${links}</p></section>`;
  }
  if (name === 'server_operator_notice') {
    const buttons = [1, 2]
      .map((index) => {
        const label = props[`버튼${index}`];
        const href = props[`링크${index}`];
        if (!label || !isSafeLocalHref(href)) return '';
        return `<a class="button${index > 1 ? ' ghost' : ''}" href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
      })
      .filter(Boolean)
      .join('');
    return `<aside class="doc-status"><strong>${escapeHtml(props['제목'] ?? '서버 운영자라면?')}</strong><span>${escapeHtml(props['설명'] ?? '')}</span>${buttons ? `<div class="quick-actions">${buttons}</div>` : ''}</aside>`;
  }
  if (name === 'crafting_recipe') {
    const cells = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']
      .map((key) => `<span>${escapeHtml(props[key] && props[key] !== '없음' ? props[key] : '')}</span>`)
      .join('');
    return `<div class="recipe"><div class="recipe-grid">${cells}</div><div class="recipe-result">${escapeHtml(
      `${props['결과'] ?? ''}${props['개수'] ? ` x${props['개수']}` : ''}`
    )}</div></div>`;
  }
  if (name === 'fold') {
    return `<details class="fold"><summary>${escapeHtml(props['제목'] ?? '펼치기')}</summary><p>${escapeHtml(
      props['내용'] ?? ''
    )}</p></details>`;
  }
  if (name === 'official_area') {
    const target = props['문서'] ?? '';
    const area = options.officialAreas?.[target];
    const statusText =
      area?.status === 'verified'
        ? '인증된 서버 운영자가 관리하는 공식 문서입니다.'
        : area?.status === 'renewal_required'
          ? '이 서버의 운영자 인증 갱신이 필요합니다. 공식 정보가 최신이 아닐 수 있습니다.'
          : '이 문서의 운영자 인증 상태를 확인해야 합니다.';
    const meta = area
      ? `<small>마지막 수정: ${escapeHtml(formatComponentValue('마지막 수정', String(area.lastModifiedAt ?? '확인 전')))}${area.renewalRequiredAt ? ` · 인증 갱신 필요일: ${escapeHtml(formatComponentValue('인증 갱신', String(area.renewalRequiredAt)))}` : ''}</small>`
      : '';
    return `<aside class="official-area"><strong>공식 문서</strong><span>${statusText}</span>${renderInternalLink(target, '문서 보기', options)}${meta}</aside>`;
  }
  if (name === 'server_notice') return '<aside class="warning">서버 사건 서술은 출처와 사실 확인을 우선합니다.</aside>';
  if (name === 'quote_box') return `<blockquote class="quote-box">${escapeHtml(props['내용'] ?? '')}</blockquote>`;
  if (name === 'simple_table') return renderSimpleRows(props, props['열'], '표');
  if (name === 'data_table') return renderDataTable(props, options);
  if (name === 'drop_table') return renderSimpleRows(props, '아이템,종류,비고', '드롭 표');
  if (name === 'smelting_recipe') return `<div class="recipe"><div class="recipe-result">${escapeHtml(props['입력'] ?? '')}</div><span>+</span><div class="recipe-result">${escapeHtml(props['연료'] ?? '')}</div><span>→</span><div class="recipe-result">${escapeHtml(props['결과'] ?? '')}</div></div>`;
  if (name === 'brewing_recipe') return `<aside class="infobox"><h2>양조법</h2><table>${rows}</table></aside>`;
  if (name === 'villager_trade') return `<aside class="infobox"><h2>주민 거래</h2><table>${rows}</table></aside>`;
  if (name === 'edition_diff') {
    return `<div class="edition-diff"><section><h3>Java Edition</h3><p>${escapeHtml(props.Java ?? '')}</p></section><section><h3>Bedrock Edition</h3><p>${escapeHtml(props.Bedrock ?? '')}</p></section></div>`;
  }
  if (name === 'version_history') return renderVersionHistory(props);
  if (name === 'mod_version_table') {
    const hasRows = Object.keys(props).some((key) => /^행\d+$/.test(key)) || Boolean(props.Minecraft || props['마인크래프트'] || props['버전']);
    if (hasRows) return renderSimpleRows(props, props['열'] || 'Minecraft,로더,상태,비고', '모드 버전표');
    return `<aside class="doc-status"><strong>모드 버전표</strong><span>${escapeHtml(props['모드'] ?? '')} 지원 버전은 모드 데이터 섹션에 표시됩니다.</span></aside>`;
  }
  if (name === 'develop_status') {
    const status = [props['대상'], props['버전'], props['검증'], props['출처'], formatComponentValue('확인일', props['확인일'] ?? '')].filter(Boolean).join(' · ');
    return `<aside class="doc-status develop-status"><strong>개발 문서 상태</strong><span>${escapeHtml(status || '버전 기준과 출처 확인이 필요합니다.')}</span></aside>`;
  }
  if (name === 'version_support') return renderSimpleRows(props, props['열'] || '버전,지원,상태,비고', '버전 지원표');
  if (name === 'code_example') {
    const lang = props['언어'] ?? '';
    return `<figure class="code-example"><figcaption>${escapeHtml(props['제목'] ?? '코드 예제')}${lang ? ` · ${escapeHtml(lang)}` : ''}</figcaption><pre class="codeblock" data-lang="${escapeAttr(lang)}"><code>${escapeHtml(props['코드'] ?? '')}</code></pre></figure>`;
  }
  if (name === 'warning_box') return `<aside class="warning"><strong>${escapeHtml(props['제목'] ?? '주의')}</strong><span>${escapeHtml(props['내용'] ?? '')}</span></aside>`;
  if (name === 'official_doc_link') return `<aside class="doc-status official-doc-link"><strong>공식 문서</strong><span>${renderExternalLink(props['URL'] ?? '', props['제목'] ?? props['URL'] ?? '공식 문서')}</span>${props['확인일'] ? `<small>${escapeHtml(formatComponentValue('확인일', props['확인일']))}</small>` : ''}</aside>`;
  if (name === 'dependency_info') return renderSimpleRows(props, props['열'] || '이름,범위,버전,비고', '의존성 정보');
  if (name === 'gradle_setup') return `<figure class="code-example"><figcaption>Gradle 설정</figcaption><pre class="codeblock" data-lang="gradle"><code>${escapeHtml(props['내용'] ?? '')}</code></pre></figure>`;
  if (name === 'maven_setup') return `<figure class="code-example"><figcaption>Maven 설정</figcaption><pre class="codeblock" data-lang="xml"><code>${escapeHtml(props['내용'] ?? '')}</code></pre></figure>`;
  if (name === 'nbt_structure') return renderSimpleRows(props, props['열'] || '태그,타입,설명', 'NBT 구조');
  if (name === 'protocol_fields') return renderSimpleRows(props, props['열'] || '필드,타입,설명', '프로토콜 필드 표');
  if (name === 'references') return '';
  return `<aside class="infobox infobox-${escapeAttr(name)}"><h2>${componentTitle(name, props)}</h2><table>${rows}</table></aside>`;
}

function componentTitle(name: string, props: Record<string, string>) {
  const label: Record<string, string> = {
    mob_info: '몹 정보',
    block_info: '블록 정보',
    item_info: '아이템 정보',
    mod_info: '모드 정보',
    server_info: '서버 정보',
    command_info: '명령어 정보',
    data_table: '데이터 표',
    mod_version_table: '모드 버전표',
    develop_status: '개발 문서 상태',
    api_info: 'API 정보',
    packet_info: '패킷 정보',
    data_type_info: '데이터 타입',
    version_support: '버전 지원표',
    dependency_info: '의존성 정보'
  };
  return escapeHtml(`${props['이름'] ?? props['명령어'] ?? ''} ${label[name] ?? name}`.trim());
}

function renderFile(fileName: string, thumbnail: boolean, caption: string | null, options: RenderOptions, inline = false) {
  const file = options.files?.[fileName];
  if (!file) {
    if (inline) {
      return `<span class="${thumbnail ? 'wiki-file wiki-file-inline thumb missing-file' : 'wiki-file wiki-file-inline missing-file'}">파일 없음: ${escapeHtml(fileName)}</span>`;
    }
    return `<figure class="${thumbnail ? 'wiki-file thumb missing-file' : 'wiki-file missing-file'}"><figcaption>파일 없음: ${escapeHtml(fileName)}</figcaption></figure>`;
  }
  const license = file.license ? `라이선스: ${wikiFileLicenseLabel(file.license)}` : '';
  const sourceLabel = file.sourceText?.trim() || '원본 출처';
  const source = file.sourceUrl
    ? `출처: ${renderExternalLink(file.sourceUrl, sourceLabel)}`
    : file.sourceText
      ? `출처: ${escapeHtml(file.sourceText)}`
      : '';
  const metaHtml = license || source ? `<small>${license ? escapeHtml(license) : ''}${license && source ? ' · ' : ''}${source}</small>` : '';
  if (inline) {
    return `<span class="${thumbnail ? 'wiki-file wiki-file-inline thumb' : 'wiki-file wiki-file-inline'}"><img src="${escapeAttr(file.url)}" alt="${escapeAttr(caption ?? file.originalName)}" loading="lazy">${caption ? `<span>${escapeHtml(caption)}</span>` : ''}${metaHtml}</span>`;
  }
  return `<figure class="${thumbnail ? 'wiki-file thumb' : 'wiki-file'}"><img src="${escapeAttr(file.url)}" alt="${escapeAttr(caption ?? file.originalName)}" loading="lazy">${caption ? `<figcaption>${escapeHtml(caption)}${metaHtml}</figcaption>` : metaHtml}</figure>`;
}

function wikiFileLicenseLabel(value: string): string {
  return ({
    'self-created': '직접 제작',
    'cc-by-4.0': 'CC BY 4.0',
    'cc-by-sa-4.0': 'CC BY-SA 4.0',
    'cc0-1.0': 'CC0 1.0',
    'public-domain': '퍼블릭 도메인',
    'fair-use': '공정 이용',
    'permission-granted': '권리자 이용 허락'
  } as Record<string, string>)[value] ?? value;
}

function renderSimpleRows(props: Record<string, string>, headerText = '', caption = '표') {
  const headers = (headerText || '').split(',').map((item) => item.trim()).filter(Boolean);
  const rows = Object.entries(props)
    .filter(([key]) => /^행\d+$/.test(key))
    .map(([, value]) => value.split(',').map((cell) => cell.trim()));
  return wrapTable(`<table class="component-table"><caption>${escapeHtml(caption)}</caption>${headers.length ? `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>` : ''}<tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`);
}

function renderDataTable(props: Record<string, string>, options: RenderOptions) {
  const key = dataTableKey(props);
  const stored = options.dataTables?.[key];
  const caption = stored?.caption ?? props['제목'] ?? props['이름'] ?? '데이터 표';
  const headers = stored?.headers ?? splitCells(props['열'] ?? '');
  const rows = stored?.rows ?? Object.entries(props)
    .filter(([rowKey]) => /^행\d+$/.test(rowKey))
    .sort(([a], [b]) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
    .map(([, value]) => splitCells(value));
  const head = headers.length ? `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>` : '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : '<tr><td>등록된 데이터가 없습니다.</td></tr>';
  return wrapTable(`<table class="component-table data-table" data-table-key="${escapeAttr(key)}"><caption>${escapeHtml(caption)}</caption>${head}<tbody>${body}</tbody></table>`);
}

function dataTableKey(props: Record<string, string>) {
  return normalizeTitle(props['키'] ?? props['이름'] ?? props['제목'] ?? 'default')
    .replace(/[^\p{Letter}\p{Number}_-]/gu, '_')
    .slice(0, 128) || 'default';
}

function splitCells(value: string) {
  return value.split(',').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
}

function renderExternalLink(href: string, label: string) {
  const url = href.trim();
  if (!/^https?:\/\//i.test(url)) return escapeHtml(label || '공식 문서');
  return `<a href="${escapeAttr(url)}" rel="nofollow noopener" target="_blank">${escapeHtml(label || url)}</a>`;
}

function isSafeLocalHref(value: string) {
  return value.startsWith('/') && !value.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(value);
}

function renderSearchLink(value: string) {
  return `<a class="wiki-link" href="/search?q=${encodeURIComponent(value)}">${escapeHtml(value)}</a>`;
}

function renderVersionHistory(props: Record<string, string>) {
  return wrapTable(`<table class="component-table"><caption>버전 역사</caption><tbody>${Object.entries(props)
    .map(([version, text]) => `<tr><th>${escapeHtml(version)}</th><td>${escapeHtml(text)}</td></tr>`)
    .join('')}</tbody></table>`);
}

function renderWikiList(node: WikiListNode, footnotes: string[], options: RenderOptions): string {
  const ordered = node.kind !== 'unordered';
  const tag = ordered ? 'ol' : 'ul';
  const className = {
    unordered: 'wiki-list',
    decimal: 'wiki-list',
    'lower-alpha': 'wiki-list wiki-list-alpha',
    'upper-alpha': 'wiki-list wiki-list-upper-alpha',
    'lower-roman': 'wiki-list wiki-list-roman',
    'upper-roman': 'wiki-list wiki-list-upper-roman'
  }[node.kind];
  const start = ordered && node.start !== 1 ? ` start="${node.start}"` : '';
  const type = {
    unordered: '',
    decimal: '',
    'lower-alpha': ' type="a"',
    'upper-alpha': ' type="A"',
    'lower-roman': ' type="i"',
    'upper-roman': ' type="I"'
  }[node.kind];
  return `<${tag} class="${className}"${start}${type}>${node.items
    .map((item) => `<li>${renderInline(item.children, footnotes, options)}${item.nested
      .map((nested) => renderWikiList(nested, footnotes, options))
      .join('')}</li>`)
    .join('')}</${tag}>`;
}

function renderWikiTable(
  caption: InlineNode[],
  rows: WikiTableCell[][],
  tableOptions: WikiTableOptions,
  footnotes: string[],
  options: RenderOptions
) {
  const tableStyles = styleAttribute({
    width: tableOptions.width ? '100%' : undefined,
    color: tableOptions.color,
    'background-color': tableOptions.backgroundColor,
    border: tableOptions.borderColor ? `2px solid ${tableOptions.borderColor}` : undefined,
    '--wiki-dark-color': tableOptions.darkColor,
    '--wiki-dark-background-color': tableOptions.darkBackgroundColor,
    '--wiki-dark-border-color': tableOptions.darkBorderColor
  });
  const wrapperStyles = styleAttribute({
    width: tableOptions.width,
    'margin-left': tableOptions.align === 'center' || tableOptions.align === 'right' ? 'auto' : undefined,
    'margin-right': tableOptions.align === 'center' ? 'auto' : undefined
  });
  const wrapperClass = tableOptions.align ? `table-scroll table-${tableOptions.align}` : 'table-scroll';
  const hasExplicitHeaders = rows.some((row) => row.some((cell) => cell.header));
  let bodyStarted = false;
  const renderedRows = rows.map((row, rowIndex) => {
    const requestedHeader = row.some((cell) => cell.header);
    const isHeader = hasExplicitHeaders ? requestedHeader && !bodyStarted : rowIndex === 0;
    if (!isHeader) bodyStarted = true;
    return {
      isHeader,
      html: `<tr>${row
      .map((cell) => {
        const tag = isHeader ? 'th' : 'td';
        const colspan = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
        const rowspan = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '';
        const styles = styleAttribute({
          width: cell.width,
          height: cell.height,
          color: cell.color,
          'background-color': cell.backgroundColor,
          '--wiki-dark-color': cell.darkColor,
          '--wiki-dark-background-color': cell.darkBackgroundColor,
          'text-align': cell.align,
          'vertical-align': cell.verticalAlign
        });
        return `<${tag}${colspan}${rowspan}${styles}>${renderInline(cell.children, footnotes, options)}</${tag}>`;
      })
      .join('')}</tr>`
    };
  });
  const headRows = renderedRows.filter((row) => row.isHeader).map((row) => row.html).join('');
  const bodyRows = renderedRows.filter((row) => !row.isHeader).map((row) => row.html).join('');
  const captionHtml = caption.length > 0
    ? `<caption class="wiki-table-caption">${renderInline(caption, footnotes, options)}</caption>`
    : '';
  const html = `<table class="component-table wiki-table"${tableStyles}>${captionHtml}${headRows ? `<thead>${headRows}</thead>` : ''}${bodyRows ? `<tbody>${bodyRows}</tbody>` : ''}</table>`;
  return `<div class="${wrapperClass}"${wrapperStyles}>${html}</div>`;
}

function styleAttribute(properties: Record<string, string | undefined>) {
  const value = Object.entries(properties)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, propertyValue]) => `${name}:${propertyValue}`)
    .join(';');
  return value ? ` style="${escapeAttr(value)}"` : '';
}

function wrapTable(html: string) {
  return `<div class="table-scroll">${html}</div>`;
}

function splitWikiTableRow(line: string) {
  const trimmedStart = line.trimStart();
  const withoutStart = trimmedStart.startsWith('||') ? trimmedStart.slice(2) : trimmedStart;
  return withoutStart.replace(/\|\|\s*$/, '').split('||');
}

function normalizeInlineColor(value: string) {
  const raw = String(value).trim();
  const rgb = parseInlineColorRgb(raw);
  if (rgb && /^rgb\(/i.test(raw)) return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const color = raw.split(',')[0].trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^[0-9a-f]{3,8}$/i.test(color)) return `#${color}`;
  if (/^[a-z]+$/i.test(color)) return color.toLowerCase();
  return 'inherit';
}

function inlineColorClass(color: string) {
  return isDarkInlineColor(color) ? 'wiki-color wiki-color-dark-unsafe' : 'wiki-color';
}

function isDarkInlineColor(value: string) {
  const color = String(value).trim().toLowerCase();
  if (!color || color === 'inherit') return false;
  const named: Record<string, string> = {
    black: '#000000',
    brown: '#a52a2a',
    darkblue: '#00008b',
    darkgreen: '#006400',
    darkred: '#8b0000',
    darkslategray: '#2f4f4f',
    darkslategrey: '#2f4f4f',
    dimgray: '#696969',
    dimgrey: '#696969',
    gray: '#808080',
    green: '#008000',
    grey: '#808080',
    indigo: '#4b0082',
    maroon: '#800000',
    mediumblue: '#0000cd',
    midnightblue: '#191970',
    navy: '#000080',
    purple: '#800080',
    saddlebrown: '#8b4513'
  };
  const normalized = named[color] ?? color;
  const rgb = parseInlineColorRgb(normalized);
  if (!rgb) return false;
  return relativeLuminance(rgb) < 0.26;
}

function parseInlineColorRgb(color: string) {
  const hex = color.match(/^#([0-9a-f]{3,8})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 || hex.length === 4
      ? hex.slice(0, 3).split('').map((part) => part + part).join('')
      : hex.slice(0, 6);
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16)
    };
  }
  const rgb = color.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (!rgb) return null;
  return {
    r: Math.max(0, Math.min(255, Number(rgb[1]))),
    g: Math.max(0, Math.min(255, Number(rgb[2]))),
    b: Math.max(0, Math.min(255, Number(rgb[3])))
  };
}

function relativeLuminance(rgb: { r: number; g: number; b: number }) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function normalizeInlineSize(value: string) {
  return Math.max(-5, Math.min(5, Number(value) || 0));
}

function inlineSizeEm(delta: number) {
  return String(Math.max(0.75, Math.min(1.8, 1 + delta * 0.12)));
}

function formatComponentValue(key: string, value: string) {
  if (!value || !/(일|날짜|시간|확인|수정|갱신)$/.test(key)) return value;
  const normalized = value
    .replace(/\b(\d{4})\.(\d{2})\.(\d{2})\.\s+(\d{2}):(\d{2})(?::(\d{2}))?\b/g, '$1.$2.$3. $4:$5')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?\b/g, (_match, year, month, day, hour, minute, second) => {
      if (hour) return `${year}.${month}.${day}. ${hour}:${minute}`;
      return `${year}.${month}.${day}. 00:00`;
    })
    .replace(/\b(\d{4})\.(\d{2})\.(\d{2})\.(?!\s+\d{2}:\d{2})/g, '$1.$2.$3. 00:00');
  if (normalized !== value) return normalized;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}.${pad(parsed.getMonth() + 1)}.${pad(parsed.getDate())}. ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function makeHeadingId(text: string) {
  return normalizeTitle(text).replace(/[^\p{Letter}\p{Number}_ -]/gu, '').replace(/\s+/g, '-');
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

export function escapeAttr(value: string) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
