'use client';

import { Search, X } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import type { AuditEventFilters } from '../../lib/audit-api';

const CATEGORIES = ['account', 'auth', 'wiki', 'wiki_profile', 'file', 'server', 'review', 'vote', 'minecraft', 'plugin.sync', 'discord.verify', 'guild', 'billing', 'admin'];

export function AuditEventFilterForm({ value, working, onChange, onSubmit, onReset }: {
  readonly value: AuditEventFilters;
  readonly working: boolean;
  readonly onChange: (value: AuditEventFilters) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onReset: () => void;
}) {
  const update = (key: keyof AuditEventFilters, next: string) => onChange({ ...value, [key]: next });
  return <form onSubmit={onSubmit} className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <Field label="카테고리"><input list="audit-categories" value={value.category ?? ''} onChange={(event) => update('category', event.target.value)} placeholder="account" className={inputClass} /><datalist id="audit-categories">{CATEGORIES.map((item) => <option key={item} value={item} />)}</datalist></Field>
    <Field label="동작 포함"><input value={value.action ?? ''} onChange={(event) => update('action', event.target.value)} placeholder="contact_email" className={inputClass} /></Field>
    <Field label="심각도"><select value={value.severity ?? ''} onChange={(event) => update('severity', event.target.value)} className={inputClass}><option value="">전체</option><option value="info">info</option><option value="warning">warning</option><option value="error">error</option><option value="critical">critical</option></select></Field>
    <Field label="작업 계정 ID"><input value={value.actorAccountId ?? ''} onChange={(event) => update('actorAccountId', event.target.value)} placeholder="UUID" className={inputClass} /></Field>
    <Field label="대상 종류"><input value={value.subjectType ?? ''} onChange={(event) => update('subjectType', event.target.value)} placeholder="account" className={inputClass} /></Field>
    <Field label="대상 ID"><input value={value.subjectId ?? ''} onChange={(event) => update('subjectId', event.target.value)} placeholder="대상 식별자" className={inputClass} /></Field>
    <Field label="요청 ID"><input value={value.requestId ?? ''} onChange={(event) => update('requestId', event.target.value)} placeholder="요청 추적 ID" className={inputClass} /></Field>
    <div className="flex items-end gap-2">
      <button type="submit" disabled={working} className="btn-primary min-h-11 flex-1 gap-2"><Search className="size-4" />검색</button>
      <button type="button" onClick={onReset} disabled={working} className="btn-secondary min-h-11 gap-2"><X className="size-4" />초기화</button>
    </div>
  </form>;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label className="text-xs font-semibold text-slate-400">{label}<span className="mt-1.5 block">{children}</span></label>;
}

const inputClass = 'min-h-11 w-full rounded-md border border-white/10 bg-[#15171b] px-3 text-sm font-normal text-white outline-none focus:border-emerald-300';
