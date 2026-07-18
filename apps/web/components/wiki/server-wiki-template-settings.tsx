'use client';

import { Archive, Eye, FilePlus2, Loader2, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { previewWikiMarkup } from '../../lib/wiki-api';

interface WikiTemplate {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly defaultCategory: string | null;
  readonly contentRaw: string;
  readonly version: number;
  readonly updatedAt: string;
}

interface TemplateForm {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly defaultCategory: string;
  readonly contentRaw: string;
}

const EMPTY_FORM: TemplateForm = { key: '', title: '', description: '', defaultCategory: '', contentRaw: '' };

export function ServerWikiTemplateSettings({ serverId }: { readonly serverId: string }) {
  const baseUrl = normalizeApiBaseUrl();
  const [items, setItems] = useState<WikiTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [message, setMessage] = useState<{ readonly tone: 'error' | 'success'; readonly text: string } | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const normalized = normalize(form);
  const dirty = selected ? JSON.stringify(normalized) !== JSON.stringify(toForm(selected)) : Object.values(normalized).some(Boolean);
  const valid = /^[a-z0-9][a-z0-9_-]{1,63}$/u.test(normalized.key) && Boolean(normalized.title && normalized.contentRaw);
  const contentBytes = useMemo(() => new TextEncoder().encode(form.contentRaw).byteLength, [form.contentRaw]);

  async function load(preferredId?: string | null) {
    setLoading(true); setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-templates`, { credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => []);
      if (!response.ok) throw new Error(body.message ?? '문서 양식을 불러오지 못했습니다.');
      const next = body as WikiTemplate[];
      setItems(next);
      const nextSelected = next.find((item) => item.id === preferredId) ?? next[0] ?? null;
      setSelectedId(nextSelected?.id ?? null);
      setForm(nextSelected ? toForm(nextSelected) : EMPTY_FORM);
      setPreviewHtml('');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '문서 양식을 불러오지 못했습니다.' });
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [baseUrl, serverId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function select(item: WikiTemplate) {
    if (dirty && !window.confirm('저장하지 않은 양식 변경을 버릴까요?')) return;
    setSelectedId(item.id); setForm(toForm(item)); setPreviewHtml(''); setMessage(null);
  }

  function createNew() {
    if (dirty && !window.confirm('저장하지 않은 양식 변경을 버릴까요?')) return;
    setSelectedId(null); setForm(EMPTY_FORM); setPreviewHtml(''); setMessage(null);
  }

  async function save() {
    if (!valid || contentBytes > 256 * 1024 || saving) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-templates${selected ? `/${selected.id}` : ''}`, {
        method: selected ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ ...normalized, ...(selected ? { expectedVersion: selected.version } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '문서 양식을 저장하지 못했습니다.');
      await load(String(body.id));
      setMessage({ tone: 'success', text: selected ? '문서 양식을 수정했습니다.' : '문서 양식을 만들었습니다. 새 문서 편집기에 즉시 표시됩니다.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '문서 양식을 저장하지 못했습니다.' });
    } finally { setSaving(false); }
  }

  async function archive() {
    if (!selected || saving || !window.confirm(`“${selected.title}” 양식을 보관할까요? 새 문서에서는 더 이상 보이지 않습니다.`)) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-templates/${selected.id}?expectedVersion=${selected.version}`, {
        method: 'DELETE', credentials: 'include', headers: await csrfHeaders(),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '문서 양식을 보관하지 못했습니다.');
      await load();
      setMessage({ tone: 'success', text: '문서 양식을 보관했습니다.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '문서 양식을 보관하지 못했습니다.' });
    } finally { setSaving(false); }
  }

  async function preview() {
    if (!form.contentRaw.trim() || previewing) return;
    setPreviewing(true); setMessage(null);
    try {
      const result = await previewWikiMarkup(form.contentRaw, { namespace: 'server', localPath: 'template-preview' });
      setPreviewHtml(result.html);
      if (result.blockingErrors.length > 0) setMessage({ tone: 'error', text: result.blockingErrors.join('\n') });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '양식 미리보기를 만들지 못했습니다.' });
    } finally { setPreviewing(false); }
  }

  if (loading) return <div className="flex min-h-[35vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;

  return <section className="space-y-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-lg font-bold text-white">문서 시작 양식</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">반복되는 규칙·공지·가이드 구조를 저장해 새 서버 위키 문서에서 바로 적용합니다.</p></div><button type="button" onClick={createNew} className="btn-secondary min-h-11 shrink-0"><FilePlus2 className="size-4" />새 양식</button></div>
    {message ? <div role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${message.tone === 'error' ? 'border-red-300/25 bg-red-500/10 text-red-100' : 'border-emerald-300/25 bg-emerald-500/10 text-emerald-100'}`}>{message.text}</div> : null}
    <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <nav className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3" aria-label="서버 위키 문서 양식">
        {items.map((item) => <button key={item.id} type="button" onClick={() => select(item)} aria-current={item.id === selectedId ? 'true' : undefined} className={`w-full rounded-lg border px-3 py-3 text-left ${item.id === selectedId ? 'border-emerald-300/35 bg-emerald-400/10' : 'border-transparent hover:border-white/10 hover:bg-white/[0.03]'}`}><strong className="block text-sm text-white">{item.title}</strong><span className="mt-1 block truncate font-mono text-[11px] text-slate-500">{item.key} · v{item.version}</span></button>)}
        {items.length === 0 ? <p className="px-2 py-6 text-center text-sm text-slate-500">아직 만든 양식이 없습니다.</p> : null}
      </nav>
      <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2"><Field label="양식 키" hint="영문 소문자·숫자·밑줄·하이픈" value={form.key} onChange={(key) => setForm((current) => ({ ...current, key: key.toLowerCase() }))} /><Field label="양식 이름" value={form.title} onChange={(title) => setForm((current) => ({ ...current, title }))} /><Field label="설명" value={form.description} onChange={(description) => setForm((current) => ({ ...current, description }))} /><Field label="기본 분류" hint="선택 사항" value={form.defaultCategory} onChange={(defaultCategory) => setForm((current) => ({ ...current, defaultCategory }))} /></div>
        <label className="block"><span className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-300"><span>양식 본문</span><span className={contentBytes > 256 * 1024 ? 'text-red-300' : 'text-slate-500'}>{contentBytes.toLocaleString()} / 262,144 bytes</span></span><textarea value={form.contentRaw} onChange={(event) => setForm((current) => ({ ...current, contentRaw: event.target.value }))} className="mt-2 min-h-80 w-full resize-y rounded-lg border border-white/10 bg-[#0d1219] p-3 font-mono text-sm leading-6 text-slate-100 outline-none focus:border-emerald-300/50" spellCheck={false} placeholder={'== 개요 ==\n문서 내용을 입력하세요.\n\n[[분류:서버 안내]]'} /></label>
        <div className="flex flex-wrap justify-between gap-3"><button type="button" onClick={() => void archive()} disabled={!selected || saving} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-300/20 px-4 text-sm font-semibold text-red-200 disabled:opacity-40"><Archive className="size-4" />양식 보관</button><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void preview()} disabled={!form.contentRaw.trim() || previewing} className="btn-secondary min-h-11">{previewing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}미리보기</button><button type="button" onClick={() => void save()} disabled={!dirty || !valid || contentBytes > 256 * 1024 || saving} className="btn-primary min-h-11 min-w-32 disabled:opacity-40">{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}저장</button></div></div>
        {previewHtml ? <div><h3 className="mb-2 text-xs font-semibold text-slate-300">미리보기</h3><div className="wiki-rendered max-h-[32rem] overflow-auto rounded-lg border border-white/10 bg-[#0d1219] p-4" dangerouslySetInnerHTML={{ __html: previewHtml }} /></div> : null}
      </div>
    </div>
  </section>;
}

function Field({ label, hint, value, onChange }: { readonly label: string; readonly hint?: string; readonly value: string; readonly onChange: (value: string) => void }) {
  return <label className="block"><span className="text-xs font-semibold text-slate-300">{label}{hint ? <span className="ml-2 font-normal text-slate-500">{hint}</span> : null}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white outline-none focus:border-emerald-300/50" /></label>;
}

function toForm(item: WikiTemplate): TemplateForm { return { key: item.key, title: item.title, description: item.description ?? '', defaultCategory: item.defaultCategory ?? '', contentRaw: item.contentRaw }; }
function normalize(form: TemplateForm): TemplateForm { return { key: form.key.trim().toLowerCase(), title: form.title.trim(), description: form.description.trim(), defaultCategory: form.defaultCategory.trim(), contentRaw: form.contentRaw.replaceAll('\r\n', '\n').trim() }; }
