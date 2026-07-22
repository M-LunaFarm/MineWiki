import sanitizeHtml from 'sanitize-html';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import groovy from 'highlight.js/lib/languages/groovy';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type {
  AstNode,
  InlineNode,
  ParsedDocument,
  WikiCategoryLink,
  WikiFileDisplayOptions,
  WikiListKind,
  WikiListNode,
  WikiTableCell,
  WikiTableOptions,
  WikiTableRow
} from './types.js';
import {
  parseLinkTarget,
  resolveWikiLinkTarget,
  wikiLinkKey,
  wikiUrl,
  type WikiLinkResolutionContext
} from './namespaces.js';
import { normalizeTitle, slugifyTitle } from './normalize.js';
import { evaluateConditionalExpression } from './conditional.js';

export const WIKI_RENDERER_VERSION = 'minewiki-bwm-0.35.0';
const MAX_HIGHLIGHT_CODE_LENGTH = 100_000;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_FOLDING_DEPTH = 16;
const MAX_INDENT_DEPTH = 16;
const MAX_LIST_DEPTH = 32;
const MAX_INCLUDE_OCCURRENCES = 20;
const MAX_INCLUDE_PARAMS = 32;
const MAX_INCLUDE_PARAM_KEY_LENGTH = 64;
const MAX_INCLUDE_PARAM_VALUE_BYTES = 4096;
const MAX_INCLUDE_PARAM_BYTES = 32 * 1024;
const MAX_MATH_SOURCE_BYTES = 4096;
const MAX_MATH_NODES = 50;
const MAX_INLINE_NESTING = 16;
const MAX_FOOTNOTE_NAME_LENGTH = 64;
const MAX_FILE_OPTION_VALUE_LENGTH = 256;
const MAX_FILE_OPTIONS = 16;
const INCLUDE_PARAM_KEY = /^[A-Za-z0-9가-힣_]+$/u;

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('groovy', groovy);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

const codeLanguageAliases: Readonly<Record<string, string>> = {
  cjs: 'javascript',
  conf: 'ini',
  gradle: 'groovy',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  jsonc: 'json',
  kt: 'kotlin',
  md: 'markdown',
  properties: 'ini',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  xhtml: 'xml',
  yml: 'yaml',
};

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
  'noscript',
  'br',
  'time',
  'output',
  'ruby',
  'rp',
  'rt',
  'img',
  'video',
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
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  's',
  'u',
  'sup',
  'sub',
  'section',
  'nav',
  'aside',
  'form',
  'input',
  'button',
  'details',
  'summary',
  'iframe',
  'math',
  'semantics',
  'annotation',
  'mrow',
  'mi',
  'mo',
  'mn',
  'mtext',
  'mspace',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mtable',
  'mtr',
  'mtd',
  'mover',
  'munder',
  'munderover',
  'mpadded',
  'mstyle',
  'mphantom',
  'menclose',
  'svg',
  'path'
];

function readNestedTripleBraceBlock(lines: readonly string[], startIndex: number) {
  const body: string[] = [];
  let depth = 1;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed === '}}}') {
      depth -= 1;
      if (depth === 0) return { body, endIndex: index, closed: true };
      body.push(line);
      continue;
    }
    if (trimmed.startsWith('{{{') && !trimmed.endsWith('}}}')) depth += 1;
    body.push(line);
  }
  return { body, endIndex: Math.max(startIndex, lines.length - 1), closed: false };
}

function parseWikiStyleAttributes(attributes: string) {
  const styleSources = [...attributes.matchAll(/(?:^|\s)style\s*=\s*"([^"]*)"/giu)];
  const darkSources = [...attributes.matchAll(/(?:^|\s)dark-style\s*=\s*"([^"]*)"/giu)];
  const knownAttributes = attributes.replace(/(?:^|\s)(?:dark-)?style\s*=\s*"[^"]*"/giu, ' ').trim();
  const light = parseWikiStyleDeclarations(styleSources.length === 1 ? styleSources[0]?.[1] ?? '' : '', false);
  const dark = parseWikiStyleDeclarations(darkSources.length === 1 ? darkSources[0]?.[1] ?? '' : '', true);
  return {
    writingMode: light.writingMode,
    style: light.style,
    darkStyle: dark.style,
    ignored: knownAttributes.length > 0 || styleSources.length > 1 || darkSources.length > 1 || light.ignored || dark.ignored
  };
}

function parseWikiStyleDeclarations(source: string, dark: boolean) {
  const style: NonNullable<Extract<AstNode, { type: 'wiki_style' }>['style']> = {};
  let writingMode: Extract<AstNode, { type: 'wiki_style' }>['writingMode'] = null;
  let ignored = false;
  const seen = new Set<string>();
  for (const rawDeclaration of source.split(';')) {
    const declaration = rawDeclaration.trim();
    if (!declaration) continue;
    const separator = declaration.indexOf(':');
    if (separator <= 0) { ignored = true; continue; }
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (seen.has(property)) { ignored = true; continue; }
    seen.add(property);
    if (dark && !['color', 'background-color', 'border-color'].includes(property)) { ignored = true; continue; }
    if (property === 'writing-mode' && !dark && /^(?:horizontal-tb|vertical-rl|vertical-lr)$/u.test(value)) {
      writingMode = value as typeof writingMode;
    } else if (property === 'color') {
      const normalized = normalizeTableColor(value); if (normalized) style.color = normalized; else ignored = true;
    } else if (property === 'background-color') {
      const normalized = normalizeTableColor(value); if (normalized) style.backgroundColor = normalized; else ignored = true;
    } else if (property === 'text-align' && !dark && /^(?:left|center|right|justify)$/u.test(value)) {
      style.textAlign = value as NonNullable<typeof style.textAlign>;
    } else if (property === 'border' && !dark) {
      const normalized = normalizeWikiStyleBorder(value); if (normalized) style.border = normalized; else ignored = true;
    } else if (property === 'border-color') {
      const normalized = normalizeTableColor(value); if (normalized) style.borderColor = normalized; else ignored = true;
    } else if (property === 'border-radius' && !dark) {
      const normalized = normalizeWikiStyleSpacing(value, false, 1); if (normalized) style.borderRadius = normalized; else ignored = true;
    } else if (property === 'padding' && !dark) {
      const normalized = normalizeWikiStyleSpacing(value, false); if (normalized) style.padding = normalized; else ignored = true;
    } else if (property === 'margin' && !dark) {
      const normalized = normalizeWikiStyleSpacing(value, true); if (normalized) style.margin = normalized; else ignored = true;
    } else if ((property === 'width' || property === 'max-width') && !dark) {
      const normalized = normalizeWikiStyleSize(value, property);
      if (normalized) style[property === 'width' ? 'width' : 'maxWidth'] = normalized; else ignored = true;
    } else {
      ignored = true;
    }
  }
  return { writingMode, style, ignored };
}

function normalizeWikiStyleBorder(value: string) {
  const match = /^(0|[1-8]px)\s+(solid|dashed|dotted)\s+(#[0-9a-f]{3,8}|[a-z]{1,32})$/iu.exec(value);
  const color = normalizeTableColor(match?.[3] ?? '');
  return match && color ? `${match[1]} ${match[2]?.toLowerCase()} ${color}` : null;
}

function normalizeWikiStyleSpacing(value: string, allowAuto: boolean, maximumParts = 4) {
  const parts = value.split(/\s+/u).filter(Boolean);
  if (parts.length < 1 || parts.length > maximumParts) return null;
  if (!parts.every((part) => (allowAuto && part === 'auto') || /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/u.test(part))) return null;
  if (parts.some((part) => part !== 'auto' && Number.parseFloat(part) > 64)) return null;
  return parts.join(' ');
}

function normalizeWikiStyleSize(value: string, property: 'width' | 'max-width') {
  const match = /^(\d+(?:\.\d+)?)(px|%)$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || (match[2] === '%' ? amount > 100 : amount > 1920)) return null;
  if (property === 'width' && match[2] !== '%') return null;
  return `${amount}${match[2]}`;
}

function mergeNestedMetadata(
  nested: ParsedDocument,
  target: {
    links: Set<string>;
    categories: Set<string>;
    categoryLinks: Map<string, WikiCategoryLink>;
    includes: string[];
    components: Array<{ name: string; props: Record<string, string> }>;
    footnotes: string[];
    errors: string[];
    blockingErrors: string[];
  }
) {
  nested.links.forEach((link) => target.links.add(link));
  nested.categories.forEach((category) => target.categories.add(category));
  nested.categoryLinks.forEach((category) => {
    if (!target.categoryLinks.has(category.title)) target.categoryLinks.set(category.title, category);
  });
  target.includes.push(...nested.includes);
  target.components.push(...nested.components);
  target.footnotes.push(...nested.footnotes);
  target.errors.push(...nested.errors);
  target.blockingErrors.push(...nested.blockingErrors);
}

export interface ParseMarkupOptions {
  linkResolution?: WikiLinkResolutionContext;
  gitBookMarkdown?: boolean;
  headingsAsProse?: boolean;
}

export function parseMarkup(raw: string, options: ParseMarkupOptions | number = {}): ParsedDocument {
  if (typeof options === 'number') return parseMarkupDocument(raw, {}, options);
  return parseMarkupDocument(raw, options, 0);
}

function parseMarkupDocument(
  raw: string,
  options: ParseMarkupOptions,
  foldingDepth: number,
  nestingKind: 'folding' | 'blockquote' | 'indent' | 'table' = 'folding'
): ParsedDocument {
  if (Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) {
    return rejectedDocument('문서 크기 제한을 초과했습니다.');
  }
  if (foldingDepth > MAX_FOLDING_DEPTH) {
    return rejectedDocument(nestingKind === 'blockquote'
      ? '인용문 중첩 제한을 초과했습니다.'
      : nestingKind === 'indent'
        ? `들여쓰기는 ${MAX_INDENT_DEPTH}단계까지 사용할 수 있습니다.`
        : '접기 블록 중첩 제한을 초과했습니다.');
  }
  const source = maskWikiCommentLines(raw.replace(/\r\n/g, '\n'), options.gitBookMarkdown === true);
  const lines = source.split('\n');
  const ast: AstNode[] = [];
  const links = new Set<string>();
  const categories = new Set<string>();
  const categoryLinks = new Map<string, WikiCategoryLink>();
  const includes: string[] = [];
  const components: Array<{ name: string; props: Record<string, string> }> = [];
  const errors: string[] = [];
  const blockingErrors: string[] = [];
  const footnotes: string[] = [];
  let redirectTarget: string | null = null;

  const redirectLineIndex = lines.findIndex((line) => line.trim().length > 0);
  const firstRealLine = redirectLineIndex < 0 ? '' : (lines[redirectLineIndex]?.trim() ?? '');
  const redirect = firstRealLine.match(/^#(?:넘겨주기|REDIRECT)\s+\[\[(.+?)\]\]/i);
  if (redirect) {
    redirectTarget = redirect[1];
    ast.push({ type: 'redirect', target: redirectTarget });
  }

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] ?? '';
    if (!line.trim()) continue;
    if (i === redirectLineIndex && redirectTarget) continue;

    // NamuMark lists also begin with whitespace, so they must win before the
    // ordinary leading-space indentation block is considered.
    if (parseWikiListLine(line)) {
      const listBlock: string[] = [];
      while (i < lines.length && parseWikiListLine(lines[i] ?? '')) {
        listBlock.push(lines[i] ?? '');
        i += 1;
      }
      i -= 1;
      ast.push(...parseWikiListBlock(listBlock, links, errors, blockingErrors, footnotes, options.linkResolution));
      continue;
    }

    if (line.startsWith(' ')) {
      if (foldingDepth >= MAX_INDENT_DEPTH) {
        const warning = `들여쓰기는 ${MAX_INDENT_DEPTH}단계까지 사용할 수 있습니다.`;
        if (!blockingErrors.includes(warning)) blockingErrors.push(warning);
      } else {
        const indentLines: string[] = [];
        while (i < lines.length && (lines[i] ?? '').startsWith(' ')) {
          indentLines.push((lines[i] ?? '').slice(1));
          i += 1;
        }
        i -= 1;
        const nested = parseMarkupDocument(indentLines.join('\n'), options, foldingDepth + 1, 'indent');
        mergeNestedMetadata(nested, { links, categories, categoryLinks, includes, components, footnotes, errors, blockingErrors });
        ast.push({ type: 'indent', children: nested.ast });
        continue;
      }
    }

    const conditional = line.match(/^\s*\{\{\{#!if\s+(.+?)\s*$/iu);
    if (conditional) {
      const expression = conditional[1]?.trim() ?? '';
      const block = readNestedTripleBraceBlock(lines, i);
      const nested = parseMarkupDocument(block.body.join('\n'), options, foldingDepth + 1);
      mergeNestedMetadata(nested, { links, categories, categoryLinks, includes, components, footnotes, errors, blockingErrors });
      const evaluation = evaluateConditionalExpression(expression, {});
      if (evaluation.error) errors.push(`조건식 오류: ${evaluation.error}`);
      if (!block.closed) errors.push('닫히지 않은 조건 블록을 문서 끝까지 처리했습니다.');
      ast.push({
        type: 'conditional',
        expression,
        state: evaluation.value ? 'visible' : 'hidden',
        children: nested.ast,
      });
      i = block.endIndex;
      continue;
    }

    const wikiStyle = line.match(/^\s*\{\{\{#!wiki(?:\s+(.*?))?\s*$/i);
    if (wikiStyle) {
      const block = readNestedTripleBraceBlock(lines, i);
      const nested = parseMarkupDocument(block.body.join('\n'), options, foldingDepth + 1);
      mergeNestedMetadata(nested, { links, categories, categoryLinks, includes, components, footnotes, errors, blockingErrors });
      const parsedStyle = parseWikiStyleAttributes(wikiStyle[1] ?? '');
      if (parsedStyle.ignored) {
        errors.push('지원되지 않는 wiki style 속성을 무시했습니다.');
      }
      if (!block.closed) errors.push('닫히지 않은 wiki style 블록을 문서 끝까지 처리했습니다.');
      ast.push({ type: 'wiki_style', writingMode: parsedStyle.writingMode, style: parsedStyle.style, darkStyle: parsedStyle.darkStyle, children: nested.ast });
      i = block.endIndex;
      continue;
    }

    const mathBlock = line.match(/^\{\{\{#!latex\s*$/i);
    if (mathBlock) {
      const sourceLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]?.trim() !== '}}}') {
        sourceLines.push(lines[i] ?? '');
        i += 1;
      }
      const source = sourceLines.join('\n').trim();
      const error = validateMathSource(source);
      if (error) errors.push(error);
      ast.push({ type: 'math_block', source, error });
      continue;
    }

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
      const nested = parseMarkupDocument(bodyLines.join('\n'), options, foldingDepth + 1);
      nested.links.forEach((link) => links.add(link));
      nested.categories.forEach((categoryTitle) => categories.add(categoryTitle));
      nested.categoryLinks.forEach((category) => {
        if (!categoryLinks.has(category.title)) categoryLinks.set(category.title, category);
      });
      nested.includes.forEach((target) => includes.push(target));
      nested.components.forEach((component) => components.push(component));
      nested.footnotes.forEach((note) => footnotes.push(note));
      nested.errors.forEach((error) => errors.push(error));
      nested.blockingErrors.forEach((error) => blockingErrors.push(error));
      ast.push({ type: 'folding', title: parseInline(foldingBlock[1]?.trim() || '펼치기', links, errors, blockingErrors, footnotes, options.linkResolution), children: nested.ast });
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

    if (/^\[(?:각주|footnote)\]$/iu.test(line.trim())) {
      const marker = { type: 'component' as const, name: 'references', props: {} };
      ast.push(marker);
      components.push({ name: marker.name, props: marker.props });
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
      collectComponentInlineMetadata(name, props, links, errors, blockingErrors, footnotes, options.linkResolution);
      ast.push({ type: 'component', name, props });
      components.push({ name, props });
      continue;
    }

    const inlineComponent = line.startsWith('{{{') ? null : line.match(/^\{\{(.+?)\}\}$/);
    if (inlineComponent) {
      const [rawName = '', ...rawProps] = inlineComponent[1].split('|');
      const props: Record<string, string> = {};
      for (const rawProp of rawProps) {
        const separator = rawProp.indexOf('=');
        if (separator <= 0) continue;
        const key = rawProp.slice(0, separator).trim();
        const value = rawProp.slice(separator + 1).trim();
        if (key && !(key in props)) props[key] = value;
      }
      const name = componentNameMap[rawName.trim()] ?? rawName.trim();
      collectComponentInlineMetadata(name, props, links, errors, blockingErrors, footnotes, options.linkResolution);
      ast.push({ type: 'component', name, props });
      components.push({ name, props });
      continue;
    }

    const categoryPattern = /\[\[분류:([^|\]#]+?)(?:#(blur))?(?:\|([^\]]*))?\]\]/giu;
    const inlineCategories = [...line.matchAll(categoryPattern)];
    if (inlineCategories.length > 0) {
      for (const category of inlineCategories) {
        const title = normalizeTitle(category[1] ?? '');
        if (!title) continue;
        categories.add(title);
        if (!categoryLinks.has(title)) {
          categoryLinks.set(title, {
            title,
            label: category[3]?.trim() || null,
            blurred: category[2]?.toLowerCase() === 'blur',
          });
        }
      }
      line = line.replace(categoryPattern, '').trimEnd();
      if (!line.trim()) {
        for (const category of inlineCategories) {
          const title = normalizeTitle(category[1] ?? '');
          if (title) ast.push({
            type: 'category',
            title,
            label: category[3]?.trim() || null,
            blurred: category[2]?.toLowerCase() === 'blur',
          });
        }
        continue;
      }
    }

    // Canonical NamuMark indentation uses the block lexer, which deliberately
    // treats heading-shaped text as prose instead of promoting it into the
    // document outline.
    const heading = nestingKind === 'indent' || nestingKind === 'table' || options.headingsAsProse
      ? null
      : parseWikiHeadingLine(line, options.gitBookMarkdown === true);
    if (heading) {
      const headingChildren = parseInline(
        heading.text,
        links,
        errors,
        blockingErrors,
        footnotes,
        options.linkResolution,
      );
      const headingText = inlineNodesToPlainText(headingChildren).trim() || heading.text;
      ast.push({
        type: 'heading',
        level: heading.level,
        text: headingText,
        children: headingChildren,
        id: makeHeadingId(headingText),
        ...(heading.folded ? { folded: true } : {}),
        startLine: i + 1
      });
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
      const nested = parseMarkupDocument(quoteLines.join('\n'), options, foldingDepth + 1, 'blockquote');
      mergeNestedMetadata(nested, { links, categories, categoryLinks, includes, components, footnotes, errors, blockingErrors });
      ast.push({ type: 'blockquote', children: nested.ast });
      continue;
    }

    const gitBookHtmlTable = options.gitBookMarkdown
      ? parseGitBookHtmlTable(lines, i, links, errors, blockingErrors, footnotes, options.linkResolution)
      : null;
    if (gitBookHtmlTable) {
      i += gitBookHtmlTable.consumedLineCount - 1;
      ast.push(gitBookHtmlTable.node);
      continue;
    }

    const markdownTable = parseMarkdownTableStart(lines, i);
    if (markdownTable) {
      const rows: WikiTableRow[] = [
        markdownTable.headers,
        ...markdownTable.bodyRows
      ].map((cells, rowIndex) => ({
        cells: cells.map((content, columnIndex) => ({
          children: parseInline(content, links, errors, blockingErrors, footnotes, options.linkResolution),
          colspan: 1,
          rowspan: 1,
          ...(rowIndex === 0 ? { header: true } : {}),
          ...(markdownTable.alignments[columnIndex] ? { align: markdownTable.alignments[columnIndex] } : {})
        }))
      }));
      i += markdownTable.consumedLineCount - 1;
      ast.push({ type: 'wiki_table', caption: [], rows, options: {} });
      continue;
    }

    const tableStart = parseWikiTableStart(line, lines[i + 1]);
    if (tableStart) {
      const rows: WikiTableRow[] = [];
      const tableOptions: WikiTableOptions = {};
      const tableParseState = createWikiTableParseState();
      const caption = tableStart.caption === null
        ? []
        : parseInline(tableStart.caption, links, errors, blockingErrors, footnotes, options.linkResolution);
      if (tableStart.firstRow !== null) {
        const row = parseWikiTableRow(
          tableStart.firstRow,
          tableOptions,
          tableParseState,
          { links, categories, categoryLinks, includes, components, footnotes, errors, blockingErrors },
          options,
          foldingDepth,
        );
        if (row.cells.length > 0) rows.push(row);
      }
      if (tableStart.consumeNextLine) i += 1;
      while (i < lines.length && lines[i]?.trim().startsWith('||')) {
        const logicalRow = readWikiTableLogicalRow(lines, i);
        if (!logicalRow.closed) errors.push('닫히지 않은 표 셀 블록을 문서 끝까지 처리했습니다.');
        const row = parseWikiTableRow(
          logicalRow.source,
          tableOptions,
          tableParseState,
          { links, categories, categoryLinks, includes, components, footnotes, errors, blockingErrors },
          options,
          foldingDepth,
        );
        if (row.cells.length > 0) rows.push(row);
        i = logicalRow.endIndex + 1;
      }
      i -= 1;
      ast.push({ type: 'wiki_table', caption, rows, options: tableOptions });
      continue;
    }

    const file = line.match(/^\[\[파일:([^\]]+)\]\]$/);
    if (file) {
      ast.push(parseWikiFileMarkup(file[1] ?? '', errors, blockingErrors));
      continue;
    }

    const paragraphLines = [line];
    while (i + 1 < lines.length && !startsMarkupBlock(lines, i + 1)) {
      paragraphLines.push(lines[i + 1] ?? '');
      i += 1;
    }
    const children: InlineNode[] = [];
    paragraphLines.forEach((paragraphLine, index) => {
      if (index > 0) children.push({ type: 'line_break' });
      children.push(...parseInline(paragraphLine, links, errors, blockingErrors, footnotes, options.linkResolution));
    });
    ast.push({ type: 'paragraph', children });
  }

  const headings = ast.filter((node): node is Extract<AstNode, { type: 'heading' }> => node.type === 'heading');
  headings.forEach((heading, index) => {
    const next = headings[index + 1];
    heading.endLine = (next?.startLine ?? lines.length + 1) - 1;
  });

  if (foldingDepth === 0) assignStructuralHeadingIds(ast);

  if (foldingDepth === 0) {
    if (!components.some((component) => component.name === 'document_status')) {
      errors.push('문서 상태 컴포넌트가 없습니다.');
    }
    if (categories.size === 0 && !redirectTarget) {
      errors.push('분류가 없습니다.');
    }
    if (!components.some((component) => ['mob_info', 'item_info', 'block_info', 'mod_info', 'server_info', 'api_info', 'packet_info', 'data_type_info', 'develop_status'].includes(component.name))) {
      errors.push('정보 컴포넌트가 없습니다.');
    }
  }
  if (/<\s*(script|style|iframe|object|embed|img)\b/i.test(source) || /\son[a-z]+\s*=/i.test(source)) {
    blockingErrors.push('허용되지 않은 HTML이 포함되어 있습니다.');
  }
  if (countMathNodes(ast) > MAX_MATH_NODES) {
    blockingErrors.push(`수식은 문서당 ${MAX_MATH_NODES}개까지 사용할 수 있습니다.`);
  }

  return {
    ast,
    links: [...links],
    categories: [...categories],
    categoryLinks: [...categoryLinks.values()],
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
    plainText: source
      .replace(/^\s*\{\{\{#!wiki[^\r\n]*(?:\r?\n|$)/gimu, ' ')
      .replace(/^\s*\}\}\}\s*$/gmu, ' ')
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

function startsMarkupBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^#(?:넘겨주기|REDIRECT)\s+\[\[.+?\]\]/iu.test(trimmed)) return true;
  if (/^\s*\{\{\{#!wiki(?:\s|$)/iu.test(line)) return true;
  if (/^\{\{\{#!(?:latex|syntax|highlight|folding)(?:\s|$)/iu.test(line)) return true;
  if (trimmed === '{{{') return true;
  if (parseIncludeLine(line)) return true;
  if (/^\[(?:목차|tableofcontents)(?:\(hide\))?\]$/iu.test(trimmed)) return true;
  if (/^\[(?:각주|footnote)\]$/iu.test(trimmed)) return true;
  if (/^<codeblock(?:\s+lang="[^"]+")?>$/u.test(line)) return true;
  if (/^\{\{[^|}\n]+\s*$/u.test(line)) return true;
  if (!line.startsWith('{{{') && /^\{\{.+?\}\}$/u.test(line)) return true;
  if (/\[\[분류:[^\]]+\]\]/u.test(line)) return true;
  if (parseWikiHeadingLine(line, true)) return true;
  if (/^-{4,}$/u.test(trimmed)) return true;
  if (line.startsWith('>')) return true;
  if (/^<table(?:\s|>)/iu.test(trimmed)) return true;
  if (parseWikiTableStart(line, lines[index + 1])) return true;
  if (/^\[\[파일:[^\]]+\]\]$/u.test(line)) return true;
  if (parseWikiListLine(line)) return true;
  return line.startsWith(' ');
}

function maskWikiCommentLines(source: string, gitBookMarkdown = false): string {
  let literalDepth = 0;
  return source.split('\n').map((line) => {
    if (literalDepth === 0 && line.startsWith('##') && !(gitBookMarkdown && /^#{1,6}\s+\S/u.test(line))) return '';
    for (let index = 0; index <= line.length - 3; index += 1) {
      if (isEscapedAt(line, index)) continue;
      const marker = line.slice(index, index + 3);
      if (marker === '{{{') {
        if (literalDepth > 0 || !line.slice(index + 3).startsWith('#!')) literalDepth += 1;
        index += 2;
      } else if (marker === '}}}' && literalDepth > 0) {
        literalDepth -= 1;
        index += 2;
      }
    }
    return line;
  }).join('\n');
}

function isEscapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function parseWikiHeadingLine(line: string, gitBookMarkdown = false): { level: number; text: string; folded: boolean } | null {
  if (gitBookMarkdown) {
    const markdown = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    const text = markdown?.[2]?.trim();
    if (markdown && text) return { level: markdown[1]!.length, text, folded: false };
  }
  const opening = line.match(/^=+/)?.[0] ?? '';
  const closing = line.match(/=+$/)?.[0] ?? '';
  if (!opening || opening.length !== closing.length || opening.length > 6) return null;

  let rawText = line.slice(opening.length, -closing.length);
  const level = opening.length;
  const startsFold = rawText.startsWith('#');
  const endsFold = rawText.endsWith('#');
  if (startsFold !== endsFold) return null;
  const folded = startsFold && endsFold;
  if (folded) rawText = rawText.slice(1, -1);
  // thetree's canonical form requires spaces around the title. MineWiki
  // historically accepted compact level 2-4 headings, so keep only that
  // established compatibility surface for normal headings. Folded headings
  // are new here and always require their canonical spaces.
  if ((folded || level < 2 || level > 4) && !(rawText.startsWith(' ') && rawText.endsWith(' '))) {
    return null;
  }

  const text = rawText.trim();
  return text ? { level, text, folded } : null;
}

function rejectedDocument(message: string): ParsedDocument {
  return {
    ast: [],
    links: [],
    categories: [],
    categoryLinks: [],
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
  footnotes: string[],
  linkResolution?: WikiLinkResolutionContext
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
          children: parseInline(current.content, links, errors, blockingErrors, footnotes, linkResolution),
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
  tableState: WikiTableParseState,
  metadata: {
    links: Set<string>;
    categories: Set<string>;
    categoryLinks: Map<string, WikiCategoryLink>;
    includes: string[];
    components: Array<{ name: string; props: Record<string, string> }>;
    footnotes: string[];
    errors: string[];
    blockingErrors: string[];
  },
  options: ParseMarkupOptions,
  foldingDepth: number,
): WikiTableRow {
  const row: WikiTableRow = { cells: [] };
  const cells: WikiTableCell[] = [];
  const occupiedSpans = tableState.activeRowSpans
    .filter((span) => span.untilRow >= tableState.rowIndex)
    .sort((left, right) => left.start - right.start);
  let pendingColspan = 1;
  let nextVisualColumn = 0;
  let occupiedSpanCursor = 0;
  for (const rawCell of splitWikiTableRow(line)) {
    if (!rawCell.trim()) {
      pendingColspan = Math.min(1000, pendingColspan + 1);
      continue;
    }
    const cell: WikiTableCell = { children: [], colspan: pendingColspan, rowspan: 1 };
    const scopedColors: WikiTableScopedColors = {};
    pendingColspan = 1;
    let content = rawCell;
    while (content.startsWith('<')) {
      const end = content.indexOf('>');
      if (end < 0) break;
      const modifier = content.slice(1, end).trim();
      if (!applyWikiTableModifier(modifier, cell, row, scopedColors, tableOptions, metadata.errors)) break;
      content = content.slice(end + 1);
    }
    if (!cell.align) {
      const startsWithSpace = /^\s/u.test(content);
      const endsWithSpace = /\s$/u.test(content);
      if (startsWithSpace && endsWithSpace) cell.align = 'center';
      else if (startsWithSpace) cell.align = 'right';
      else if (endsWithSpace) cell.align = 'left';
    }
    const normalizedContent = content.trim();
    if (normalizedContent.includes('\n')) {
      const nested = parseMarkupDocument(
        normalizedContent,
        { ...options, headingsAsProse: true },
        foldingDepth + 1,
        'table',
      );
      mergeNestedMetadata(nested, metadata);
      cell.blocks = nested.ast;
    } else {
      cell.children = parseInline(
        normalizedContent,
        metadata.links,
        metadata.errors,
        metadata.blockingErrors,
        metadata.footnotes,
        options.linkResolution,
      );
    }
    const placement = findWikiTableVisualColumn(
      occupiedSpans,
      occupiedSpanCursor,
      nextVisualColumn,
      cell.colspan
    );
    const visualColumn = placement.column;
    occupiedSpanCursor = placement.nextSpanCursor;
    if (scopedColors.columnBackgroundColor) {
      tableState.columnBackgroundColors.set(visualColumn, scopedColors.columnBackgroundColor);
    }
    if (scopedColors.columnColor) {
      tableState.columnColors.set(visualColumn, scopedColors.columnColor);
    }
    if (scopedColors.columnKeepAll) {
      tableState.columnKeepAll.add(visualColumn);
    }
    applyInheritedWikiTableColor(cell, 'backgroundColor', tableState.columnBackgroundColors.get(visualColumn));
    applyInheritedWikiTableColor(cell, 'color', tableState.columnColors.get(visualColumn));
    if (tableState.columnKeepAll.has(visualColumn)) cell.keepAll = true;
    if (cell.rowspan > 1) {
      tableState.activeRowSpans.push({
        start: visualColumn,
        end: visualColumn + cell.colspan - 1,
        untilRow: tableState.rowIndex + cell.rowspan - 1
      });
    }
    nextVisualColumn = visualColumn + cell.colspan;
    cells.push(cell);
  }
  row.cells = cells;
  tableState.rowIndex += 1;
  tableState.activeRowSpans = tableState.activeRowSpans.filter(
    (span) => span.untilRow >= tableState.rowIndex
  );
  return row;
}

interface WikiTableColorPair {
  light: string;
  dark?: string;
}

interface WikiTableScopedColors {
  columnBackgroundColor?: WikiTableColorPair;
  columnColor?: WikiTableColorPair;
  columnKeepAll?: boolean;
}

interface WikiTableRowSpan {
  start: number;
  end: number;
  untilRow: number;
}

interface WikiTableParseState {
  rowIndex: number;
  columnBackgroundColors: Map<number, WikiTableColorPair>;
  columnColors: Map<number, WikiTableColorPair>;
  columnKeepAll: Set<number>;
  activeRowSpans: WikiTableRowSpan[];
}

function createWikiTableParseState(): WikiTableParseState {
  return {
    rowIndex: 0,
    columnBackgroundColors: new Map(),
    columnColors: new Map(),
    columnKeepAll: new Set(),
    activeRowSpans: []
  };
}

function findWikiTableVisualColumn(
  occupiedSpans: readonly WikiTableRowSpan[],
  initialSpanCursor: number,
  initialColumn: number,
  colspan: number
) {
  let column = initialColumn;
  let spanCursor = initialSpanCursor;
  while (spanCursor < occupiedSpans.length) {
    const span = occupiedSpans[spanCursor]!;
    const end = column + colspan - 1;
    if (span.end < column) {
      spanCursor += 1;
      continue;
    }
    if (span.start > end) break;
    column = span.end + 1;
    spanCursor += 1;
  }
  return { column, nextSpanCursor: spanCursor };
}

function applyInheritedWikiTableColor(
  cell: WikiTableCell,
  property: 'backgroundColor' | 'color',
  inherited: WikiTableColorPair | undefined
) {
  if (!inherited || cell[property]) return;
  cell[property] = inherited.light;
  const darkProperty = property === 'backgroundColor' ? 'darkBackgroundColor' : 'darkColor';
  if (inherited.dark) cell[darkProperty] = inherited.dark;
}

interface WikiTableStart {
  caption: string | null;
  firstRow: string | null;
  consumeNextLine: boolean;
}

interface MarkdownTableStart {
  headers: string[];
  alignments: Array<'left' | 'center' | 'right' | undefined>;
  bodyRows: string[][];
  consumedLineCount: number;
}

function parseGitBookHtmlTable(
  lines: readonly string[],
  startIndex: number,
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[],
  linkResolution?: WikiLinkResolutionContext
): { node: Extract<AstNode, { type: 'wiki_table' }>; consumedLineCount: number } | null {
  const firstLine = lines[startIndex]?.trimStart() ?? '';
  if (!/^<table(?:\s|>)/iu.test(firstLine)) return null;
  const sourceLines: string[] = [];
  let cursor = startIndex;
  while (cursor < lines.length && sourceLines.length < 500) {
    const current = lines[cursor] ?? '';
    sourceLines.push(current);
    if (/<\/table>\s*$/iu.test(current.trimEnd())) break;
    cursor += 1;
  }
  const rawTable = sourceLines.join('\n').trim();
  if (!/<\/table>\s*$/iu.test(rawTable)) {
    errors.push('닫히지 않은 GitBook HTML 표를 일반 텍스트로 처리했습니다.');
    return null;
  }
  const sanitized = sanitizeHtml(rawTable, {
    allowedTags: ['table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'code', 'br'],
    allowedAttributes: {
      table: ['data-header-hidden'],
      th: ['colspan', 'rowspan', 'width'],
      td: ['colspan', 'rowspan', 'width'],
      a: ['href']
    },
    allowedSchemes: ['http', 'https', 'mailto']
  });
  const tableAttributes = sanitized.match(/^<table([^>]*)>/iu)?.[1] ?? '';
  const bodyStart = sanitized.search(/<tbody(?:\s|>)/iu);
  const rows: WikiTableRow[] = [];
  for (const rowMatch of sanitized.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/giu)) {
    if (rows.length >= 200) {
      errors.push('GitBook HTML 표는 200행까지만 표시됩니다.');
      break;
    }
    const cells: WikiTableCell[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<(th|td)([^>]*)>([\s\S]*?)<\/\1>/giu)) {
      if (cells.length >= 50) {
        errors.push('GitBook HTML 표는 행마다 50열까지만 표시됩니다.');
        break;
      }
      const tag = cellMatch[1]?.toLowerCase();
      const attributes = cellMatch[2] ?? '';
      const width = readGitBookHtmlDimension(attributes, 'width');
      cells.push({
        children: parseGitBookHtmlInline(cellMatch[3] ?? '', links, errors, blockingErrors, footnotes, linkResolution),
        colspan: readGitBookHtmlSpan(attributes, 'colspan'),
        rowspan: readGitBookHtmlSpan(attributes, 'rowspan'),
        ...(tag === 'th' || (bodyStart >= 0 && (rowMatch.index ?? 0) < bodyStart) ? { header: true } : {}),
        ...(width ? { width } : {})
      });
    }
    if (cells.length > 0) rows.push({ cells });
  }
  if (rows.length === 0) {
    errors.push('내용이 없는 GitBook HTML 표를 무시했습니다.');
    return null;
  }
  const captionSource = sanitized.match(/<caption(?:\s[^>]*)?>([\s\S]*?)<\/caption>/iu)?.[1] ?? '';
  return {
    node: {
      type: 'wiki_table',
      caption: parseGitBookHtmlInline(captionSource, links, errors, blockingErrors, footnotes, linkResolution),
      rows,
      options: { headerHidden: /\bdata-header-hidden(?:\s*=|\s|$)/iu.test(tableAttributes) }
    },
    consumedLineCount: sourceLines.length
  };
}

function parseGitBookHtmlInline(
  source: string,
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[],
  linkResolution?: WikiLinkResolutionContext
): InlineNode[] {
  const sanitized = sanitizeHtml(source, {
    allowedTags: ['a', 'code', 'br'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto']
  });
  const nodes: InlineNode[] = [];
  const pattern = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>|<code>([\s\S]*?)<\/code>|<br\s*\/?>/giu;
  let lastIndex = 0;
  for (const match of sanitized.matchAll(pattern)) {
    if ((match.index ?? 0) > lastIndex) {
      appendGitBookHtmlInline(nodes, sanitized.slice(lastIndex, match.index), links, errors, blockingErrors, footnotes, linkResolution);
    }
    if (/^<br/iu.test(match[0])) {
      nodes.push({ type: 'line_break' });
    } else if (match[3] !== undefined) {
      nodes.push({ type: 'code', code: decodeGitBookHtmlText(match[3]) });
    } else {
      const href = decodeGitBookHtmlText(match[1] ?? '');
      const label = decodeGitBookHtmlText(match[2] ?? '') || href;
      if (/^(?:https?:\/\/|mailto:)/iu.test(href) || isSafeLocalHref(href)) {
        nodes.push({ type: 'external_link', href, label });
      } else {
        appendGitBookHtmlInline(nodes, label, links, errors, blockingErrors, footnotes, linkResolution);
      }
    }
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  if (lastIndex < sanitized.length) {
    appendGitBookHtmlInline(nodes, sanitized.slice(lastIndex), links, errors, blockingErrors, footnotes, linkResolution);
  }
  if (nodes.length === 0 && source.trim()) {
    return parseInline(decodeGitBookHtmlText(source), links, errors, blockingErrors, footnotes, linkResolution);
  }
  return nodes;
}

function appendGitBookHtmlInline(
  nodes: InlineNode[],
  source: string,
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[],
  linkResolution?: WikiLinkResolutionContext
) {
  const text = decodeGitBookHtmlText(source);
  if (text) nodes.push(...parseInline(text, links, errors, blockingErrors, footnotes, linkResolution));
}

function decodeGitBookHtmlText(source: string): string {
  return sanitizeHtml(source, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/gu, ' ').trim();
}

function readGitBookHtmlSpan(attributes: string, name: 'colspan' | 'rowspan'): number {
  const value = Number(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'iu').exec(attributes)?.[1] ?? 1);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(100, value)) : 1;
}

function readGitBookHtmlDimension(attributes: string, name: 'width'): string | undefined {
  const value = Number(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'iu').exec(attributes)?.[1] ?? 0);
  return Number.isSafeInteger(value) && value >= 1 && value <= 4096 ? `${value}px` : undefined;
}

function parseMarkdownTableStart(lines: readonly string[], startIndex: number): MarkdownTableStart | null {
  const line = lines[startIndex] ?? '';
  const separatorLine = lines[startIndex + 1];
  if (!separatorLine || !line.includes('|') || !separatorLine.includes('|')) return null;
  const headers = splitMarkdownTableRow(line);
  const separators = splitMarkdownTableRow(separatorLine);
  if (headers.length === 0 || headers.length !== separators.length) return null;
  if (!separators.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()))) return null;

  const alignments = separators.map((cell) => {
    const marker = cell.trim();
    if (marker.startsWith(':') && marker.endsWith(':')) return 'center' as const;
    if (marker.endsWith(':')) return 'right' as const;
    if (marker.startsWith(':')) return 'left' as const;
    return undefined;
  });
  const bodyRows: string[][] = [];
  let lineOffset = startIndex + 2;
  while (lineOffset < lines.length) {
    const candidate = lines[lineOffset];
    if (!candidate?.includes('|') || !candidate.trim()) break;
    const cells = splitMarkdownTableRow(candidate);
    if (cells.length === 0) break;
    bodyRows.push(Array.from({ length: headers.length }, (_, index) => cells[index] ?? ''));
    lineOffset += 1;
  }
  return { headers, alignments, bodyRows, consumedLineCount: lineOffset - startIndex };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const start = trimmed.startsWith('|') ? 1 : 0;
  const end = trimmed.endsWith('|') && !trimmed.endsWith('\\|') ? trimmed.length - 1 : trimmed.length;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let codeFenceLength = 0;
  for (let index = start; index < end; index += 1) {
    const character = trimmed[index]!;
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') {
      let runLength = 1;
      while (trimmed[index + runLength] === '`') runLength += 1;
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (codeFenceLength === runLength) codeFenceLength = 0;
      cell += '`'.repeat(runLength);
      index += runLength - 1;
      continue;
    }
    if (character === '|' && codeFenceLength === 0) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += character;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
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
  row: WikiTableRow,
  scopedColors: WikiTableScopedColors,
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
  if (modifier.toLowerCase() === 'nopad') {
    cell.noPadding = true;
    return true;
  }
  if (modifier.toLowerCase() === 'keepall') {
    cell.keepAll = true;
    return true;
  }
  if (modifier.toLowerCase() === 'rowkeepall') {
    row.keepAll = true;
    return true;
  }
  if (modifier.toLowerCase() === 'colkeepall') {
    scopedColors.columnKeepAll = true;
    return true;
  }
  if (modifier.toLowerCase() === 'sortable') {
    cell.sortable = true;
    return true;
  }

  const scopedColorModifier = modifier.match(/^(row|col)(bgcolor|color)=(.+)$/i);
  if (scopedColorModifier) {
    const scope = scopedColorModifier[1]!.toLowerCase();
    const property = scopedColorModifier[2]!.toLowerCase();
    const colors = normalizeTableColorPair(scopedColorModifier[3]!.trim());
    if (!colors) {
      addTableModifierWarning(errors, modifier);
    } else if (scope === 'row' && property === 'bgcolor') {
      row.backgroundColor ??= colors.light;
      if (colors.dark) row.darkBackgroundColor ??= colors.dark;
    } else if (scope === 'row') {
      row.color ??= colors.light;
      if (colors.dark) row.darkColor ??= colors.dark;
    } else if (property === 'bgcolor') {
      scopedColors.columnBackgroundColor ??= colors;
    } else {
      scopedColors.columnColor ??= colors;
    }
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
  if (CSS_NAMED_COLORS.has(color)) return color;
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

const WIKI_FILE_OPTION_KEYS = new Set([
  'width',
  'height',
  'align',
  'bgcolor',
  'border-radius',
  'rendering',
  'object-fit',
  'theme',
  'alt',
  'caption'
]);
const CSS_NAMED_COLOR_SOURCE = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ').join('|');
const CSS_NAMED_COLORS = new Set(CSS_NAMED_COLOR_SOURCE.split('|'));
const CSS_NAMED_COLOR_PATTERN = new RegExp(`^(?:${CSS_NAMED_COLOR_SOURCE})$`, 'iu');
const CSS_NAMED_BORDER_PATTERN = new RegExp(`^(?:0|[1-8]px) (?:solid|dashed|dotted) (?:${CSS_NAMED_COLOR_SOURCE})$`, 'iu');

function parseWikiFileMarkup(
  body: string,
  errors: string[],
  blockingErrors: string[]
): Extract<AstNode, { type: 'file' }> | Extract<InlineNode, { type: 'file' }> {
  const [rawFileName = '', ...parts] = body.split('|');
  const fileName = rawFileName.trim();
  validateWikiFileName(fileName, blockingErrors);
  let thumbnail = false;
  let caption: string | null = null;
  const display: WikiFileDisplayOptions = {};
  const seenOptions = new Set<string>();
  let optionCount = 0;

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part === '섬네일') {
      thumbnail = true;
      continue;
    }
    const rawOptionPairs = part.split('&');
    const hasKnownOption = rawOptionPairs.some((pair) => {
      const separator = pair.indexOf('=');
      if (separator < 0) return false;
      try {
        return WIKI_FILE_OPTION_KEYS.has(decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' ')).trim());
      } catch {
        return false;
      }
    });
    if (!hasKnownOption) {
      caption ??= part;
      continue;
    }
    for (const pair of rawOptionPairs) {
      optionCount += 1;
      if (optionCount > MAX_FILE_OPTIONS) {
        addWikiFileOptionWarning(errors, `파일 옵션은 ${MAX_FILE_OPTIONS}개까지 사용할 수 있습니다.`);
        break;
      }
      const separator = pair.indexOf('=');
      const key = decodeWikiFileOptionComponent(separator < 0 ? pair : pair.slice(0, separator), errors, '이름');
      const value = decodeWikiFileOptionComponent(separator < 0 ? '' : pair.slice(separator + 1), errors, key || '값');
      if (key === null || value === null) continue;
      if (!WIKI_FILE_OPTION_KEYS.has(key)) {
        addWikiFileOptionWarning(errors, `지원하지 않는 파일 옵션입니다: ${key || '(빈 옵션)'}`);
        continue;
      }
      if (seenOptions.has(key)) {
        addWikiFileOptionWarning(errors, `파일 옵션이 중복되었습니다: ${key}`);
        continue;
      }
      seenOptions.add(key);
      if (!value || value.length > MAX_FILE_OPTION_VALUE_LENGTH) {
        addWikiFileOptionWarning(errors, `파일 옵션 값이 올바르지 않습니다: ${key}`);
        continue;
      }
      if (key === 'caption') caption = value;
      else if (key === 'width') display.width = value;
      else if (key === 'height') display.height = value;
      else if (key === 'align') display.align = value;
      else if (key === 'bgcolor') display.backgroundColor = value;
      else if (key === 'border-radius') display.borderRadius = value;
      else if (key === 'rendering') display.rendering = value;
      else if (key === 'object-fit') display.objectFit = value;
      else if (key === 'theme') display.theme = value;
      else if (key === 'alt') display.alt = value;
    }
  }

  validateWikiFileDisplayOptions(display, errors);
  const normalizedDisplay = normalizeWikiFileDisplayOptions(display, true);
  return {
    type: 'file',
    fileName,
    thumbnail,
    caption,
    ...(Object.keys(normalizedDisplay).length > 0 ? { display: normalizedDisplay } : {})
  };
}

function decodeWikiFileOptionComponent(value: string, errors: string[], label: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).trim();
  } catch {
    addWikiFileOptionWarning(errors, `파일 옵션 인코딩이 올바르지 않습니다: ${label}`);
    return null;
  }
}

function addWikiFileOptionWarning(errors: string[], warning: string) {
  if (!errors.includes(warning)) errors.push(warning);
}

function isIncludeParameterValue(value: string) {
  return /^@[A-Za-z0-9가-힣_]+(?:=[^@\n]*)?@$/u.test(value);
}

function normalizeWikiFileSize(value: string | undefined, kind: 'dimension' | 'radius'): string | null {
  if (!value) return null;
  const match = value.match(/^(\d+)(%|px)?$/u);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'px';
  const maximum = unit === '%' ? (kind === 'radius' ? 50 : 100) : (kind === 'radius' ? 256 : 4096);
  const minimum = kind === 'radius' ? 0 : 1;
  return Number.isSafeInteger(amount) && amount >= minimum && amount <= maximum ? `${amount}${unit}` : null;
}

function normalizeWikiFileDisplayOptions(raw: WikiFileDisplayOptions | undefined, preserveIncludeParameters = false): WikiFileDisplayOptions {
  if (!raw) return {};
  const preserve = (value: string | undefined) => preserveIncludeParameters && value && isIncludeParameterValue(value) ? value : null;
  const width = preserve(raw.width) ?? normalizeWikiFileSize(raw.width, 'dimension');
  const height = preserve(raw.height) ?? normalizeWikiFileSize(raw.height, 'dimension');
  const borderRadius = preserve(raw.borderRadius) ?? normalizeWikiFileSize(raw.borderRadius, 'radius');
  const align = preserve(raw.align) ?? (raw.align && ['bottom', 'center', 'left', 'middle', 'normal', 'right', 'top'].includes(raw.align) ? raw.align : null);
  const rawColor = raw.backgroundColor?.toLowerCase();
  const backgroundColor = preserve(raw.backgroundColor) ?? (rawColor && (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(rawColor) || CSS_NAMED_COLORS.has(rawColor)) ? rawColor : null);
  const rendering = preserve(raw.rendering) ?? (raw.rendering && ['auto', 'smooth', 'high-quality', 'pixelated', 'crisp-edges'].includes(raw.rendering) ? raw.rendering : null);
  const objectFit = preserve(raw.objectFit) ?? (raw.objectFit && ['fill', 'contain', 'cover', 'none', 'scale-down'].includes(raw.objectFit) ? raw.objectFit : null);
  const theme = preserve(raw.theme) ?? (raw.theme && ['light', 'dark'].includes(raw.theme) ? raw.theme : null);
  const alt = preserve(raw.alt) ?? (raw.alt?.trim().slice(0, MAX_FILE_OPTION_VALUE_LENGTH) || null);
  return {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(align ? { align } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(borderRadius ? { borderRadius } : {}),
    ...(rendering ? { rendering } : {}),
    ...(objectFit ? { objectFit } : {}),
    ...(theme ? { theme } : {}),
    ...(alt ? { alt } : {})
  };
}

function validateWikiFileDisplayOptions(raw: WikiFileDisplayOptions, errors: string[]) {
  const normalized = normalizeWikiFileDisplayOptions(raw, true);
  const pairs: Array<[keyof WikiFileDisplayOptions, string]> = [
    ['width', 'width'], ['height', 'height'], ['align', 'align'], ['backgroundColor', 'bgcolor'],
    ['borderRadius', 'border-radius'], ['rendering', 'rendering'], ['objectFit', 'object-fit'], ['theme', 'theme']
  ];
  for (const [property, label] of pairs) {
    const value = raw[property];
    if (value && !isIncludeParameterValue(value) && !normalized[property]) {
      addWikiFileOptionWarning(errors, `파일 옵션 값이 올바르지 않습니다: ${label}`);
    }
  }
}

function replaceWikiFileDisplayOptions(
  display: WikiFileDisplayOptions | undefined,
  replace: (value: string) => string
): WikiFileDisplayOptions | undefined {
  if (!display) return undefined;
  const replaced = Object.fromEntries(Object.entries(display).map(([key, value]) => [key, replace(value)])) as WikiFileDisplayOptions;
  const normalized = normalizeWikiFileDisplayOptions(replaced);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function validateWikiFileName(fileName: string, blockingErrors: string[]) {
  if (!fileName || !/^[^<>:"|?*\\/\[\]]+$/.test(fileName)) {
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
  headingPrefix: string,
  reservedParams: Readonly<{ calleeTitle?: string }> = {}
): AstNode[] {
  const replace = (value: string) => value.replace(
    /@([A-Za-z0-9가-힣_]+)(?:=([^@\n]*))?@/gu,
    (_match, key: string, fallback: string | undefined) => (
      key === 'calleeTitle' && reservedParams.calleeTitle !== undefined
        ? reservedParams.calleeTitle
        : params[key] ?? fallback ?? ''
    )
  );
  const inline = (nodes: readonly InlineNode[]): InlineNode[] => nodes.map((node) => {
    if (node.type === 'internal_link') {
      const labelChildren = node.labelChildren ? inline(node.labelChildren) : undefined;
      return {
        ...node,
        target: replace(node.target),
        label: labelChildren ? inlineNodesToPlainText(labelChildren) : replace(node.label),
        ...(labelChildren ? { labelChildren } : {}),
        fragment: node.fragment === undefined || node.fragment === null ? node.fragment : replace(node.fragment)
      };
    }
    if (node.type === 'external_link') {
      const labelChildren = node.labelChildren ? inline(node.labelChildren) : undefined;
      return {
        ...node,
        href: replace(node.href),
        label: labelChildren ? inlineNodesToPlainText(labelChildren) : replace(node.label),
        ...(labelChildren ? { labelChildren } : {})
      };
    }
    if (node.type === 'code') return { ...node, code: replace(node.code) };
    if (node.type === 'file') return {
      ...node,
      fileName: replace(node.fileName),
      caption: node.caption === null ? null : replace(node.caption),
      display: replaceWikiFileDisplayOptions(node.display, replace)
    };
    if (node.type === 'unsupported_macro') return { ...node };
    if (node.type === 'dynamic_time') return { ...node };
    if (node.type === 'dynamic_stat') return { ...node };
    if (node.type === 'video') return { ...node };
    if (node.type === 'math') {
      const source = replace(node.source);
      return { ...node, source, error: validateMathSource(source) };
    }
    if (node.type === 'line_break' || node.type === 'clearfix') return { ...node };
    if (node.type === 'anchor') return { ...node, id: normalizeMacroAnchor(replace(node.id)) };
    if (node.type === 'ruby') return { ...node, text: replace(node.text), ruby: replace(node.ruby) };
    if (node.type === 'ref') return {
      ...node,
      name: node.name === null ? null : normalizeFootnoteName(replace(node.name)),
      text: node.text === null ? null : replace(node.text),
      ...(node.children ? { children: inline(node.children) } : {})
    };
    if (
      node.type === 'bold'
      || node.type === 'italic'
      || node.type === 'strike'
      || node.type === 'underline'
      || node.type === 'sup'
      || node.type === 'sub'
      || node.type === 'color'
      || node.type === 'size'
    ) return { ...node, children: inline(node.children) };
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
      const children = node.children ? inline(node.children) : undefined;
      const text = children ? inlineNodesToPlainText(children) : replace(node.text);
      return {
        ...node,
        text,
        ...(children ? { children } : {}),
        id: `${headingPrefix}${node.id}`,
        ...(node.legacyId ? { legacyId: `${headingPrefix}${makeHeadingId(text)}` } : {})
      };
    }
    if (node.type === 'paragraph') return { ...node, children: inline(node.children) };
    if (node.type === 'indent') return {
      ...node,
      children: applyIncludeParametersToAst(node.children, params, headingPrefix, reservedParams)
    };
    if (node.type === 'blockquote') return {
      ...node,
      children: applyIncludeParametersToAst(node.children, params, headingPrefix, reservedParams)
    };
    if (node.type === 'list') return list(node);
    if (node.type === 'wiki_table') return {
      ...node,
      caption: inline(node.caption),
      rows: node.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          children: inline(cell.children),
          ...(cell.blocks ? { blocks: applyIncludeParametersToAst(cell.blocks, params, headingPrefix, reservedParams) } : {}),
        }))
      }))
    };
    if (node.type === 'folding') return {
      ...node,
      title: inline(node.title),
      children: applyIncludeParametersToAst(node.children, params, headingPrefix, reservedParams)
    };
    if (node.type === 'conditional') {
      const evaluation = evaluateConditionalExpression(node.expression, params, reservedParams);
      return {
        ...node,
        state: evaluation.value ? 'visible' : 'hidden',
        children: applyIncludeParametersToAst(node.children, params, headingPrefix, reservedParams),
      };
    }
    if (node.type === 'wiki_style') return {
      ...node,
      children: applyIncludeParametersToAst(node.children, params, headingPrefix, reservedParams)
    };
    if (node.type === 'component') return {
      ...node,
      props: Object.fromEntries(Object.entries(node.props).map(([key, value]) => [key, replace(value)]))
    };
    if (node.type === 'category') return {
      ...node,
      title: replace(node.title),
      label: node.label === null ? null : replace(node.label),
    };
    if (node.type === 'file') return {
      ...node,
      fileName: replace(node.fileName),
      caption: node.caption === null ? null : replace(node.caption),
      display: replaceWikiFileDisplayOptions(node.display, replace)
    };
    if (node.type === 'redirect') return { ...node, target: replace(node.target) };
    if (node.type === 'math_block') {
      const source = replace(node.source);
      return { ...node, source, error: validateMathSource(source) };
    }
    if (node.type === 'include') return {
      ...node,
      target: replace(node.target),
      params: Object.fromEntries(Object.entries(node.params).map(([key, value]) => [key, replace(value)])),
      children: node.children ? applyIncludeParametersToAst(node.children, params, headingPrefix, reservedParams) : undefined
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
  footnotes: string[],
  linkResolution?: WikiLinkResolutionContext,
  nestingDepth = 0
): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /(?<file>\[\[파일:(?<fileBody>[^\]]+)\]\])|(?<refXmlReuse><ref\s+name="(?<refXmlReuseName>[^"]+)"\s*\/>)|(?<refXml><ref(?:\s+name="(?<refXmlName>[^"]+)")?>(?<refXmlText>.*?)<\/ref>)|(?<refShort>\[\*(?<refName>[^\s\]]+)?(?:\s+(?<refShortText>(?:\[\[[^\]]+\]\]|[^\]])+?))?\])|(?<legacyMath><math>(?<legacyMathText>.*?)<\/math>)|(?<code><code>(?<codeText>.*?)<\/code>)|(?<color>\{\{\{#(?<colorValue>[A-Za-z0-9#(),._-]+)\s+(?<colorText>.+?)\}\}\})|(?<size>\{\{\{(?<sizeValue>[+-]\d+)\s+(?<sizeText>.+?)\}\}\})|(?<literal>\{\{\{(?<literalText>.+?)\}\}\})|(?<externalWiki>\[\[(?<externalWikiHref>https?:\/\/[^\]|]+)(?:\|(?<externalWikiLabel>.+?))?\]\])|(?<internal>\[\[(?<internalTarget>.+?)(?:\|(?<internalLabel>.+?))?\]\])|(?<external>\[(?<externalHref>https?:\/\/[^\s\]]+)\s+(?<externalLabel>.+?)\])|(?<markdownImage>!\[(?<markdownImageLabel>[^\]\n]*)\]\((?<markdownImageHref>[^)\s\n]+)\))|(?<markdownLink>\[(?<markdownLabel>[^\]\n]+)\]\((?<markdownHref>[^)\s\n]+)\))|(?<macro>\[(?<macroName>[A-Za-z가-힣][A-Za-z0-9가-힣_-]*)(?:\((?<macroArgs>[^\]\n]*)\))?\])|(?<bold>'''(?<boldText>.+?)''')|(?<italic>''(?<italicText>.+?)'')|(?<strikeTilde>~~(?<strikeTildeText>.+?)~~)|(?<strikeDash>--(?<strikeDashText>.+?)--)|(?<underline>__(?<underlineText>.+?)__)|(?<sup>\^\^(?<supText>.+?)\^\^)|(?<sub>,,(?<subText>.+?),,)|(?<escape>\\(?<escapedChar>[\s\S]))/gu;
  const nested = (value: string): InlineNode[] => nestingDepth >= MAX_INLINE_NESTING
    ? [{ type: 'text', text: value }]
    : parseInline(value, links, errors, blockingErrors, footnotes, linkResolution, nestingDepth + 1);
  const nestedLabel = (value: string): InlineNode[] => nestingDepth >= MAX_INLINE_NESTING
    ? [{ type: 'text', text: value }]
    : parseInline(value, new Set(), [], [], [], linkResolution, nestingDepth + 1);
  let last = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index! > last) nodes.push({ type: 'text', text: input.slice(last, match.index) });
    const group = match.groups ?? {};
    if (group.file !== undefined) {
      nodes.push(parseWikiFileMarkup(group.fileBody ?? '', errors, blockingErrors));
    } else if (group.refXmlReuse !== undefined || group.refXml !== undefined || group.refShort !== undefined) {
      const rawName = group.refXmlReuseName ?? group.refXmlName ?? group.refName;
      const name = rawName === undefined ? null : normalizeFootnoteName(rawName);
      const text = group.refXmlReuse !== undefined ? null : (group.refXmlText ?? group.refShortText ?? null);
      if (rawName !== undefined && name === null) errors.push('각주 이름은 64자 이하의 문자, 숫자, 점, 밑줄, 콜론, 하이픈만 사용할 수 있습니다.');
      if (name === null && !text?.trim()) errors.push('빈 각주가 있습니다.');
      if (text !== null) footnotes.push(text);
      nodes.push({
        type: 'ref',
        name,
        text,
        ...(text === null ? {} : { children: stripNestedFootnotes(nested(text)) }),
      });
    } else if (group.legacyMath !== undefined) {
      const source = (group.legacyMathText ?? '').trim();
      const error = validateMathSource(source);
      if (error && !errors.includes(error)) errors.push(error);
      nodes.push({ type: 'math', source, error });
    } else if (group.code !== undefined) {
      nodes.push({ type: 'code', code: group.codeText ?? '' });
    } else if (group.color !== undefined) {
      nodes.push({ type: 'color', color: normalizeInlineColor(group.colorValue ?? ''), children: nested(group.colorText ?? '') });
    } else if (group.size !== undefined) {
      nodes.push({ type: 'size', delta: normalizeInlineSize(group.sizeValue ?? ''), children: nested(group.sizeText ?? '') });
    } else if (group.literal !== undefined) {
      nodes.push({ type: 'code', code: group.literalText ?? '' });
    } else if (group.externalWiki !== undefined) {
      const href = group.externalWikiHref ?? '';
      const label = group.externalWikiLabel ?? href;
      const labelChildren = stripNestedLinks(nestedLabel(label));
      nodes.push({
        type: 'external_link',
        href,
        label: inlineNodesToPlainText(labelChildren) || label,
        labelChildren,
      });
    } else if (group.internal !== undefined) {
      const rawTarget = group.internalTarget ?? '';
      const label = group.internalLabel ?? normalizeTitle(rawTarget);
      const labelChildren = stripNestedLinks(nestedLabel(label));
      const resolved = resolveWikiLinkTarget(rawTarget, linkResolution);
      if ('error' in resolved) {
        if (!blockingErrors.includes(resolved.error)) blockingErrors.push(resolved.error);
        nodes.push({ type: 'text', text: label });
      } else {
        if (resolved.target) links.add(resolved.target);
        nodes.push({
          type: 'internal_link',
          target: resolved.target,
          label: inlineNodesToPlainText(labelChildren) || label,
          labelChildren,
          ...(resolved.fragment === null ? {} : { fragment: resolved.fragment })
        });
      }
    } else if (group.external !== undefined) {
      const href = group.externalHref ?? '';
      const label = group.externalLabel ?? href;
      const labelChildren = stripNestedLinks(nestedLabel(label));
      nodes.push({ type: 'external_link', href, label: inlineNodesToPlainText(labelChildren) || label, labelChildren });
    } else if (group.markdownImage !== undefined) {
      nodes.push({ type: 'text', text: group.markdownImage });
    } else if (group.markdownLink !== undefined) {
      const href = group.markdownHref ?? '';
      const label = group.markdownLabel ?? href;
      if (/^(?:https?:\/\/|mailto:)/iu.test(href) || isSafeLocalHref(href)) {
        const labelChildren = stripNestedLinks(nestedLabel(label));
        nodes.push({ type: 'external_link', href, label: inlineNodesToPlainText(labelChildren) || label, labelChildren });
      } else {
        nodes.push({ type: 'text', text: label });
      }
    } else if (group.macro !== undefined) {
      const name = (group.macroName ?? '').slice(0, 64);
      const macro = parseSafeInlineMacro(name, group.macroArgs, errors);
      nodes.push(macro);
    } else if (group.bold !== undefined) {
      nodes.push({ type: 'bold', children: nested(group.boldText ?? '') });
    } else if (group.italic !== undefined) {
      nodes.push({ type: 'italic', children: nested(group.italicText ?? '') });
    } else if (group.strikeTilde !== undefined || group.strikeDash !== undefined) {
      nodes.push({ type: 'strike', children: nested(group.strikeTildeText ?? group.strikeDashText ?? '') });
    } else if (group.underline !== undefined) {
      nodes.push({ type: 'underline', children: nested(group.underlineText ?? '') });
    } else if (group.sup !== undefined) {
      nodes.push({ type: 'sup', children: nested(group.supText ?? '') });
    } else if (group.sub !== undefined) {
      nodes.push({ type: 'sub', children: nested(group.subText ?? '') });
    } else if (group.escape !== undefined) {
      nodes.push({ type: 'text', text: group.escapedChar ?? '' });
    }
    last = match.index! + match[0].length;
  }
  if (last < input.length) nodes.push({ type: 'text', text: input.slice(last) });
  return nodes;
}

function stripNestedLinks(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'internal_link' || node.type === 'external_link') {
      return [{ type: 'text', text: node.label }];
    }
    if (node.type === 'ref') {
      return [{ type: 'text', text: node.text ?? (node.name ? `[${node.name}]` : '') }];
    }
    if (node.type === 'file') return [{ type: 'text', text: node.caption || node.fileName }];
    if (node.type === 'video') return [{ type: 'text', text: `${node.provider}:${node.videoId}` }];
    if ('children' in node) return [{ ...node, children: stripNestedLinks(node.children) }];
    return [node];
  });
}

function stripNestedFootnotes(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'ref') {
      return [{ type: 'text', text: node.text ?? (node.name ? `[${node.name}]` : '') }];
    }
    if ('children' in node) return [{ ...node, children: stripNestedFootnotes(node.children) }];
    if (node.type === 'internal_link' || node.type === 'external_link') return [{
      ...node,
      ...(node.labelChildren ? { labelChildren: stripNestedFootnotes(node.labelChildren) } : {}),
    }];
    return [node];
  });
}

function inlineNodesToPlainText(nodes: readonly InlineNode[]): string {
  return nodes.map((node): string => {
    if (node.type === 'text') return node.text;
    if (node.type === 'line_break') return ' ';
    if (node.type === 'clearfix' || node.type === 'anchor') return '';
    if (node.type === 'ruby') return node.text;
    if (node.type === 'dynamic_time') return node.date ?? '현재 시각';
    if (node.type === 'dynamic_stat') return '문서 수';
    if (node.type === 'video') return `${node.provider}:${node.videoId}`;
    if (node.type === 'math') return node.source;
    if (node.type === 'internal_link' || node.type === 'external_link') {
      return node.labelChildren ? inlineNodesToPlainText(node.labelChildren) : node.label;
    }
    if (node.type === 'file') return node.caption || node.fileName;
    if (node.type === 'unsupported_macro') return `[${node.name}]`;
    if (node.type === 'code') return node.code;
    if (node.type === 'ref') return node.children
      ? inlineNodesToPlainText(node.children)
      : node.text ?? '';
    return inlineNodesToPlainText(node.children);
  }).join('');
}

function normalizeFootnoteName(value: string): string | null {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > MAX_FOOTNOTE_NAME_LENGTH) return null;
  return /^[\p{Letter}\p{Number}_.:-]+$/u.test(normalized) ? normalized : null;
}

function parseSafeInlineMacro(name: string, rawArgs: string | undefined, errors: string[]): InlineNode {
  const normalizedName = name.toLowerCase();
  if (normalizedName === 'br' && rawArgs === undefined) return { type: 'line_break' };
  if (normalizedName === 'clearfix' && rawArgs === undefined) return { type: 'clearfix' };
  if ((normalizedName === 'date' || normalizedName === 'datetime') && rawArgs === undefined) {
    return { type: 'dynamic_time', mode: 'datetime', date: null };
  }
  if ((normalizedName === 'age' || normalizedName === 'dday') && rawArgs !== undefined) {
    const date = normalizeMacroDate(rawArgs);
    if (date) return { type: 'dynamic_time', mode: normalizedName, date };
    return invalidDateMacro(normalizedName, errors);
  }
  if (normalizedName === 'pagecount') {
    const namespace = rawArgs?.trim().slice(0, 64) || null;
    return { type: 'dynamic_stat', stat: 'pagecount', namespace };
  }
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
  if (normalizedName === 'math' && rawArgs !== undefined) {
    const source = rawArgs.trim();
    const error = validateMathSource(source);
    if (error && !errors.includes(error)) errors.push(error);
    return { type: 'math', source, error };
  }
  if (normalizedName === 'youtube' && rawArgs !== undefined) {
    const [videoId = '', ...parameters] = splitMacroArguments(rawArgs);
    if (!/^[A-Za-z0-9_-]{6,20}$/u.test(videoId)) return invalidYouTubeMacro(errors);
    let width = 640;
    let height = 360;
    let start: number | null = null;
    let end: number | null = null;
    for (const parameter of parameters) {
      const separator = parameter.indexOf('=');
      if (separator < 1) continue;
      const key = parameter.slice(0, separator).trim().toLowerCase();
      const value = parameter.slice(separator + 1).trim();
      if (!/^[0-9]+$/u.test(value)) return invalidYouTubeMacro(errors);
      const parsed = Number(value);
      if (key === 'width') {
        if (parsed < 200 || parsed > 1200) return invalidYouTubeMacro(errors);
        width = parsed;
      } else if (key === 'height') {
        if (parsed < 112 || parsed > 900) return invalidYouTubeMacro(errors);
        height = parsed;
      } else if (key === 'start' || key === 'end') {
        if (parsed < 0 || parsed > 86_400) return invalidYouTubeMacro(errors);
        if (key === 'start') start = parsed;
        else end = parsed;
      }
    }
    if (start !== null && end !== null && end <= start) return invalidYouTubeMacro(errors);
    return { type: 'video', provider: 'youtube', videoId, width, height, start, end };
  }
  if ((normalizedName === 'navertv' || normalizedName === 'nicovideo') && rawArgs !== undefined) {
    const [rawVideoId = '', ...parameters] = splitMacroArguments(rawArgs);
    const videoId = normalizedName === 'navertv'
      ? (/^[0-9]{1,20}$/u.test(rawVideoId) ? rawVideoId : null)
      : normalizeNicoVideoId(rawVideoId);
    if (!videoId) return invalidVideoMacro(normalizedName, errors);
    let width = normalizedName === 'navertv' ? 640 : 720;
    let height = normalizedName === 'navertv' ? 360 : 480;
    for (const parameter of parameters) {
      const separator = parameter.indexOf('=');
      if (separator < 1) continue;
      const key = parameter.slice(0, separator).trim().toLowerCase();
      const value = parameter.slice(separator + 1).trim();
      if (key !== 'width' && key !== 'height') continue;
      if (!/^[0-9]+$/u.test(value)) return invalidVideoMacro(normalizedName, errors);
      const parsed = Number(value);
      if (key === 'width') {
        if (parsed < 200 || parsed > 1200) return invalidVideoMacro(normalizedName, errors);
        width = parsed;
      } else {
        if (parsed < 112 || parsed > 900) return invalidVideoMacro(normalizedName, errors);
        height = parsed;
      }
    }
    return { type: 'video', provider: normalizedName, videoId, width, height, start: null, end: null };
  }
  const warning = `지원되지 않는 매크로입니다: ${name}`;
  if (!errors.includes(warning)) errors.push(warning);
  return { type: 'unsupported_macro', name, ...(rawArgs === undefined ? {} : { rawArgs }) };
}

function normalizeMacroDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (daysInMonth[month - 1] ?? 0)) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function invalidDateMacro(name: string, errors: string[]): InlineNode {
  const warning = `${name} 매크로 날짜는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.`;
  if (!errors.includes(warning)) errors.push(warning);
  return { type: 'unsupported_macro', name };
}

function invalidYouTubeMacro(errors: string[]): InlineNode {
  const warning = 'YouTube 매크로의 동영상 ID 또는 옵션이 올바르지 않습니다.';
  if (!errors.includes(warning)) errors.push(warning);
  return { type: 'unsupported_macro', name: 'youtube' };
}

function normalizeNicoVideoId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9]{1,16}$/u.test(normalized)) return `sm${normalized}`;
  return /^(?:sm|so)[0-9]{1,16}$/u.test(normalized) ? normalized : null;
}

function invalidVideoMacro(name: 'navertv' | 'nicovideo', errors: string[]): InlineNode {
  const warning = `${name} 매크로의 동영상 ID 또는 옵션이 올바르지 않습니다.`;
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
  /** Current document context used to resolve persisted relative-link ASTs. */
  linkResolution?: WikiLinkResolutionContext;
  files?: Record<string, { url: string; mimeType: string; originalName: string; sizeBytes?: number; license?: string | null; sourceUrl?: string | null; sourceText?: string | null }>;
  officialAreas?: Record<string, { status: string; lastModifiedAt?: string | null; renewalRequiredAt?: string | null }>;
  dataTables?: Record<string, { caption: string; headers: string[]; rows: string[][] }>;
  /** Internal heading scope shared by folding blocks, but not transclusions. */
  tocHeadings?: ReadonlyArray<{ level: number; text: string; id: string }>;
  /** Internal guard propagated through folding blocks and transclusions. */
  disableMathRendering?: boolean;
}

export interface DiscussionMarkupMention {
  readonly username: string;
  readonly href: string;
}

export interface DiscussionMarkupCommentReference {
  readonly id: string;
  readonly href: string;
}

export interface DiscussionMarkupOptions extends RenderOptions {
  /** Mentions already validated against active wiki profiles by the caller. */
  mentions?: readonly DiscussionMarkupMention[];
  /** Same-thread comments already filtered through the viewer's visibility rules. */
  commentReferences?: readonly DiscussionMarkupCommentReference[];
  /** A persisted structured poll already represents the legacy vote macro. */
  convertedVoteMacro?: boolean;
}

export interface DiscussionVoteMacro {
  readonly question: string;
  readonly options: readonly string[];
}

/** Collect bounded numeric reference candidates; rendering still excludes code and link literals. */
export function extractDiscussionCommentReferenceIds(raw: string, limit = 20): readonly string[] {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const ids = new Set<string>();
  const pattern = /(?:^|[^\p{L}\p{N}_])#([1-9]\d{0,19})(?![\p{L}\p{N}_])/gu;
  for (const match of String(raw).matchAll(pattern)) {
    const id = match[1];
    if (!id) continue;
    // Prisma/MariaDB discussion IDs are signed BIGINT values. Reject larger
    // numeric-looking input before it reaches a database query.
    if (BigInt(id) > 9_223_372_036_854_775_807n) continue;
    ids.add(id);
    if (ids.size >= boundedLimit) break;
  }
  return [...ids];
}

/** Extract vote macros through the real parser so code and link literals are never converted. */
export function extractDiscussionVoteMacros(raw: string): readonly DiscussionVoteMacro[] {
  const parsed = parseMarkup(raw);
  const macros: DiscussionVoteMacro[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.type === 'unsupported_macro' && typeof node.name === 'string' && node.name.toLowerCase() === 'vote') {
      const args = typeof node.rawArgs === 'string' ? splitMacroArguments(node.rawArgs) : [];
      macros.push({ question: args[0] ?? '', options: args.slice(1) });
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parsed.ast);
  return macros;
}

/** Render the deliberately small NamuMark subset supported inside discussions. */
export function renderDiscussionMarkup(raw: string, options: DiscussionMarkupOptions = {}): string {
  const { mentions = [], commentReferences = [], convertedVoteMacro = false, ...renderOptions } = options;
  const parsed = parseMarkup(raw, { linkResolution: renderOptions.linkResolution });
  const mentionByUsername = new Map(mentions
    .filter((mention) => /^[A-Za-z0-9_]{3,16}$/u.test(mention.username) && /^\/user\/[A-Za-z0-9_%._~-]+$/u.test(mention.href))
    .map((mention) => [mention.username.toLocaleLowerCase('en-US'), mention]));
  const commentReferenceById = new Map(commentReferences
    .filter((reference) => /^[1-9]\d{0,19}$/u.test(reference.id) && reference.href === `#comment-${reference.id}`)
    .map((reference) => [reference.id, reference]));

  const injectDiscussionLinks = (value: string): InlineNode[] => {
    if ((mentionByUsername.size === 0 || !value.includes('@'))
      && (commentReferenceById.size === 0 || !value.includes('#'))) return [{ type: 'text', text: value }];
    const output: InlineNode[] = [];
    let plainStart = 0;
    let cursor = 0;
    while (cursor < value.length) {
      const marker = value[cursor];
      let href: string | undefined;
      let tokenLength = 0;
      if (marker === '@' && !(cursor > 0 && /[A-Za-z0-9_]/u.test(value[cursor - 1] ?? ''))) {
        const match = value.slice(cursor + 1).match(/^[A-Za-z0-9_]{3,16}/u);
        const username = match?.[0] ?? '';
        const next = value[cursor + 1 + username.length] ?? '';
        const mention = username && !/[A-Za-z0-9_]/u.test(next)
          ? mentionByUsername.get(username.toLocaleLowerCase('en-US'))
          : undefined;
        if (mention) {
          href = mention.href;
          tokenLength = username.length + 1;
        }
      } else if (marker === '#' && !(cursor > 0 && /[\p{L}\p{N}_]/u.test(value[cursor - 1] ?? ''))) {
        const id = value.slice(cursor + 1).match(/^\d{1,20}/u)?.[0] ?? '';
        const next = value[cursor + 1 + id.length] ?? '';
        const reference = id && !/[\p{L}\p{N}_]/u.test(next) ? commentReferenceById.get(id) : undefined;
        if (reference) {
          href = reference.href;
          tokenLength = id.length + 1;
        }
      }
      if (!href || tokenLength === 0) {
        cursor += 1;
        continue;
      }
      if (cursor > plainStart) output.push({ type: 'text', text: value.slice(plainStart, cursor) });
      output.push({ type: 'external_link', href, label: value.slice(cursor, cursor + tokenLength) });
      cursor += tokenLength;
      plainStart = cursor;
    }
    if (plainStart < value.length) output.push({ type: 'text', text: value.slice(plainStart) });
    return output.length > 0 ? output : [{ type: 'text', text: value }];
  };

  const restrictInline = (nodes: readonly InlineNode[], allowMentions = true): InlineNode[] => nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'text') return allowMentions ? injectDiscussionLinks(node.text) : [node];
    if (node.type === 'internal_link' || node.type === 'external_link') return [{
      ...node,
      ...(node.labelChildren ? { labelChildren: restrictInline(node.labelChildren, false) } : {}),
    }];
    if (node.type === 'line_break' || node.type === 'code') return [node];
    if (node.type === 'ruby') return [{ type: 'text', text: node.text }];
    if (node.type === 'unsupported_macro' && node.name.toLowerCase() === 'vote') {
      return convertedVoteMacro ? [] : [{ type: 'text', text: '[지원되지 않는 투표 매크로]' }];
    }
    if (node.type === 'bold' || node.type === 'italic' || node.type === 'strike'
      || node.type === 'underline' || node.type === 'sup' || node.type === 'sub') {
      return [{ ...node, children: restrictInline(node.children, allowMentions) }];
    }
    if (node.type === 'color' || node.type === 'size') return restrictInline(node.children, allowMentions);
    return [];
  });

  const restrictList = (list: WikiListNode): WikiListNode => ({
    ...list,
    items: list.items.map((item) => ({
      children: restrictInline(item.children),
      nested: item.nested.map(restrictList),
    })),
  });
  const restrictAst = (nodes: readonly AstNode[]): AstNode[] => nodes.flatMap((node): AstNode[] => {
    if (node.type === 'heading') return [{
      type: 'paragraph',
      children: restrictInline(node.children ?? [{ type: 'text', text: node.text }]),
    }];
    if (node.type === 'paragraph') return [{ ...node, children: restrictInline(node.children) }];
    if (node.type === 'list') return [restrictList(node)];
    if (node.type === 'indent') return [{ ...node, children: restrictAst(node.children) }];
    if (node.type === 'blockquote') return [{ ...node, children: restrictAst(node.children) }];
    if (node.type === 'hr' || node.type === 'codeblock') return [node];
    if (node.type === 'wiki_table') {
      return [{
        ...node,
        caption: restrictInline(node.caption),
        rows: node.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({
            ...cell,
            children: restrictInline(cell.children),
            ...(cell.blocks ? { blocks: restrictAst(cell.blocks) } : {}),
          })),
        })),
      }];
    }
    if (node.type === 'folding') {
      const title = restrictInline(node.title);
      return [...(title.length > 0 ? [{ type: 'paragraph' as const, children: title }] : []), ...restrictAst(node.children)];
    }
    if (node.type === 'conditional') return node.state === 'visible' ? restrictAst(node.children) : [];
    if (node.type === 'wiki_style') return restrictAst(node.children);
    return [];
  });

  return renderDocument(restrictAst(parsed.ast), renderOptions);
}

interface RenderedFootnote {
  name: string | null;
  text: string;
  children?: InlineNode[];
  referenceIds: string[];
}

interface FootnoteDefinition {
  text: string;
  children?: InlineNode[];
}

interface FootnoteRenderState {
  entries: RenderedFootnote[];
  namedIndexes: Map<string, number>;
  definitions: Map<string, FootnoteDefinition>;
}

export function renderDocument(ast: AstNode[], options: RenderOptions = {}): string {
  const footnotes: FootnoteRenderState = {
    entries: [],
    namedIndexes: new Map(),
    definitions: collectNamedFootnoteDefinitions(ast)
  };
  let emittedFootnotes = 0;
  const footnoteMarkers: Array<{ token: string; startIndex: number; endIndex: number }> = [];
  const tocHeadings = options.tocHeadings ?? collectTocHeadings(ast);
  const renderOptions: RenderOptions = {
    ...options,
    disableMathRendering: options.disableMathRendering ?? countMathNodes(ast) > MAX_MATH_NODES
  };
  const renderNodes = (nodes: readonly AstNode[]): string => {
    const output: string[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;
      if (node.type === 'heading' && node.folded) {
        let sectionEnd = index + 1;
        while (sectionEnd < nodes.length && nodes[sectionEnd]?.type !== 'heading') sectionEnd += 1;
        const heading = renderHeading(node, footnotes, renderOptions);
        output.push(`<details class="wiki-heading-section"><summary class="wiki-heading-summary">${heading}</summary><div class="wiki-heading-content">${renderNodes(nodes.slice(index + 1, sectionEnd))}</div></details>`);
        index = sectionEnd - 1;
        continue;
      }
      if (node.type === 'heading') {
        output.push(renderHeading(node, footnotes, renderOptions));
        continue;
      }
      if (node.type === 'paragraph') {
        output.push(`<p>${renderInline(node.children, footnotes, renderOptions)}</p>`);
        continue;
      }
      if (node.type === 'list') {
        output.push(renderWikiList(node, footnotes, renderOptions));
        continue;
      }
      if (node.type === 'blockquote') {
        output.push(`<blockquote class="wiki-quote">${renderNodes(node.children)}</blockquote>`);
        continue;
      }
      if (node.type === 'indent') {
        output.push(`<div class="wiki-indent">${renderNodes(node.children)}</div>`);
        continue;
      }
      if (node.type === 'hr') {
        output.push('<hr>');
        continue;
      }
      if (node.type === 'wiki_table') {
        output.push(renderWikiTable(node.caption, node.rows, node.options, footnotes, renderOptions, renderNodes));
        continue;
      }
      if (node.type === 'folding') {
        output.push(`<details class="fold wiki-fold"><summary>${renderInline(node.title, footnotes, renderOptions)}</summary>${renderDocument(node.children, { ...renderOptions, tocHeadings })}</details>`);
        continue;
      }
      if (node.type === 'conditional') {
        if (node.state === 'visible') output.push(renderNodes(node.children));
        continue;
      }
      if (node.type === 'wiki_style') {
        const style = styleAttribute({
          color: node.style?.color,
          'background-color': node.style?.backgroundColor,
          'text-align': node.style?.textAlign,
          border: node.style?.border,
          'border-color': node.style?.borderColor,
          'border-radius': node.style?.borderRadius,
          padding: node.style?.padding,
          margin: node.style?.margin,
          width: node.style?.width,
          'max-width': node.style?.maxWidth,
          'writing-mode': node.writingMode ?? undefined,
          '--wiki-dark-color': node.darkStyle?.color,
          '--wiki-dark-background-color': node.darkStyle?.backgroundColor,
          '--wiki-dark-border-color': node.darkStyle?.borderColor
        });
        output.push(`<div class="wiki-style"${style}>${renderDocument(node.children, { ...renderOptions, tocHeadings })}</div>`);
        continue;
      }
      if (node.type === 'toc') {
        output.push(renderTableOfContents(tocHeadings, node.collapsed));
        continue;
      }
      if (node.type === 'include') {
        if (node.state === 'resolved' && node.children) {
          output.push(`<section class="wiki-transclusion">${renderDocument(node.children, renderOptions)}</section>`);
          continue;
        }
        const message = node.state === 'unavailable'
          ? '포함 문서를 불러올 수 없습니다.'
          : '포함 문서는 저장한 뒤 표시됩니다.';
        output.push(`<aside class="wiki-include-notice">${message}</aside>`);
        continue;
      }
      if (node.type === 'category') continue;
      if (node.type === 'file') {
        output.push(renderFile(node.fileName, node.thumbnail, node.caption, node.display, renderOptions));
        continue;
      }
      if (node.type === 'redirect') {
        output.push(`<p class="notice">넘겨주기: ${renderInternalLink(node.target, node.target, renderOptions)}</p>`);
        continue;
      }
      if (node.type === 'math_block') {
        output.push(renderMath(
          node.source,
          true,
          renderOptions.disableMathRendering ? `수식은 문서당 ${MAX_MATH_NODES}개까지 표시할 수 있습니다.` : node.error
        ));
        continue;
      }
      if (node.type === 'codeblock') {
        output.push(renderCodeBlock(node.code, node.lang));
        continue;
      }
      if (node.name === 'references') {
        const token = `__MINEWIKI_FOOTNOTES_${footnoteMarkers.length}__`;
        footnoteMarkers.push({ token, startIndex: emittedFootnotes, endIndex: footnotes.entries.length });
        output.push(token);
        emittedFootnotes = footnotes.entries.length;
        continue;
      }
      output.push(renderComponent(node.name, node.props, renderOptions));
    }
    return output.join('\n');
  };
  let html = renderNodes(ast);
  for (const marker of footnoteMarkers) {
    html = html.replace(marker.token, renderFootnoteSection(footnotes, marker.startIndex, marker.endIndex, renderOptions));
  }
  const footnoteHtml = renderFootnoteSection(footnotes, emittedFootnotes, footnotes.entries.length, renderOptions);
  return sanitizeHtml(`${html}${footnoteHtml}`, {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'class', 'rel', 'target', 'title', 'aria-label'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
      pre: ['class', 'data-lang'],
      code: ['class'],
      div: ['class', 'data-*', 'style'],
      aside: ['class'],
      figure: ['class'],
      img: ['src', 'alt', 'loading', 'class', 'style'],
      video: ['src', 'controls', 'preload', 'playsinline', 'class', 'style', 'aria-label'],
      figcaption: ['class'],
      section: ['class'],
      nav: ['class', 'aria-label'],
      form: ['class', 'action', 'method', 'role', 'aria-label'],
      input: ['class', 'type', 'name', 'placeholder', 'aria-label', 'autocomplete'],
      button: ['class', 'type', 'style', 'data-wiki-sort-column', 'data-wiki-file-src', 'data-wiki-file-alt'],
      blockquote: ['class'],
      caption: ['class'],
      span: ['class', 'style', 'title', 'id', 'aria-hidden', 'aria-label'],
      time: ['class', 'datetime', 'data-wiki-time', 'data-wiki-date'],
      output: ['class', 'data-wiki-stat', 'data-wiki-namespace', 'aria-label'],
      ruby: ['class'],
      rt: ['class'],
      rp: ['class'],
      s: ['class'],
      u: ['class'],
      sup: ['class', 'id'],
      sub: ['class'],
      table: ['class', 'data-table-key', 'style'],
      tr: ['style'],
      th: ['class', 'colspan', 'rowspan', 'style'],
      td: ['class', 'colspan', 'rowspan', 'style'],
      details: ['class', 'open'],
      ul: ['class'],
      ol: ['class', 'start', 'type'],
      li: ['class', 'id'],
      summary: ['class'],
      iframe: ['class', 'src', 'title', 'loading', 'allow', 'allowfullscreen', 'referrerpolicy', 'sandbox'],
      math: ['xmlns', 'display'],
      annotation: ['encoding'],
      svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio'],
      path: ['d']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedIframeHostnames: ['www.youtube-nocookie.com', 'tv.naver.com', 'embed.nicovideo.jp'],
    allowedStyles: {
      span: {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i, /^[a-z]+$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'font-size': [/^\d+(\.\d+)?em$/],
        'border-radius': [/^\d+(?:px|%)$/],
        'max-width': [/^\d+px$/],
        'aspect-ratio': [/^\d+ \/ \d+$/],
        height: [/^-?\d+(?:\.\d+)?(?:em|px|%)$/],
        width: [/^-?\d+(?:\.\d+)?(?:em|px|%)$/],
        'image-rendering': [/^(?:auto|smooth|high-quality|pixelated|crisp-edges)$/],
        'object-fit': [/^(?:fill|contain|cover|none|scale-down)$/],
        top: [/^-?\d+(?:\.\d+)?em$/],
        'vertical-align': [/^-?\d+(?:\.\d+)?em$/],
        'margin-left': [/^-?\d+(?:\.\d+)?em$/],
        'margin-right': [/^-?\d+(?:\.\d+)?em$/],
        'padding-left': [/^-?\d+(?:\.\d+)?em$/],
        'min-width': [/^-?\d+(?:\.\d+)?em$/],
        'border-bottom-width': [/^-?\d+(?:\.\d+)?em$/]
      },
      img: {
        width: [/^100%$/],
        height: [/^100%$/],
        'border-radius': [/^\d+(?:px|%)$/],
        'image-rendering': [/^(?:auto|smooth|high-quality|pixelated|crisp-edges)$/],
        'object-fit': [/^(?:fill|contain|cover|none|scale-down)$/]
      },
      video: {
        width: [/^100%$/],
        height: [/^100%$/],
        'border-radius': [/^\d+(?:px|%)$/],
        'object-fit': [/^(?:fill|contain|cover|none|scale-down)$/]
      },
      div: {
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        'max-width': [/^\d+(?:\.\d+)?(?:px|%)$/],
        margin: [/^(?:(?:0|\d+(?:\.\d+)?(?:px|rem|em|%)|auto)(?:\s+|$)){1,4}$/],
        padding: [/^(?:(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))(?:\s+|$)){1,4}$/],
        'margin-left': [/^auto$/],
        'margin-right': [/^auto$/],
        color: [/^#[0-9a-f]{3,8}$/i, CSS_NAMED_COLOR_PATTERN],
        'background-color': [/^#[0-9a-f]{3,8}$/i, CSS_NAMED_COLOR_PATTERN],
        'text-align': [/^(?:left|center|right|justify)$/],
        border: [/^(?:0|[1-8]px) (?:solid|dashed|dotted) #[0-9a-f]{3,8}$/i, CSS_NAMED_BORDER_PATTERN],
        'border-color': [/^#[0-9a-f]{3,8}$/i, CSS_NAMED_COLOR_PATTERN],
        'border-radius': [/^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/],
        'writing-mode': [/^(?:horizontal-tb|vertical-rl|vertical-lr)$/],
        '--wiki-dark-color': [/^#[0-9a-f]{3,8}$/i, CSS_NAMED_COLOR_PATTERN],
        '--wiki-dark-background-color': [/^#[0-9a-f]{3,8}$/i, CSS_NAMED_COLOR_PATTERN],
        '--wiki-dark-border-color': [/^#[0-9a-f]{3,8}$/i, CSS_NAMED_COLOR_PATTERN]
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
      tr: {
        color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'word-break': [/^keep-all$/],
        '--wiki-dark-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-background-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i]
      },
      th: {
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        height: [/^\d+(?:\.\d+)?(?:px|%)$/],
        color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]{1,32}$/i],
        'text-align': [/^(?:left|center|right)$/],
        'vertical-align': [/^(?:top|middle|bottom)$/],
        padding: [/^0$/],
        'word-break': [/^keep-all$/],
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
        padding: [/^0$/],
        'word-break': [/^keep-all$/],
        '--wiki-dark-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i],
        '--wiki-dark-background-color': [/^(?:#[0-9a-f]{3,8}|[a-z]{1,32})$/i]
      }
    }
  });
}

function renderFootnoteSection(
  footnotes: FootnoteRenderState,
  startIndex: number,
  endIndex = footnotes.entries.length,
  options: RenderOptions = {},
): string {
  if (startIndex >= endIndex) return '';
  const listStart = startIndex > 0 ? ` start="${startIndex + 1}"` : '';
  const items = footnotes.entries
    .slice(startIndex, endIndex)
    .map((note, index) => {
      const number = startIndex + index + 1;
      const backlinks = note.referenceIds.length === 0 ? '' : `<span class="wiki-footnote-backlinks" aria-label="각주 ${number} 참조로 돌아가기">${note.referenceIds
        .map((referenceId, referenceIndex) => `<a href="#${referenceId}" aria-label="각주 ${number}의 ${referenceIndex + 1}번째 참조로 돌아가기">↩${note.referenceIds.length > 1 ? referenceIndex + 1 : ''}</a>`)
        .join(' ')}</span>`;
      const text = note.text || `정의되지 않은 각주: ${note.name ?? number}`;
      const content = note.children?.length
        ? renderInline(note.children, footnotes, options)
        : escapeHtml(text);
      return `<li id="fn-${number}">${content}${backlinks ? ` ${backlinks}` : ''}</li>`;
    })
    .join('');
  return `<section class="footnotes"><h2>각주</h2><ol${listStart}>${items}</ol></section>`;
}

function collectNamedFootnoteDefinitions(ast: readonly AstNode[]): Map<string, FootnoteDefinition> {
  const definitions = new Map<string, FootnoteDefinition>();
  const collectInline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === 'ref' && node.name !== null && node.text?.trim() && !definitions.has(node.name)) {
        definitions.set(node.name, {
          text: node.text,
          ...(node.children ? { children: node.children } : {}),
        });
      }
      if ('children' in node) {
        collectInline(node.children);
      }
      if ((node.type === 'internal_link' || node.type === 'external_link') && node.labelChildren) {
        collectInline(node.labelChildren);
      }
    }
  };
  const collectList = (list: WikiListNode) => {
    for (const item of list.items) {
      collectInline(item.children);
      item.nested.forEach(collectList);
    }
  };
  for (const node of ast) {
    if (node.type === 'heading' && node.children) collectInline(node.children);
    else if (node.type === 'paragraph') collectInline(node.children);
    else if (node.type === 'indent') {
      for (const [name, definition] of collectNamedFootnoteDefinitions(node.children)) {
        if (!definitions.has(name)) definitions.set(name, definition);
      }
    }
    else if (node.type === 'blockquote') {
      for (const [name, definition] of collectNamedFootnoteDefinitions(node.children)) {
        if (!definitions.has(name)) definitions.set(name, definition);
      }
    }
    else if (node.type === 'list') collectList(node);
    else if (node.type === 'wiki_table') {
      collectInline(node.caption);
      for (const row of node.rows) for (const cell of row.cells) {
        collectInline(cell.children);
        if (cell.blocks) for (const [name, definition] of collectNamedFootnoteDefinitions(cell.blocks)) {
          if (!definitions.has(name)) definitions.set(name, definition);
        }
      }
    } else if (node.type === 'folding') {
      collectInline(node.title);
      for (const [name, definition] of collectNamedFootnoteDefinitions(node.children)) {
        if (!definitions.has(name)) definitions.set(name, definition);
      }
    } else if (
      node.type === 'wiki_style'
      || (node.type === 'conditional' && node.state === 'visible')
      || (node.type === 'include' && node.children)
    ) {
      for (const [name, definition] of collectNamedFootnoteDefinitions(node.children)) {
        if (!definitions.has(name)) definitions.set(name, definition);
      }
    }
  }
  return definitions;
}

function collectTocHeadings(ast: readonly AstNode[]): Array<{ level: number; text: string; id: string }> {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  for (const node of ast) {
    if (node.type === 'heading') headings.push(node);
    // Included headings belong to their own heading scope and must not leak into
    // the caller's table of contents.
    if (
      node.type === 'folding'
      || node.type === 'wiki_style'
      || node.type === 'blockquote'
      || node.type === 'indent'
      || (node.type === 'conditional' && node.state === 'visible')
    ) {
      headings.push(...collectTocHeadings(node.children));
    }
  }
  return headings;
}

function assignStructuralHeadingIds(ast: readonly AstNode[]): void {
  const headings = collectTocHeadings(ast) as Array<Extract<AstNode, { type: 'heading' }>>;
  if (headings.length === 0) return;
  const minimumLevel = Math.min(...headings.map((heading) => heading.level));
  const counters = Array.from({ length: 7 - minimumLevel }, () => 0);
  const seenLegacyIds = new Set<string>();
  for (const heading of headings) {
    const depth = Math.max(0, Math.min(counters.length - 1, heading.level - minimumLevel));
    counters[depth] = (counters[depth] ?? 0) + 1;
    for (let index = depth + 1; index < counters.length; index += 1) counters[index] = 0;
    heading.id = `s-${counters.slice(0, depth + 1).join('.')}`;
    const legacyId = makeHeadingId(heading.text);
    if (legacyId && legacyId !== heading.id && !seenLegacyIds.has(legacyId)) {
      heading.legacyId = legacyId;
      seenLegacyIds.add(legacyId);
    } else {
      delete heading.legacyId;
    }
  }
}

function renderHeading(
  node: Extract<AstNode, { type: 'heading' }>,
  footnotes: FootnoteRenderState,
  options: RenderOptions,
): string {
  const legacyAnchor = node.legacyId
    ? `<span class="wiki-anchor" id="${escapeAttr(node.legacyId)}"></span>`
    : '';
  const content = node.children
    ? renderInline(node.children, footnotes, options)
    : escapeHtml(node.text);
  return `<h${node.level} id="${escapeAttr(node.id)}">${legacyAnchor}${content}</h${node.level}>`;
}

function renderTableOfContents(
  headings: ReadonlyArray<{ level: number; text: string; id: string }>,
  collapsed: boolean
) {
  if (headings.length === 0) {
    return '<aside class="wiki-toc-empty">목차에 표시할 제목이 없습니다.</aside>';
  }
  const minimumLevel = Math.min(...headings.map((heading) => heading.level));
  const counters = Array.from({ length: 7 - minimumLevel }, () => 0);
  const items = headings.map((heading) => {
    const depth = Math.max(0, Math.min(counters.length - 1, heading.level - minimumLevel));
    counters[depth] = (counters[depth] ?? 0) + 1;
    for (let index = depth + 1; index < counters.length; index += 1) counters[index] = 0;
    const number = counters.slice(0, depth + 1).join('.');
    return `<li class="wiki-toc-level-${depth + 1}"><a href="#${escapeAttr(heading.id)}"><span>${number}</span>${escapeHtml(heading.text)}</a></li>`;
  }).join('');
  return `<nav class="wiki-toc" aria-label="문서 목차"><details${collapsed ? '' : ' open'}><summary>목차</summary><ol>${items}</ol></details></nav>`;
}

export function renderInline(nodes: InlineNode[], footnotes: FootnoteRenderState, options: RenderOptions = {}) {
  const disableMathRendering = options.disableMathRendering
    ?? nodes.filter((node) => node.type === 'math').length > MAX_MATH_NODES;
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
      if (node.type === 'dynamic_time') {
        const dateAttributes = node.date
          ? ` data-wiki-date="${escapeAttr(node.date)}" datetime="${escapeAttr(node.date)}"`
          : '';
        const fallback = node.date ?? '현재 시각';
        return `<time class="wiki-dynamic-time" data-wiki-time="${node.mode}"${dateAttributes}>${escapeHtml(fallback)}</time>`;
      }
      if (node.type === 'dynamic_stat') {
        const namespaceAttribute = node.namespace
          ? ` data-wiki-namespace="${escapeAttr(node.namespace)}"`
          : '';
        return `<output class="wiki-dynamic-stat" data-wiki-stat="${node.stat}"${namespaceAttribute} aria-label="문서 수">…</output>`;
      }
      if (node.type === 'bold') return `<strong>${renderInline(node.children, footnotes, options)}</strong>`;
      if (node.type === 'italic') return `<em>${renderInline(node.children, footnotes, options)}</em>`;
      if (node.type === 'strike') return `<s>${renderInline(node.children, footnotes, options)}</s>`;
      if (node.type === 'underline') return `<u>${renderInline(node.children, footnotes, options)}</u>`;
      if (node.type === 'sup') return `<sup>${renderInline(node.children, footnotes, options)}</sup>`;
      if (node.type === 'sub') return `<sub>${renderInline(node.children, footnotes, options)}</sub>`;
      if (node.type === 'color') return `<span class="${inlineColorClass(node.color)}" style="color: ${escapeAttr(node.color)}">${renderInline(node.children, footnotes, options)}</span>`;
      if (node.type === 'size') return `<span class="wiki-size" style="font-size: ${inlineSizeEm(node.delta)}em">${renderInline(node.children, footnotes, options)}</span>`;
      if (node.type === 'code') return `<code>${escapeHtml(node.code)}</code>`;
      if (node.type === 'external_link') {
        const external = /^https?:\/\//iu.test(node.href);
        const attributes = external ? ' rel="nofollow noopener" target="_blank"' : '';
        const content = node.labelChildren
          ? renderInline(node.labelChildren, footnotes, options)
          : escapeHtml(node.label);
        return `<a href="${escapeAttr(node.href)}"${attributes}>${content}</a>`;
      }
      if (node.type === 'internal_link') {
        const content = node.labelChildren
          ? renderInline(node.labelChildren, footnotes, options)
          : undefined;
        return renderInternalLink(node.target, node.label, options, node.fragment, content);
      }
      if (node.type === 'file') return renderFile(node.fileName, node.thumbnail, node.caption, node.display, options, true);
      if (node.type === 'video') {
        return renderVideo(node);
      }
      if (node.type === 'math') {
        return renderMath(
          node.source,
          false,
          disableMathRendering ? `수식은 문서당 ${MAX_MATH_NODES}개까지 표시할 수 있습니다.` : node.error
        );
      }
      if (node.type === 'unsupported_macro') {
        return `<span class="wiki-macro-warning" title="지원되지 않는 매크로">지원하지 않는 매크로: [${escapeHtml(node.name)}]</span>`;
      }
      let index: number;
      if (node.name !== null) {
        const existing = footnotes.namedIndexes.get(node.name);
        if (existing !== undefined) {
          index = existing;
          const entry = footnotes.entries[index - 1];
          if (entry && !entry.text && node.text?.trim()) {
            entry.text = node.text;
            if (node.children) entry.children = node.children;
          }
        } else {
          index = footnotes.entries.length + 1;
          footnotes.namedIndexes.set(node.name, index);
          const definition = footnotes.definitions.get(node.name);
          footnotes.entries.push({
            name: node.name,
            text: node.text?.trim() ? node.text : (definition?.text ?? ''),
            ...(node.children
              ? { children: node.children }
              : definition?.children ? { children: definition.children } : {}),
            referenceIds: []
          });
        }
      } else {
        index = footnotes.entries.length + 1;
        footnotes.entries.push({
          name: null,
          text: node.text ?? '',
          ...(node.children ? { children: node.children } : {}),
          referenceIds: [],
        });
      }
      const entry = footnotes.entries[index - 1]!;
      const referenceId = `fnref-${index}-${entry.referenceIds.length + 1}`;
      entry.referenceIds.push(referenceId);
      return `<sup class="wiki-footnote-ref" id="${referenceId}"><a href="#fn-${index}" aria-label="각주 ${index}">[${index}]</a></sup>`;
    })
    .join('');
}

function renderVideo(node: Extract<InlineNode, { type: 'video' }>): string {
  let src: string;
  let title: string;
  let allow = 'fullscreen';
  if (node.provider === 'youtube') {
    const query = new URLSearchParams();
    if (node.start !== null) query.set('start', String(node.start));
    if (node.end !== null) query.set('end', String(node.end));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    src = `https://www.youtube-nocookie.com/embed/${node.videoId}${suffix}`;
    title = 'YouTube 동영상';
    allow = 'encrypted-media; picture-in-picture; fullscreen';
  } else if (node.provider === 'navertv') {
    src = `https://tv.naver.com/embed/${node.videoId}`;
    title = '네이버TV 동영상';
  } else {
    src = `https://embed.nicovideo.jp/watch/${node.videoId}`;
    title = '니코니코 동영상';
  }
  return `<span class="wiki-media-wrapper" style="max-width:${node.width}px;aspect-ratio:${node.width} / ${node.height}"><iframe class="wiki-media" src="${escapeAttr(src)}" title="${title}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" allow="${allow}" allowfullscreen></iframe></span>`;
}

function validateMathSource(source: string): string | null {
  if (!source) return '빈 수식은 표시할 수 없습니다.';
  if (Buffer.byteLength(source, 'utf8') > MAX_MATH_SOURCE_BYTES) {
    return `수식은 ${MAX_MATH_SOURCE_BYTES} bytes를 초과할 수 없습니다.`;
  }
  if (/\\(?:href|url|includegraphics|html[A-Za-z]*)\b/u.test(source)) {
    return '외부 링크 또는 HTML을 만드는 수식 명령은 사용할 수 없습니다.';
  }
  return null;
}

function renderMath(source: string, displayMode: boolean, validationError: string | null): string {
  const wrapper = displayMode ? 'div' : 'span';
  const modeClass = displayMode ? 'wiki-math-block' : 'wiki-math-inline';
  if (validationError) {
    return `<${wrapper} class="wiki-math-error" title="${escapeAttr(validationError)}">수식 문법 오류</${wrapper}>`;
  }
  try {
    const html = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'error',
      maxExpand: 100,
      maxSize: 10,
      output: 'htmlAndMathml'
    });
    return `<${wrapper} class="wiki-math ${modeClass}">${html}</${wrapper}>`;
  } catch {
    return `<${wrapper} class="wiki-math-error" title="수식 문법을 확인해 주세요.">수식 문법 오류</${wrapper}>`;
  }
}

function countMathNodes(ast: readonly AstNode[]): number {
  const countInline = (nodes: readonly InlineNode[]): number => nodes.reduce((count, node) => {
    let nestedCount = 'children' in node ? countInline(node.children) : 0;
    if ((node.type === 'internal_link' || node.type === 'external_link') && node.labelChildren) {
      nestedCount += countInline(node.labelChildren);
    }
    return count + (node.type === 'math' ? 1 : 0) + nestedCount;
  }, 0);
  const countList = (list: WikiListNode): number => list.items.reduce(
    (count, item) => count + countInline(item.children) + item.nested.reduce((nestedCount, nested) => nestedCount + countList(nested), 0),
    0
  );
  return ast.reduce((count, node) => {
    if (node.type === 'math_block') return count + 1;
    if (node.type === 'heading' && node.children) return count + countInline(node.children);
    if (node.type === 'paragraph') return count + countInline(node.children);
    if (node.type === 'indent') return count + countMathNodes(node.children);
    if (node.type === 'blockquote') return count + countMathNodes(node.children);
    if (node.type === 'list') return count + countList(node);
    if (node.type === 'wiki_table') {
      return count + countInline(node.caption) + node.rows.reduce(
        (rowCount, row) => rowCount + row.cells.reduce(
          (cellCount, cell) => cellCount + countInline(cell.children) + (cell.blocks ? countMathNodes(cell.blocks) : 0),
          0,
        ),
        0
      );
    }
    if (node.type === 'folding') return count + countInline(node.title) + countMathNodes(node.children);
    if (node.type === 'conditional' && node.state === 'visible') return count + countMathNodes(node.children);
    if (node.type === 'wiki_style') return count + countMathNodes(node.children);
    if (node.type === 'include' && node.children) return count + countMathNodes(node.children);
    return count;
  }, 0);
}

export function collectWikiFileNames(ast: readonly AstNode[], output = new Set<string>()): Set<string> {
  const collectInline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') output.add(node.fileName);
      else if ('children' in node) collectInline(node.children);
      if ((node.type === 'internal_link' || node.type === 'external_link') && node.labelChildren) {
        collectInline(node.labelChildren);
      }
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
    else if (node.type === 'heading' && node.children) collectInline(node.children);
    else if (node.type === 'paragraph') collectInline(node.children);
    else if (node.type === 'indent') collectWikiFileNames(node.children, output);
    else if (node.type === 'blockquote') collectWikiFileNames(node.children, output);
    else if (node.type === 'list') collectList(node);
    else if (node.type === 'wiki_table') {
      collectInline(node.caption);
      for (const row of node.rows) for (const cell of row.cells) {
        collectInline(cell.children);
        if (cell.blocks) collectWikiFileNames(cell.blocks, output);
      }
    } else if (
      node.type === 'folding'
      || node.type === 'wiki_style'
      || (node.type === 'conditional' && node.state === 'visible')
      || (node.type === 'include' && node.children)
    ) {
      collectWikiFileNames(node.children, output);
    }
  }
  return output;
}

export function collectWikiLinkTargets(ast: readonly AstNode[], output = new Set<string>()): Set<string> {
  const collectInline = (nodes: readonly InlineNode[]) => {
    for (const node of nodes) {
      if (node.type === 'internal_link') {
        const resolved = resolveWikiLinkTarget(node.target);
        if (!('error' in resolved) && resolved.target) output.add(resolved.target);
      } else if ('children' in node) collectInline(node.children);
      if ((node.type === 'internal_link' || node.type === 'external_link') && node.labelChildren) {
        collectInline(node.labelChildren);
      }
    }
  };
  const collectList = (list: WikiListNode) => {
    for (const item of list.items) {
      collectInline(item.children);
      for (const nested of item.nested) collectList(nested);
    }
  };

  for (const node of ast) {
    if (node.type === 'heading' && node.children) collectInline(node.children);
    else if (node.type === 'paragraph') collectInline(node.children);
    else if (node.type === 'indent') collectWikiLinkTargets(node.children, output);
    else if (node.type === 'blockquote') collectWikiLinkTargets(node.children, output);
    else if (node.type === 'list') collectList(node);
    else if (node.type === 'wiki_table') {
      collectInline(node.caption);
      for (const row of node.rows) for (const cell of row.cells) {
        collectInline(cell.children);
        if (cell.blocks) collectWikiLinkTargets(cell.blocks, output);
      }
    } else if (node.type === 'folding') {
      collectInline(node.title);
      collectWikiLinkTargets(node.children, output);
    } else if (node.type === 'wiki_style') {
      collectWikiLinkTargets(node.children, output);
    } else if (node.type === 'conditional' && node.state === 'visible') {
      collectWikiLinkTargets(node.children, output);
    } else if (node.type === 'include' && node.children) {
      collectWikiLinkTargets(node.children, output);
    }
  }
  return output;
}

function renderInternalLink(
  target: string,
  label: string,
  options: RenderOptions = {},
  storedFragment?: string | null,
  labelHtml?: string,
) {
  const content = labelHtml ?? escapeHtml(label);
  const resolved = !target && storedFragment
    ? { target: '', fragment: storedFragment }
    : resolveWikiLinkTarget(target, options.linkResolution);
  if ('error' in resolved) return content;
  const resolvedTarget = resolved.target;
  const fragment = storedFragment ?? resolved.fragment;
  const fragmentId = fragment ? makeHeadingId(fragment) : '';
  if (!resolvedTarget) {
    return fragmentId
      ? `<a class="wiki-link" href="#${encodeURIComponent(fragmentId)}">${content}</a>`
      : content;
  }
  const parsed = parseLinkTarget(resolvedTarget);
  const missing = options.missingLinks?.has(wikiLinkKey(resolvedTarget));
  const className = missing ? 'wiki-link missing' : 'wiki-link';
  const titleAttr = missing ? ' title="문서 없음"' : '';
  const unqualified = parsed.namespace === 'main' && !resolvedTarget.includes(':');
  const href = unqualified && options.internalLinkBasePath
    ? `${options.internalLinkBasePath.replace(/\/$/, '')}/${slugifyTitle(parsed.title)
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`
    : wikiUrl(parsed.namespace, parsed.title);
  const fragmentSuffix = fragmentId ? `#${encodeURIComponent(fragmentId)}` : '';
  return `<a class="${className}" href="${escapeAttr(`${href}${fragmentSuffix}`)}"${titleAttr}>${content}</a>`;
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
  if (name === 'front_intro') return `<section class="front-wiki-component front-wiki-intro"><h2>${escapeHtml(props['제목'] ?? 'MineWiki')}</h2><p>${escapeHtml(props['설명'] ?? '')}</p></section>`;
  if (name === 'front_search') {
    const basePath = options.internalLinkBasePath?.replace(/\/$/u, '');
    const searchPath = basePath?.startsWith('/serverWiki/') ? `${basePath}/_search` : '/search';
    return `<section class="front-wiki-component front-wiki-search"><form class="search-page" action="${escapeAttr(searchPath)}" method="get" role="search" aria-label="위키 검색"><input class="search-page-input" type="search" name="q" placeholder="${escapeAttr(props['예시'] ?? '검색')}" aria-label="검색어" autocomplete="off"><button class="search-page-submit" type="submit">검색</button></form></section>`;
  }
  if (name === 'front_card') {
    const links = Object.entries(props)
      .filter(([key, value]) => /^링크\d+$/.test(key) && value)
      .map(([, value]) => renderSearchLink(value))
      .join(' · ');
    const target = props['대상'] ?? props['링크'] ?? '/wiki';
    const title = props['제목'] ?? '문서';
    const heading = isSafeLocalHref(target) ? `<a href="${escapeAttr(target)}">${escapeHtml(title)}</a>` : renderInternalLink(target, title, options);
    return `<section class="front-wiki-component front-wiki-card"><h2>${heading}</h2><p>${escapeHtml(props['설명'] ?? '')}</p>${links ? `<p class="front-wiki-card-links">${links}</p>` : ''}</section>`;
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
    return `<figure class="code-example"><figcaption>${escapeHtml(props['제목'] ?? '코드 예제')}${lang ? ` · ${escapeHtml(lang)}` : ''}</figcaption>${renderCodeBlock(props['코드'] ?? '', lang)}</figure>`;
  }
  if (name === 'warning_box') return `<aside class="warning"><strong>${escapeHtml(props['제목'] ?? '주의')}</strong><span>${escapeHtml(props['내용'] ?? '')}</span></aside>`;
  if (name === 'official_doc_link') return `<aside class="doc-status official-doc-link"><strong>공식 문서</strong><span>${renderExternalLink(props['URL'] ?? '', props['제목'] ?? props['URL'] ?? '공식 문서')}</span>${props['확인일'] ? `<small>${escapeHtml(formatComponentValue('확인일', props['확인일']))}</small>` : ''}</aside>`;
  if (name === 'dependency_info') return renderSimpleRows(props, props['열'] || '이름,범위,버전,비고', '의존성 정보');
  if (name === 'gradle_setup') return `<figure class="code-example"><figcaption>Gradle 설정</figcaption>${renderCodeBlock(props['내용'] ?? '', 'gradle')}</figure>`;
  if (name === 'maven_setup') return `<figure class="code-example"><figcaption>Maven 설정</figcaption>${renderCodeBlock(props['내용'] ?? '', 'xml')}</figure>`;
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

function renderFile(
  fileName: string,
  thumbnail: boolean,
  caption: string | null,
  rawDisplay: WikiFileDisplayOptions | undefined,
  options: RenderOptions,
  inline = false
) {
  const display = normalizeWikiFileDisplayOptions(rawDisplay);
  const alignmentClass = display.align ? ` wiki-file-align-${display.align}` : '';
  const themeClass = display.theme ? ` wiki-theme-${display.theme}` : '';
  const outerClass = `wiki-file${inline ? ' wiki-file-inline' : ''}${thumbnail ? ' thumb' : ''}${alignmentClass}${themeClass}`;
  const file = options.files?.[fileName];
  if (!file) {
    if (inline) {
      return `<span class="${outerClass} missing-file">파일 없음: ${escapeHtml(fileName)}</span>`;
    }
    return `<figure class="${outerClass} missing-file"><figcaption>파일 없음: ${escapeHtml(fileName)}</figcaption></figure>`;
  }
  const license = file.license ? `라이선스: ${wikiFileLicenseLabel(file.license)}` : '';
  const sourceLabel = file.sourceText?.trim() || '원본 출처';
  const source = file.sourceUrl
    ? `출처: ${renderExternalLink(file.sourceUrl, sourceLabel)}`
    : file.sourceText
      ? `출처: ${escapeHtml(file.sourceText)}`
      : '';
  const metaHtml = license || source ? `<small>${license ? escapeHtml(license) : ''}${license && source ? ' · ' : ''}${source}</small>` : '';
  const frameStyles = styleAttribute({
    width: display.width,
    height: display.height,
    'background-color': display.backgroundColor
  });
  const imageStyles = styleAttribute({
    width: display.width ? '100%' : undefined,
    height: display.height ? '100%' : undefined,
    'border-radius': display.borderRadius,
    'image-rendering': display.rendering,
    'object-fit': display.objectFit
  });
  const alt = display.alt ?? caption ?? file.originalName;
  if (file.mimeType === 'video/mp4' || file.mimeType === 'video/webm') {
    const videoStyles = styleAttribute({
      width: display.width ? '100%' : undefined,
      height: display.height ? '100%' : undefined,
      'border-radius': display.borderRadius,
      'object-fit': display.objectFit,
    });
    const video = `<video class="wiki-file-video" src="${escapeAttr(file.url)}" controls preload="metadata" playsinline aria-label="${escapeAttr(alt)}"${videoStyles}></video>`;
    const videoHtml = `<span class="wiki-file-frame"${frameStyles}>${video}</span>`;
    if (inline) {
      return `<span class="${outerClass}">${videoHtml}${caption ? `<span>${escapeHtml(caption)}</span>` : ''}${metaHtml}</span>`;
    }
    return `<figure class="${outerClass}">${videoHtml}${caption ? `<figcaption>${escapeHtml(caption)}${metaHtml}</figcaption>` : metaHtml}</figure>`;
  }
  const image = `<img class="wiki-file-image" src="${escapeAttr(file.url)}" alt="${escapeAttr(alt)}" loading="lazy"${imageStyles}>`;
  const imageHtml = Number.isFinite(file.sizeBytes) && file.sizeBytes! >= 2 * 1024 * 1024
    ? `<span class="wiki-file-frame wiki-file-deferred"${frameStyles}><button type="button" class="wiki-file-load" data-wiki-file-src="${escapeAttr(file.url)}" data-wiki-file-alt="${escapeAttr(alt)}"${imageStyles}>이미지 불러오기 <small>${escapeHtml(formatFileSize(file.sizeBytes!))}</small></button><noscript><a href="${escapeAttr(file.url)}">이미지 열기 (${escapeHtml(formatFileSize(file.sizeBytes!))})</a></noscript></span>`
    : `<span class="wiki-file-frame"${frameStyles}>${image}</span>`;
  if (inline) {
    return `<span class="${outerClass}">${imageHtml}${caption ? `<span>${escapeHtml(caption)}</span>` : ''}${metaHtml}</span>`;
  }
  return `<figure class="${outerClass}">${imageHtml}${caption ? `<figcaption>${escapeHtml(caption)}${metaHtml}</figcaption>` : metaHtml}</figure>`;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KiB`;
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
  const head = headers.length ? `<thead><tr>${headers.map((header) => `<th>${renderComponentInline(header, options)}</th>`).join('')}</tr></thead>` : '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${renderComponentInline(cell, options)}</td>`).join('')}</tr>`).join('')
    : '<tr><td>등록된 데이터가 없습니다.</td></tr>';
  return wrapTable(`<table class="component-table data-table" data-table-key="${escapeAttr(key)}"><caption>${escapeHtml(caption)}</caption>${head}<tbody>${body}</tbody></table>`);
}

function collectComponentInlineMetadata(
  name: string,
  props: Record<string, string>,
  links: Set<string>,
  errors: string[],
  blockingErrors: string[],
  footnotes: string[],
  linkResolution?: WikiLinkResolutionContext
) {
  if (name !== 'data_table') return;
  for (const [key, value] of Object.entries(props)) {
    if (key !== '열' && !/^행\d+$/u.test(key)) continue;
    for (const cell of splitCells(value)) {
      parseInline(cell, links, errors, blockingErrors, footnotes, linkResolution);
    }
  }
}

function renderComponentInline(value: string, options: RenderOptions) {
  const nodes = parseInline(value, new Set(), [], [], [], options.linkResolution);
  return renderInline(nodes, { entries: [], namedIndexes: new Map(), definitions: new Map() }, options);
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

function renderWikiList(node: WikiListNode, footnotes: FootnoteRenderState, options: RenderOptions): string {
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
  rows: WikiTableRow[],
  tableOptions: WikiTableOptions,
  footnotes: FootnoteRenderState,
  options: RenderOptions,
  renderBlocks: (nodes: readonly AstNode[]) => string,
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
  const hasExplicitHeaders = rows.some((row) => row.cells.some((cell) => cell.header));
  let bodyStarted = false;
  const renderedRows = rows.map((row, rowIndex) => {
    const requestedHeader = row.cells.some((cell) => cell.header);
    const isHeader = hasExplicitHeaders ? requestedHeader && !bodyStarted : rowIndex === 0;
    if (!isHeader) bodyStarted = true;
    const rowStyles = styleAttribute({
      color: row.color,
      'background-color': row.backgroundColor,
      '--wiki-dark-color': row.darkColor,
      '--wiki-dark-background-color': row.darkBackgroundColor,
      'word-break': row.keepAll ? 'keep-all' : undefined
    });
    let visualColumn = 0;
    return {
      isHeader,
      html: `<tr${rowStyles}>${row.cells
      .map((cell) => {
        const cellVisualColumn = visualColumn;
        visualColumn += cell.colspan;
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
          'vertical-align': cell.verticalAlign,
          padding: cell.noPadding ? '0' : undefined,
          'word-break': cell.keepAll ? 'keep-all' : undefined
        });
        const renderedContent = cell.blocks ? renderBlocks(cell.blocks) : renderInline(cell.children, footnotes, options);
        const content = isHeader && cell.sortable && cell.colspan === 1 && cell.rowspan === 1 && isPlainSortableCell(cell)
          ? `<button class="wiki-table-sort-button" type="button" data-wiki-sort-column="${cellVisualColumn}">${renderedContent}<span class="wiki-table-sort-indicator" aria-hidden="true">↕</span></button>`
          : renderedContent;
        return `<${tag}${colspan}${rowspan}${styles}>${content}</${tag}>`;
      })
      .join('')}</tr>`
    };
  });
  const headRows = renderedRows.filter((row) => row.isHeader).map((row) => row.html).join('');
  const bodyRows = renderedRows.filter((row) => !row.isHeader).map((row) => row.html).join('');
  const captionHtml = caption.length > 0
    ? `<caption class="wiki-table-caption">${renderInline(caption, footnotes, options)}</caption>`
    : '';
  const tableClass = tableOptions.headerHidden
    ? 'component-table wiki-table wiki-table-header-hidden'
    : 'component-table wiki-table';
  const html = `<table class="${tableClass}"${tableStyles}>${captionHtml}${headRows ? `<thead>${headRows}</thead>` : ''}${bodyRows ? `<tbody>${bodyRows}</tbody>` : ''}</table>`;
  return `<div class="${wrapperClass}"${wrapperStyles}>${html}</div>`;
}

function isPlainSortableCell(cell: WikiTableCell): boolean {
  return !cell.blocks && cell.children.every((node) => node.type === 'text' || node.type === 'code');
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

function readWikiTableLogicalRow(lines: readonly string[], startIndex: number): {
  source: string;
  endIndex: number;
  closed: boolean;
} {
  const collected: string[] = [];
  let tripleBraceDepth = 0;
  let endIndex = startIndex;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    collected.push(line);
    tripleBraceDepth = scanTripleBraceDepth(line, tripleBraceDepth);
    endIndex = index;
    if (tripleBraceDepth === 0 && line.trimEnd().endsWith('||')) {
      return { source: collected.join('\n'), endIndex, closed: true };
    }
  }
  return { source: collected.join('\n'), endIndex, closed: false };
}

function splitWikiTableRow(line: string): string[] {
  const source = line.trimStart();
  let index = source.startsWith('||') ? 2 : 0;
  let tripleBraceDepth = 0;
  let cell = '';
  const cells: string[] = [];
  while (index < source.length) {
    const marker = source.slice(index, index + 3);
    if (!isEscapedAt(source, index) && marker === '{{{') {
      tripleBraceDepth += 1;
      cell += marker;
      index += 3;
      continue;
    }
    if (!isEscapedAt(source, index) && marker === '}}}' && tripleBraceDepth > 0) {
      tripleBraceDepth -= 1;
      cell += marker;
      index += 3;
      continue;
    }
    if (tripleBraceDepth === 0 && source.slice(index, index + 2) === '||') {
      cells.push(cell);
      cell = '';
      index += 2;
      continue;
    }
    cell += source[index] ?? '';
    index += 1;
  }
  if (cell.length > 0) cells.push(cell);
  return cells;
}

function scanTripleBraceDepth(line: string, initialDepth: number): number {
  let depth = initialDepth;
  for (let index = 0; index <= line.length - 3; index += 1) {
    if (isEscapedAt(line, index)) continue;
    const marker = line.slice(index, index + 3);
    if (marker === '{{{') {
      depth += 1;
      index += 2;
    } else if (marker === '}}}' && depth > 0) {
      depth -= 1;
      index += 2;
    }
  }
  return depth;
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

function renderCodeBlock(code: string, requestedLanguage: string | null): string {
  const rawLanguage = requestedLanguage?.trim().toLocaleLowerCase('en-US') ?? '';
  const language = codeLanguageAliases[rawLanguage] ?? rawLanguage;
  const dataLanguage = escapeAttr(rawLanguage);
  if (!language || code.length > MAX_HIGHLIGHT_CODE_LENGTH || !hljs.getLanguage(language)) {
    return `<pre class="codeblock" data-lang="${dataLanguage}"><code>${escapeHtml(code)}</code></pre>`;
  }
  try {
    const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    return `<pre class="codeblock" data-lang="${dataLanguage}"><code class="hljs language-${escapeAttr(language)}">${highlighted}</code></pre>`;
  } catch {
    return `<pre class="codeblock" data-lang="${dataLanguage}"><code>${escapeHtml(code)}</code></pre>`;
  }
}
