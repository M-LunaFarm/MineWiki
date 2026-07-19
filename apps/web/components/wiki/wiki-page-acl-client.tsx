'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Loader2, LockKeyhole, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  createWikiPageAclRule,
  deleteWikiPageAclRule,
  fetchWikiPageAcl,
  reorderWikiPageAclRules,
  type WikiAclRuleSummary,
  type WikiPageAclResponse
} from '../../lib/wiki-api';

const ACTION_LABELS: Record<string, string> = {
  read: '읽기', edit: '편집', edit_request: '편집 요청', create: '문서 생성', move: '이동', delete: '삭제',
  revert: '되돌리기', history: '역사', raw: '원문', discuss: '토론 (기존 규칙)',
  create_thread: '토론 생성', write_thread_comment: '토론 댓글 작성',
  upload_file: '파일 업로드', acl: 'ACL 관리'
};
const SUBJECT_TYPE_LABELS: Record<WikiAclRuleSummary['subjectType'], string> = {
  perm: '사용자 상태', user: '특정 사용자', group: '일반 그룹', aclgroup: 'ACL 그룹', role: '서버·위키 역할'
};
const PERMISSION_SUBJECTS = [
  ['any', '모든 사용자'], ['guest', '비회원'], ['member', '로그인 회원'],
  ['autoconfirmed', '자동 인증 회원'], ['trusted', '신뢰 사용자'], ['moderator', '중재자'],
  ['admin', '관리자'], ['developer', '개발자']
] as const;
const ROLE_LABELS: Record<string, string> = {
  owner_user: '문서 작성자', page_contributor: '문서 기여자', space_contributor: '공간 기여자',
  server_owner: '서버 소유자', server_manager: '서버 매니저', server_editor: '서버 편집자',
  mod_wiki_manager: '모드 위키 관리자', mod_wiki_editor: '모드 위키 편집자'
};
const SCOPE_LABELS: Record<'page' | 'space' | 'namespace' | 'site', string> = {
  page: '문서', space: '공간', namespace: '네임스페이스', site: '사이트'
};

export function WikiPageAclClient({
  pageId,
  returnTo,
  compactHeader = false
}: {
  readonly pageId: string;
  readonly returnTo: string;
  readonly compactHeader?: boolean;
}) {
  const [data, setData] = useState<WikiPageAclResponse | null>(null);
  const [activeAction, setActiveAction] = useState('read');
  const [effect, setEffect] = useState<WikiAclRuleSummary['effect']>('allow');
  const [subjectType, setSubjectType] = useState<WikiAclRuleSummary['subjectType']>('perm');
  const [subjectValue, setSubjectValue] = useState('any');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchWikiPageAcl(pageId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '문서 ACL을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  useEffect(() => { void load(); }, [load]);

  const rules = useMemo(
    () => (data?.rules ?? []).filter((rule) => rule.action === activeAction).sort((left, right) => left.sortOrder - right.sortOrder),
    [activeAction, data]
  );
  const activeLayers = useMemo(
    () => (data?.layers ?? []).map((layer) => ({
      ...layer,
      rules: layer.rules.filter((rule) => rule.action === activeAction).sort((left, right) => left.sortOrder - right.sortOrder)
    })),
    [activeAction, data]
  );
  const activeTrace = useMemo(
    () => data?.viewerTrace.find((trace) => trace.action === activeAction) ?? null,
    [activeAction, data]
  );
  const subjectOptions = useMemo(() => {
    if (subjectType === 'perm') return PERMISSION_SUBJECTS.map(([value, label]) => ({ value, label }));
    if (subjectType === 'role') return (data?.catalog.roles ?? []).map((value) => ({ value, label: ROLE_LABELS[value] ?? value }));
    if (subjectType === 'group') return (data?.catalog.groups ?? []).map((group) => ({ value: group.code, label: group.name }));
    if (subjectType === 'aclgroup') return (data?.catalog.aclGroups ?? []).map((group) => ({ value: group.key, label: group.name }));
    return [];
  }, [data, subjectType]);

  useEffect(() => {
    if (subjectType !== 'user') setSubjectValue(subjectOptions[0]?.value ?? '');
    else setSubjectValue('');
  }, [subjectOptions, subjectType]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      await createWikiPageAclRule(pageId, {
        action: activeAction,
        effect,
        subjectType,
        subjectValue,
        reason: reason.trim() || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      setReason('');
      setExpiresAt('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ACL 규칙을 추가하지 못했습니다.');
    } finally {
      setWorking(false);
    }
  }

  async function remove(rule: WikiAclRuleSummary) {
    if (!window.confirm('이 규칙을 삭제할까요? 변경 이력은 계속 보존됩니다.')) return;
    setWorking(true);
    setError(null);
    try {
      await deleteWikiPageAclRule(pageId, rule.id, reason.trim() || '문서 ACL 화면에서 삭제');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ACL 규칙을 삭제하지 못했습니다.');
    } finally {
      setWorking(false);
    }
  }

  async function move(rule: WikiAclRuleSummary, offset: -1 | 1) {
    const index = rules.findIndex((item) => item.id === rule.id);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= rules.length) return;
    const ordered = [...rules];
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setWorking(true);
    setError(null);
    try {
      await reorderWikiPageAclRules(pageId, {
        action: activeAction,
        ruleIds: ordered.map((item) => item.id),
        reason: '문서 ACL 우선순위 변경'
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ACL 우선순위를 변경하지 못했습니다.');
    } finally {
      setWorking(false);
    }
  }

  if (loading && !data) {
    return <div className="flex min-h-[35vh] items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 size-5 animate-spin" /> ACL을 불러오는 중입니다.</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      {!compactHeader ? <>
        <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <Link href={returnTo} className="inline-flex items-center gap-1.5 hover:text-emerald-200"><ArrowLeft className="size-4" /> 문서로 돌아가기</Link>
          <span>/</span><span className="text-slate-200">ACL</span>
        </nav>
        <header className="border-b border-white/10 pb-6">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-white"><ShieldCheck className="size-7 text-emerald-300" /> 문서 ACL</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">문서별 읽기·편집·토론·관리 권한을 실제 ACL처럼 위에서부터 평가합니다.</p>
        </header>
      </> : null}

      {data ? <section className="surface-flat flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">Page policy</p><h2 className="mt-1 text-lg font-bold text-white">{data.page.displayTitle}</h2><p className="mt-1 text-xs text-slate-500">보호 수준 {data.page.protectionLevel} · 문서 #{data.page.id}</p></div>
        <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${data.canManage ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200' : 'border-white/10 text-slate-400'}`}>
          {data.canManage ? <ShieldCheck className="size-3.5" /> : <LockKeyhole className="size-3.5" />}
          {data.canManage ? '관리 권한 있음' : '읽기 전용'}
        </div>
      </section> : null}

      {error ? <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</p> : null}

      {data ? <>
        {data.canManage ? <div className="overflow-x-auto border-b border-white/10" role="tablist" aria-label="ACL 동작">
          <div className="flex min-w-max gap-1 pb-2">
            {data.actions.map((action) => {
              const count = data.layers.reduce((total, layer) => total + layer.rules.filter((rule) => rule.action === action).length, 0);
              return <button key={action} type="button" role="tab" aria-selected={activeAction === action} onClick={() => setActiveAction(action)} className={`rounded-md px-3 py-2 text-xs font-semibold transition ${activeAction === action ? 'bg-emerald-300/15 text-emerald-200' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'}`}>{ACTION_LABELS[action] ?? action}{count ? ` ${count}` : ''}</button>;
            })}
          </div>
        </div> : null}

        {data.canManage ? <section className="surface-flat overflow-hidden">
          <div className="border-b border-white/10 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="text-base font-bold text-white">{ACTION_LABELS[activeAction] ?? activeAction} 평가 계층</h2><p className="mt-1 text-xs leading-5 text-slate-400">문서부터 사이트까지 내려가며 현재 사용자와 처음 일치하는 규칙 하나가 적용됩니다. 문서 규칙이 있어도 주체가 일치하지 않으면 상위 범위를 계속 확인합니다.</p></div>
              <span className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${activeTrace?.matched ? activeTrace.allowed ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200' : 'border-red-300/30 bg-red-400/10 text-red-200' : 'border-white/10 text-slate-400'}`}>
                {activeTrace?.matched ? `${activeTrace.allowed ? '허용' : '거부'} · ${activeTrace.matchedScope ? SCOPE_LABELS[activeTrace.matchedScope] : '기본 정책'}` : '일치 규칙 없음 · 기본 정책'}
              </span>
            </div>
            {data.evaluatedAt ? <p className="mt-2 text-[11px] text-slate-600">{new Date(data.evaluatedAt).toLocaleString('ko-KR')} 기준 현재 사용자 판정</p> : null}
          </div>
          <div className="divide-y divide-white/10">
            {activeLayers.map((layer) => <section key={layer.scope} aria-label={`${layer.label} ACL 계층`} className="bg-white/[0.012]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3 sm:px-5">
                <div className="flex items-center gap-2"><span className="text-xs font-bold text-slate-200">{layer.label}</span><span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-500">{layer.editableHere ? '이 화면에서 편집' : '상속 · 읽기 전용'}</span></div>
                {activeTrace?.matchedScope === layer.scope ? <span className="text-[11px] font-semibold text-emerald-300">현재 사용자에게 적용된 범위</span> : null}
              </div>
              <div className="divide-y divide-white/[0.06]">
                {layer.rules.map((rule, index) => {
                  const applied = activeTrace?.matchedScope === layer.scope && activeTrace.matchedRuleId === rule.id;
                  return <article key={rule.id} className={`grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5 ${applied ? 'bg-emerald-300/[0.055] ring-1 ring-inset ring-emerald-300/20' : ''}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${rule.effect === 'allow' ? 'bg-emerald-300/12 text-emerald-200' : 'bg-red-400/10 text-red-200'}`}>{rule.effect === 'allow' ? '허용' : '거부'}</span><span className="break-all font-mono text-sm text-slate-200">{SUBJECT_TYPE_LABELS[rule.subjectType]}:{rule.subjectValue}</span>{applied ? <span className="rounded-full bg-emerald-300/15 px-2 py-1 text-[10px] font-bold text-emerald-200">현재 사용자에게 적용</span> : null}</div>
                      <p className="mt-2 text-xs leading-5 text-slate-500">{rule.reason || '사유 없음'}{rule.expiresAt ? ` · ${new Date(rule.expiresAt).toLocaleString('ko-KR')} 만료` : ' · 만료 없음'}</p>
                    </div>
                    {layer.editableHere ? <div className="flex items-center gap-1">
                      <button type="button" aria-label="규칙을 위로 이동" title="위로" onClick={() => void move(rule, -1)} disabled={working || index === 0} className="rounded-md border border-white/10 p-2 text-slate-400 transition hover:text-white disabled:opacity-30"><ArrowUp className="size-4" /></button>
                      <button type="button" aria-label="규칙을 아래로 이동" title="아래로" onClick={() => void move(rule, 1)} disabled={working || index === layer.rules.length - 1} className="rounded-md border border-white/10 p-2 text-slate-400 transition hover:text-white disabled:opacity-30"><ArrowDown className="size-4" /></button>
                      <button type="button" aria-label="규칙 삭제" title="삭제" onClick={() => void remove(rule)} disabled={working} className="rounded-md border border-red-300/20 p-2 text-red-200 transition hover:bg-red-400/10 disabled:opacity-40"><Trash2 className="size-4" /></button>
                    </div> : null}
                  </article>;
                })}
                {layer.rules.length === 0 ? <p className="px-4 py-4 text-xs leading-5 text-slate-500 sm:px-5">이 범위에는 {ACTION_LABELS[activeAction] ?? activeAction} 규칙이 없습니다. 다음 상위 범위를 확인합니다.</p> : null}
              </div>
            </section>)}
          </div>
        </section> : <section className="surface-flat p-5"><h2 className="text-base font-bold text-white">적용 중인 문서 정책</h2><p className="mt-2 text-sm leading-6 text-slate-400">이 문서를 읽을 수 있는지 여부만 확인되었습니다. 사용자·그룹 식별자와 운영 사유가 포함된 상세 ACL 규칙과 상속 판정 경로는 권한이 있는 관리자에게만 표시됩니다.</p></section>}

        {data.canManage ? <form onSubmit={submit} className="surface-flat grid gap-4 p-4 sm:p-5 lg:grid-cols-2">
          <div className="lg:col-span-2"><h2 className="flex items-center gap-2 text-base font-bold text-white"><Plus className="size-4 text-emerald-300" /> {ACTION_LABELS[activeAction]} 규칙 추가</h2><p className="mt-1 text-xs text-slate-400">특정 사용자·그룹·서버 역할을 선택해 문서 범위에서만 허용하거나 거부합니다.</p></div>
          <Field label="효과"><select value={effect} onChange={(event) => setEffect(event.target.value as WikiAclRuleSummary['effect'])} className="wiki-acl-input"><option value="allow">허용</option><option value="deny">거부</option></select></Field>
          <Field label="주체 종류"><select value={subjectType} onChange={(event) => setSubjectType(event.target.value as WikiAclRuleSummary['subjectType'])} className="wiki-acl-input"><option value="perm">사용자 상태</option><option value="role">서버·위키 역할</option><option value="group">일반 그룹</option><option value="aclgroup">ACL 그룹</option><option value="user">특정 사용자</option></select></Field>
          <Field label="주체">{subjectType === 'user' ? <input value={subjectValue} onChange={(event) => setSubjectValue(event.target.value)} inputMode="numeric" pattern="[0-9]+" placeholder="위키 사용자 ID" required className="wiki-acl-input" /> : <select value={subjectValue} onChange={(event) => setSubjectValue(event.target.value)} required className="wiki-acl-input">{subjectOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</Field>
          <Field label="만료 시각 (선택)"><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="wiki-acl-input" /></Field>
          <Field label="운영 사유 (선택)" wide><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder="이 규칙이 필요한 이유" className="wiki-acl-input" /></Field>
          <div className="lg:col-span-2"><button type="submit" disabled={working || !subjectValue} className="btn-primary gap-2 disabled:opacity-50">{working ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}규칙 추가</button></div>
        </form> : <p className="surface-flat p-4 text-sm leading-6 text-slate-400">상세 규칙의 열람과 변경은 문서 작성자, 공간 관리자, 서버 소유자 또는 ACL로 위임받은 사용자만 가능합니다. <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="font-semibold text-emerald-200 hover:underline">로그인</Link></p>}
      </> : null}
    </div>
  );
}

function Field({ label, children, wide = false }: { readonly label: string; readonly children: React.ReactNode; readonly wide?: boolean }) {
  return <label className={`grid gap-2 text-xs font-semibold text-slate-400 ${wide ? 'lg:col-span-2' : ''}`}><span>{label}</span>{children}</label>;
}
