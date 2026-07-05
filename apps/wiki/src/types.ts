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
  | 'file';

export type AstNode =
  | { type: 'heading'; level: number; text: string; id: string; startLine?: number; endLine?: number }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'list'; items: InlineNode[][] }
  | { type: 'blockquote'; children: InlineNode[] }
  | { type: 'hr' }
  | { type: 'wiki_table'; rows: InlineNode[][][] }
  | { type: 'folding'; title: InlineNode[]; children: AstNode[] }
  | { type: 'component'; name: string; props: Record<string, string> }
  | { type: 'category'; title: string }
  | { type: 'file'; fileName: string; thumbnail: boolean; caption: string | null }
  | { type: 'redirect'; target: string }
  | { type: 'codeblock'; lang: string | null; code: string };

export type InlineNode =
  | { type: 'text'; text: string }
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
  | { type: 'code'; code: string }
  | { type: 'ref'; text: string };

export interface ParsedDocument {
  ast: AstNode[];
  links: string[];
  categories: string[];
  components: Array<{ name: string; props: Record<string, string> }>;
  headings: Array<{ level: number; title: string; anchor: string; startLine: number; endLine: number }>;
  footnotes: string[];
  redirectTarget: string | null;
  plainText: string;
  errors: string[];
  blockingErrors: string[];
}
