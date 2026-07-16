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
  backgroundColor?: string;
  darkBackgroundColor?: string;
  color?: string;
  darkColor?: string;
  borderColor?: string;
  darkBorderColor?: string;
}

export type AstNode =
  | { type: 'heading'; level: number; text: string; id: string; folded?: boolean; startLine?: number; endLine?: number }
  | { type: 'paragraph'; children: InlineNode[] }
  | WikiListNode
  | { type: 'blockquote'; children: InlineNode[] }
  | { type: 'hr' }
  | { type: 'wiki_table'; caption: InlineNode[]; rows: WikiTableRow[]; options: WikiTableOptions }
  | { type: 'folding'; title: InlineNode[]; children: AstNode[] }
  | {
      type: 'wiki_style';
      writingMode: 'horizontal-tb' | 'vertical-rl' | 'vertical-lr' | null;
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
  | { type: 'file'; fileName: string; thumbnail: boolean; caption: string | null }
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
  | { type: 'video'; provider: 'youtube'; videoId: string; width: number; height: number; start: number | null; end: number | null }
  | { type: 'math'; source: string; error: string | null }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'strike'; text: string }
  | { type: 'underline'; text: string }
  | { type: 'sup'; text: string }
  | { type: 'sub'; text: string }
  | { type: 'color'; color: string; text: string }
  | { type: 'size'; delta: number; text: string }
  | { type: 'internal_link'; target: string; label: string }
  | { type: 'external_link'; href: string; label: string }
  | { type: 'file'; fileName: string; thumbnail: boolean; caption: string | null }
  | { type: 'unsupported_macro'; name: string }
  | { type: 'code'; code: string }
  | { type: 'ref'; text: string };

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
