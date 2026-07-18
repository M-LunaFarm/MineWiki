export type NamespaceCode =
  | 'main'
  | 'mod'
  | 'modpack'
  | 'server'
  | 'dev'
  | 'guide'
  | 'data'
  | 'help'
  | 'project'
  | 'template'
  | 'user'
  | 'category'
  | 'file';

export type WikiListKind =
  | 'unordered'
  | 'decimal'
  | 'lower-alpha'
  | 'upper-alpha'
  | 'lower-roman'
  | 'upper-roman';

export interface WikiListItem {
  children: InlineNode[];
  nested: WikiListNode[];
}

export interface WikiListNode {
  type: 'list';
  kind: WikiListKind;
  start: number;
  items: WikiListItem[];
}

export interface WikiTableCell {
  children: InlineNode[];
  colspan: number;
  rowspan: number;
  header?: boolean;
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  width?: string;
  height?: string;
  backgroundColor?: string;
  darkBackgroundColor?: string;
  color?: string;
  darkColor?: string;
}

export interface WikiTableRow {
  cells: WikiTableCell[];
  backgroundColor?: string;
  darkBackgroundColor?: string;
  color?: string;
  darkColor?: string;
}

export interface WikiTableOptions {
  align?: 'left' | 'center' | 'right';
  width?: string;
  headerHidden?: boolean;
  backgroundColor?: string;
  darkBackgroundColor?: string;
  color?: string;
  darkColor?: string;
  borderColor?: string;
  darkBorderColor?: string;
}

export interface WikiFileDisplayOptions {
  width?: string;
  height?: string;
  align?: string;
  backgroundColor?: string;
  borderRadius?: string;
  rendering?: string;
  objectFit?: string;
  theme?: string;
  alt?: string;
}

export interface WikiStyleProperties {
  color?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  border?: string;
  borderColor?: string;
  borderRadius?: string;
  padding?: string;
  margin?: string;
  width?: string;
  maxWidth?: string;
}

export type AstNode =
  | { type: 'heading'; level: number; text: string; id: string; legacyId?: string; folded?: boolean; startLine?: number; endLine?: number }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'indent'; children: AstNode[] }
  | WikiListNode
  | { type: 'blockquote'; children: AstNode[] }
  | { type: 'hr' }
  | { type: 'wiki_table'; caption: InlineNode[]; rows: WikiTableRow[]; options: WikiTableOptions }
  | { type: 'folding'; title: InlineNode[]; children: AstNode[] }
  | {
      type: 'wiki_style';
      writingMode: 'horizontal-tb' | 'vertical-rl' | 'vertical-lr' | null;
      style?: WikiStyleProperties;
      darkStyle?: Pick<WikiStyleProperties, 'color' | 'backgroundColor' | 'borderColor'>;
      children: AstNode[];
    }
  | { type: 'toc'; collapsed: boolean }
  | {
      type: 'include';
      target: string;
      params: Record<string, string>;
      state: 'unresolved' | 'resolved' | 'unavailable';
      children?: AstNode[];
    }
  | { type: 'component'; name: string; props: Record<string, string> }
  | { type: 'category'; title: string }
  | { type: 'file'; fileName: string; thumbnail: boolean; caption: string | null; display?: WikiFileDisplayOptions }
  | { type: 'redirect'; target: string }
  | { type: 'math_block'; source: string; error: string | null }
  | { type: 'codeblock'; lang: string | null; code: string };

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'line_break' }
  | { type: 'clearfix' }
  | { type: 'anchor'; id: string }
  | { type: 'ruby'; text: string; ruby: string; color: string | null }
  | { type: 'dynamic_time'; mode: 'datetime' | 'age' | 'dday'; date: string | null }
  | { type: 'dynamic_stat'; stat: 'pagecount'; namespace: string | null }
  | {
      type: 'video';
      provider: 'youtube' | 'navertv' | 'nicovideo';
      videoId: string;
      width: number;
      height: number;
      start: number | null;
      end: number | null;
    }
  | { type: 'math'; source: string; error: string | null }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'underline'; children: InlineNode[] }
  | { type: 'sup'; children: InlineNode[] }
  | { type: 'sub'; children: InlineNode[] }
  | { type: 'color'; color: string; children: InlineNode[] }
  | { type: 'size'; delta: number; children: InlineNode[] }
  | { type: 'internal_link'; target: string; label: string; fragment?: string | null }
  | { type: 'external_link'; href: string; label: string }
  | { type: 'file'; fileName: string; thumbnail: boolean; caption: string | null; display?: WikiFileDisplayOptions }
  | { type: 'unsupported_macro'; name: string }
  | { type: 'code'; code: string }
  | { type: 'ref'; name: string | null; text: string | null };

export interface ParsedDocument {
  ast: AstNode[];
  links: string[];
  categories: string[];
  includes: string[];
  components: Array<{ name: string; props: Record<string, string> }>;
  headings: Array<{ level: number; title: string; anchor: string; startLine: number; endLine: number }>;
  footnotes: string[];
  redirectTarget: string | null;
  plainText: string;
  errors: string[];
  blockingErrors: string[];
}
