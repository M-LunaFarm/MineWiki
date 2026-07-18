'use client';

import type { ReactNode } from 'react';
import {
  Bold,
  Braces,
  Code2,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  MessageSquareQuote,
  NotebookTabs,
  Quote,
  Table2,
} from 'lucide-react';

export type WikiEditorFormatAction =
  | 'heading2'
  | 'heading3'
  | 'bold'
  | 'italic'
  | 'link'
  | 'unordered-list'
  | 'ordered-list'
  | 'quote'
  | 'code-block'
  | 'table'
  | 'callout'
  | 'footnote'
  | 'include';

export function WikiEditorToolbar({
  disabled,
  onApply,
}: {
  readonly disabled: boolean;
  readonly onApply: (action: WikiEditorFormatAction) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#0d1219] p-2" role="toolbar" aria-label="위키 본문 서식">
      <div className="flex min-w-max items-center gap-1.5">
        <FormatButton action="heading2" label="큰 제목" shortcut="H2" disabled={disabled} onApply={onApply}><Heading2 className="size-4" /></FormatButton>
        <FormatButton action="heading3" label="작은 제목" shortcut="H3" disabled={disabled} onApply={onApply}><Heading3 className="size-4" /></FormatButton>
        <Separator />
        <FormatButton action="bold" label="굵게" shortcut="Ctrl+B" disabled={disabled} onApply={onApply}><Bold className="size-4" /></FormatButton>
        <FormatButton action="italic" label="기울임" shortcut="Ctrl+I" disabled={disabled} onApply={onApply}><Italic className="size-4" /></FormatButton>
        <FormatButton action="link" label="문서 링크" shortcut="Ctrl+K" disabled={disabled} onApply={onApply}><LinkIcon className="size-4" /></FormatButton>
        <Separator />
        <FormatButton action="unordered-list" label="글머리 목록" disabled={disabled} onApply={onApply}><List className="size-4" /></FormatButton>
        <FormatButton action="ordered-list" label="번호 목록" disabled={disabled} onApply={onApply}><ListOrdered className="size-4" /></FormatButton>
        <FormatButton action="quote" label="인용" disabled={disabled} onApply={onApply}><Quote className="size-4" /></FormatButton>
        <FormatButton action="code-block" label="코드 블록" disabled={disabled} onApply={onApply}><Code2 className="size-4" /></FormatButton>
        <FormatButton action="table" label="표" disabled={disabled} onApply={onApply}><Table2 className="size-4" /></FormatButton>
        <Separator />
        <FormatButton action="callout" label="안내 상자" disabled={disabled} onApply={onApply}><MessageSquareQuote className="size-4" /></FormatButton>
        <FormatButton action="footnote" label="각주" disabled={disabled} onApply={onApply}><NotebookTabs className="size-4" /></FormatButton>
        <FormatButton action="include" label="틀 포함" disabled={disabled} onApply={onApply}><Braces className="size-4" /></FormatButton>
      </div>
    </div>
  );
}

function FormatButton({
  action,
  children,
  disabled,
  label,
  shortcut,
  onApply,
}: {
  readonly action: WikiEditorFormatAction;
  readonly children: ReactNode;
  readonly disabled: boolean;
  readonly label: string;
  readonly shortcut?: string;
  readonly onApply: (action: WikiEditorFormatAction) => void;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onApply(action)}
      aria-label={title}
      title={title}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-transparent px-2.5 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:bg-emerald-300/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function Separator() {
  return <span className="mx-0.5 h-6 w-px bg-white/10" aria-hidden="true" />;
}
