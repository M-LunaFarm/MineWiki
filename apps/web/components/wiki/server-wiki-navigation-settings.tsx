'use client';

import { AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ExternalLink, FileText, Folder, FolderPlus, Loader2, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import {
  addServerWikiGroup,
  emptyServerWikiGroupIds,
  indentServerWikiNode,
  moveServerWikiNode,
  outdentServerWikiNode,
  removeServerWikiGroup,
  renameServerWikiGroup,
  serverWikiNodeControls,
  serverWikiNodeDepth,
} from '../../lib/server-wiki-navigation-editor.mjs';

type NavigationNode =
  | { readonly id: string; readonly kind: 'group'; readonly title: string; readonly parentId: string | null }
  | { readonly id: string; readonly kind: 'page'; readonly pageId: string; readonly parentId: string | null };

interface NavigationItem {
  readonly id: string;
  readonly kind: 'group' | 'page';
  readonly title: string;
  readonly path?: string;
  readonly status?: string;
}

interface NavigationSettings {
  readonly version: number;
  readonly document: { readonly version: 1; readonly nodes: readonly NavigationNode[] };
  readonly items: readonly NavigationItem[];
}

export function ServerWikiNavigationSettings({ serverId }: { readonly serverId: string }) {
  const baseUrl = normalizeApiBaseUrl();
  const [settings, setSettings] = useState<NavigationSettings | null>(null);
  const [nodes, setNodes] = useState<NavigationNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const itemById = useMemo(() => new Map(settings?.items.map((item) => [item.id, item]) ?? []), [settings]);
  const rootId = settings?.document.nodes.find((node) => node.kind === 'page' && node.parentId === null)?.id ?? '';
  const emptyGroups = useMemo(() => emptyServerWikiGroupIds(nodes), [nodes]);
  const dirty = settings ? JSON.stringify(nodes) !== JSON.stringify(settings.document.nodes) : false;

  const load = async () => {
    setLoading(true); setError(null); setNotice(null); setConflictVersion(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-navigation`, { credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '문서 구조를 불러오지 못했습니다.');
      const next = body as NavigationSettings;
      setSettings(next); setNodes([...next.document.nodes]);
    } catch (value) {
      setError(value instanceof Error ? value.message : '문서 구조를 불러오지 못했습니다.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [baseUrl, serverId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function addGroup() {
    const id = `group:${crypto.randomUUID()}`;
    setNodes((current) => addServerWikiGroup(current, id, '새 그룹'));
    setNotice(null);
  }

  async function save() {
    if (!settings || !dirty || emptyGroups.length > 0 || saving) return;
    setSaving(true); setError(null); setNotice(null); setConflictVersion(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-navigation`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: settings.version, document: { version: 1, nodes } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.code === 'SERVER_WIKI_NAVIGATION_CONFLICT') setConflictVersion(Number(body.currentVersion));
        throw new Error(body.message ?? '문서 구조를 저장하지 못했습니다.');
      }
      const next = body as NavigationSettings;
      setSettings(next); setNodes([...next.document.nodes]); setNotice('문서 구조를 저장했습니다. 공개 서버 위키에 즉시 반영됩니다.');
    } catch (value) {
      setError(value instanceof Error ? value.message : '문서 구조를 저장하지 못했습니다.');
    } finally { setSaving(false); }
  }

  if (loading) return <div className="flex min-h-[35vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" aria-label="문서 구조 불러오는 중" /></div>;
  if (!settings) return <NavigationMessage tone="error">{error ?? '문서 구조를 불러오지 못했습니다.'}</NavigationMessage>;

  return <section className="space-y-5">
    <div className="flex flex-col gap-4 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div><h2 className="font-bold text-white">문서 트리</h2><p className="mt-1 text-xs leading-5 text-slate-400">문서 주소를 바꾸지 않고 GitBook처럼 그룹, 상하 순서와 계층을 구성합니다. 버튼은 키보드로도 사용할 수 있습니다.</p></div>
      <button type="button" onClick={addGroup} className="btn-secondary min-h-11 shrink-0"><FolderPlus className="size-4" />그룹 추가</button>
    </div>
    {error ? <NavigationMessage tone="error">{error}</NavigationMessage> : null}
    {notice ? <NavigationMessage tone="success">{notice}</NavigationMessage> : null}
    {conflictVersion !== null ? <div className="flex flex-col gap-3 rounded-xl border border-amber-300/25 bg-amber-400/10 p-4 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between"><span>다른 관리자의 변경이 먼저 저장되었습니다. 현재 버전은 {conflictVersion}입니다.</span><button type="button" onClick={() => void load()} className="btn-secondary min-h-11">최신 구조 다시 불러오기</button></div> : null}
    {emptyGroups.length > 0 ? <NavigationMessage tone="error">빈 그룹에는 문서를 하나 이상 넣거나 그룹을 삭제해야 저장할 수 있습니다.</NavigationMessage> : null}
    <ol className="space-y-2" aria-label="서버 위키 문서 구조">
      {nodes.map((node) => {
        const item = itemById.get(node.id);
        const title = node.kind === 'group' ? node.title : item?.title ?? `문서 ${node.pageId}`;
        const controls = serverWikiNodeControls(nodes, node.id, rootId);
        const depth = serverWikiNodeDepth(nodes, node.id);
        return <li key={node.id} style={{ paddingLeft: `${Math.min(depth, 8) * 18}px` }}>
          <div className={`flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center ${emptyGroups.includes(node.id) ? 'border-amber-300/30 bg-amber-400/[0.06]' : 'border-white/10 bg-[#10161e]'}`}>
            <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${node.kind === 'group' ? 'bg-amber-400/10 text-amber-300' : 'bg-emerald-400/10 text-emerald-300'}`}>{node.kind === 'group' ? <Folder className="size-4" /> : <FileText className="size-4" />}</span>
            <div className="min-w-0 flex-1">
              {node.kind === 'group' ? <input aria-label={`${title} 그룹 이름`} value={node.title} maxLength={80} onChange={(event) => setNodes((current) => renameServerWikiGroup(current, node.id, event.target.value) as NavigationNode[])} className="min-h-10 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm font-semibold text-white outline-none focus:border-emerald-300/50" /> : <div><strong className="block truncate text-sm text-white">{title}</strong><span className="mt-1 block truncate text-[11px] text-slate-500">{item?.status === 'deleted' ? '삭제된 문서 · 위치 보존' : item?.path ?? '문서 경로'}</span></div>}
            </div>
            <div className="flex flex-wrap items-center gap-1" aria-label={`${title} 위치 제어`}>
              <TreeButton label={`${title} 위로 이동`} disabled={!controls.up} onClick={() => setNodes((current) => moveServerWikiNode(current, node.id, 'up') as NavigationNode[])}><ArrowUp className="size-4" /></TreeButton>
              <TreeButton label={`${title} 아래로 이동`} disabled={!controls.down} onClick={() => setNodes((current) => moveServerWikiNode(current, node.id, 'down') as NavigationNode[])}><ArrowDown className="size-4" /></TreeButton>
              <TreeButton label={`${title} 하위로 들여쓰기`} disabled={!controls.indent} onClick={() => setNodes((current) => indentServerWikiNode(current, node.id) as NavigationNode[])}><ArrowRight className="size-4" /></TreeButton>
              <TreeButton label={`${title} 상위로 내어쓰기`} disabled={!controls.outdent} onClick={() => setNodes((current) => outdentServerWikiNode(current, node.id) as NavigationNode[])}><ArrowLeft className="size-4" /></TreeButton>
              {node.kind === 'page' && item?.path ? <a href={item.path} target="_blank" rel="noreferrer" aria-label={`${title} 문서 열기`} className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><ExternalLink className="size-4" /></a> : null}
              {node.kind === 'group' ? <TreeButton label={`${title} 그룹 삭제`} onClick={() => setNodes((current) => removeServerWikiGroup(current, node.id) as NavigationNode[])} danger><Trash2 className="size-4" /></TreeButton> : null}
            </div>
          </div>
        </li>;
      })}
    </ol>
    <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-white/10 bg-[#10161e]/95 p-4 shadow-2xl backdrop-blur sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-slate-400">문서 {nodes.filter((node) => node.kind === 'page').length}개 · 그룹 {nodes.filter((node) => node.kind === 'group').length}개 · 구조 v{settings.version}</p>
      <button type="button" onClick={() => void save()} disabled={!dirty || emptyGroups.length > 0 || saving} className="btn-primary min-h-11 min-w-36 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}구조 저장</button>
    </div>
  </section>;
}

function TreeButton({ label, disabled = false, danger = false, onClick, children }: { readonly label: string; readonly disabled?: boolean; readonly danger?: boolean; readonly onClick: () => void; readonly children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={`grid size-9 place-items-center rounded-lg disabled:cursor-not-allowed disabled:opacity-25 ${danger ? 'text-red-300 hover:bg-red-400/10' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>{children}</button>;
}

function NavigationMessage({ tone, children }: { readonly tone: 'error' | 'success'; readonly children: React.ReactNode }) {
  return <div className={`flex gap-3 rounded-xl border p-4 text-sm ${tone === 'error' ? 'border-red-300/20 bg-red-500/10 text-red-100' : 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'}`}>{tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 flex-none" /> : null}<span>{children}</span></div>;
}
