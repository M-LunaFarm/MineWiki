'use client';

import { GitMerge } from 'lucide-react';
import {
  parseWikiConflictDocument,
  resolveAllWikiConflicts,
  resolveWikiConflict,
} from '../../lib/wiki-conflict-resolution.mjs';

export function WikiConflictResolver({ contentRaw, onChange }: {
  readonly contentRaw: string;
  readonly onChange: (contentRaw: string) => void;
}) {
  const conflicts = parseWikiConflictDocument(contentRaw);
  if (conflicts.length === 0) return null;
  return <section className="space-y-3 rounded-lg border border-amber-300/30 bg-amber-500/[0.06] p-3" aria-labelledby="wiki-conflict-resolver-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="wiki-conflict-resolver-title" className="flex items-center gap-2 text-sm font-semibold text-amber-50"><GitMerge className="size-4" /> 시각적 충돌 해결</h3>
        <p className="mt-1 text-xs leading-5 text-amber-100/70">각 덩어리에서 유지할 내용을 선택하세요. 아래 원문에서 최종 결과를 다시 편집할 수 있습니다.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <ResolverButton onClick={() => onChange(resolveAllWikiConflicts(contentRaw, 'local'))}>모두 내 편집</ResolverButton>
        <ResolverButton onClick={() => onChange(resolveAllWikiConflicts(contentRaw, 'current'))}>모두 최신 판</ResolverButton>
      </div>
    </div>
    {conflicts.map((conflict) => <article key={`${conflict.startLine}-${conflict.endLine}`} className="overflow-hidden rounded-md border border-white/10 bg-[#0d141d]">
      <header className="border-b border-white/10 px-3 py-2 text-xs font-semibold text-slate-300">충돌 {conflict.index + 1} / {conflicts.length}</header>
      <div className="grid lg:grid-cols-3">
        <ConflictSource label="내 편집" value={conflict.local} tone="text-emerald-100" />
        <ConflictSource label="기준 판" value={conflict.base} tone="text-slate-300" />
        <ConflictSource label="최신 판" value={conflict.current} tone="text-blue-100" />
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-white/10 p-3">
        <ResolverButton accent onClick={() => onChange(resolveWikiConflict(contentRaw, conflict.index, 'local'))}>내 편집 유지</ResolverButton>
        <ResolverButton onClick={() => onChange(resolveWikiConflict(contentRaw, conflict.index, 'current'))}>최신 판 유지</ResolverButton>
        <ResolverButton onClick={() => onChange(resolveWikiConflict(contentRaw, conflict.index, 'both'))}>둘 다 유지</ResolverButton>
        <ResolverButton onClick={() => onChange(resolveWikiConflict(contentRaw, conflict.index, 'base'))}>기준 판 복원</ResolverButton>
      </footer>
    </article>)}
  </section>;
}

function ConflictSource({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone: string }) {
  return <section className="min-w-0 border-b border-white/10 p-3 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
    <h4 className={`text-xs font-semibold ${tone}`}>{label}</h4>
    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words bg-transparent p-0 text-xs leading-5 text-slate-300">{value || '(빈 내용)'}</pre>
  </section>;
}

function ResolverButton({ children, onClick, accent = false }: {
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly accent?: boolean;
}) {
  return <button type="button" onClick={onClick} className={`chip min-h-10 ${accent ? 'chip-accent' : 'chip-muted'}`}>{children}</button>;
}
