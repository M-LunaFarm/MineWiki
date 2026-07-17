'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, FileLock2, Loader2, LockKeyhole, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  createWikiThreadAclRule,
  deleteWikiThreadAclRule,
  fetchWikiThreadAcl,
  reorderWikiThreadAclRules,
  type WikiAclRuleSummary,
  type WikiThreadAclResponse
} from '../../lib/wiki-api';

type ThreadAction = WikiThreadAclResponse['actions'][number];

const ACTION_LABELS: Record<ThreadAction, string> = {
  read: '토론 읽기',
  write_thread_comment: '댓글·투표 작성'
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

export function WikiThreadAclClient({ threadId, returnTo }: { readonly threadId: string; readonly returnTo: string }) {
  const [data, setData] = useState<WikiThreadAclResponse | null>(null);
  const [activeAction, setActiveAction] = useState<ThreadAction>('read');
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
      setData(await fetchWikiThreadAcl(threadId));
    } catch (caught) {
      setError(message(caught, '토론 ACL을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => { void load(); }, [load]);

  const rules = useMemo(
    () => (data?.rules ?? []).filter((rule) => rule.action === activeAction).sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.id === right.id ? 0 : BigInt(left.id) < BigInt(right.id) ? -1 : 1;
    }),
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
    setSubjectValue(subjectType === 'user' ? '' : subjectOptions[0]?.value ?? '');
  }, [subjectOptions, subjectType]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) {
      setError('운영 사유를 입력해 주세요.');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await createWikiThreadAclRule(threadId, {
        action: activeAction,
        effect,
        subjectType,
        subjectValue,
        reason: reason.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      setReason('');
      setExpiresAt('');
      await load();
    } catch (caught) {
      setError(message(caught, 'ACL 규칙을 추가하지 못했습니다.'));
    } finally {
      setWorking(false);
    }
  }

  async function remove(rule: WikiAclRuleSummary) {
    const deletionReason = window.prompt('삭제 사유를 입력해 주세요. 변경 이력은 계속 보존됩니다.');
    if (!deletionReason?.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await deleteWikiThreadAclRule(threadId, rule.id, deletionReason.trim());
      await load();
    } catch (caught) {
      setError(message(caught, 'ACL 규칙을 삭제하지 못했습니다.'));
    } finally {
      setWorking(false);
    }
  }

  async function move(rule: WikiAclRuleSummary, offset: -1 | 1) {
    if (!data) return;
    const index = rules.findIndex((item) => item.id === rule.id);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= rules.length) return;
    const ordered = [...rules];
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setWorking(true);
    setError(null);
    try {
      await reorderWikiThreadAclRules(threadId, {
        action: activeAction,
        ruleIds: ordered.map((item) => item.id),
        expectedRuleSetHash: data.ruleSetHash,
        reason: `토론 ${ACTION_LABELS[activeAction]} ACL 우선순위 변경`
      });
      await load();
    } catch (caught) {
      setError(message(caught, '규칙 집합이 변경됐습니다. 새로 불러온 뒤 다시 시도해 주세요.'));
      await load();
    } finally {
      setWorking(false);
    }
  }

  if (loading && !data) {
    return <div className="flex min-h-[35vh] items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 size-5 animate-spin" /> ACL을 불러오는 중입니다.</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
        <Link href={returnTo} className="inline-flex min-h-11 items-center gap-1.5 hover:text-emerald-200"><ArrowLeft className="size-4" /> 토론으로 돌아가기</Link>
        <span>/</span><span className="text-slate-200">토론 ACL</span>
      </nav>
      <header className="border-b border-white/10 pb-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-white"><FileLock2 className="size-7 text-emerald-300" /> 토론 ACL</h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">특정 토론의 열람과 참여 범위를 문서 정책보다 더 좁게 제한합니다.</p>
      </header>

      {error ? <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}</p> : null}

      {data ? <>
        <section className="surface-flat flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">Thread policy</p>
            <h2 className="mt-1 break-words text-lg font-bold text-white">{data.thread.title}</h2>
            <p className="mt-1 break-words text-xs leading-5 text-slate-500">{data.page.displayTitle} · 토론 #{data.thread.id} · {data.thread.status}</p>
          </div>
          <div className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${data.canManage ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200' : 'border-white/10 text-slate-400'}`}>
            {data.canManage ? <ShieldCheck className="size-3.5" /> : <LockKeyhole className="size-3.5" />}
            {data.canManage ? '관리 권한 있음' : '읽기 전용'}
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <PolicyNote title="문서 읽기가 최상위 경계">토론의 허용 규칙은 문서 읽기 거부를 우회할 수 없습니다. 문서를 읽을 수 없는 사용자는 이 토론도 볼 수 없습니다.</PolicyNote>
          <PolicyNote title="규칙이 있으면 폐쇄형 평가">현재 동작에 유효한 규칙이 하나라도 있으면 위에서부터 첫 일치 규칙을 적용하며, 아무 규칙에도 일치하지 않으면 거부합니다.</PolicyNote>
        </section>

        {data.canManage ? <div className="overflow-x-auto border-b border-white/10" role="tablist" aria-label="토론 ACL 동작">
          <div className="flex min-w-max gap-1 pb-2">
            {data.actions.map((action) => {
              const count = data.rules.filter((rule) => rule.action === action).length;
              return <button key={action} type="button" role="tab" aria-selected={activeAction === action} onClick={() => setActiveAction(action)} className={`min-h-11 rounded-md px-3 py-2 text-xs font-semibold transition ${activeAction === action ? 'bg-emerald-300/15 text-emerald-200' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'}`}>{ACTION_LABELS[action]}{count ? ` ${count}` : ''}</button>;
            })}
          </div>
        </div> : null}

        {data.canManage ? <section className="surface-flat overflow-hidden">
          <div className="border-b border-white/10 p-4 sm:p-5">
            <h2 className="text-base font-bold text-white">{ACTION_LABELS[activeAction]} 규칙</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">{rules.length === 0 ? '토론 규칙이 없어 문서 ACL을 그대로 상속합니다.' : '첫 일치 규칙이 적용됩니다. allow 목록에 없는 사용자는 기본 거부됩니다.'}</p>
          </div>
          <div className="divide-y divide-white/10">
            {rules.map((rule, index) => <article key={rule.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${rule.effect === 'allow' ? 'bg-emerald-300/12 text-emerald-200' : 'bg-red-400/10 text-red-200'}`}>{rule.effect === 'allow' ? '허용' : '거부'}</span><span className="break-all font-mono text-sm text-slate-200">{SUBJECT_TYPE_LABELS[rule.subjectType]}:{rule.subjectValue}</span></div>
                <p className="mt-2 break-words text-xs leading-5 text-slate-500">{rule.reason || '사유 없음'}{rule.expiresAt ? ` · ${new Date(rule.expiresAt).toLocaleString('ko-KR')} 만료` : ' · 만료 없음'}</p>
              </div>
              {data.canManage ? <div className="flex items-center gap-1">
                <button type="button" aria-label="규칙을 위로 이동" onClick={() => void move(rule, -1)} disabled={working || index === 0} className="min-h-11 min-w-11 rounded-md border border-white/10 p-2 text-slate-400 transition hover:text-white disabled:opacity-30"><ArrowUp className="mx-auto size-4" /></button>
                <button type="button" aria-label="규칙을 아래로 이동" onClick={() => void move(rule, 1)} disabled={working || index === rules.length - 1} className="min-h-11 min-w-11 rounded-md border border-white/10 p-2 text-slate-400 transition hover:text-white disabled:opacity-30"><ArrowDown className="mx-auto size-4" /></button>
                <button type="button" aria-label="규칙 삭제" onClick={() => void remove(rule)} disabled={working} className="min-h-11 min-w-11 rounded-md border border-red-300/20 p-2 text-red-200 transition hover:bg-red-400/10 disabled:opacity-40"><Trash2 className="mx-auto size-4" /></button>
              </div> : null}
            </article>)}
            {rules.length === 0 ? <p className="p-6 text-sm leading-6 text-slate-400">상속 상태입니다. 제한을 시작하려면 필요한 허용 대상을 모두 포함한 규칙 집합을 구성하세요.</p> : null}
          </div>
        </section> : <section className="surface-flat p-5"><h2 className="text-base font-bold text-white">적용 중인 토론 정책</h2><p className="mt-2 text-sm leading-6 text-slate-400">문서 읽기 정책을 경계로 이 토론에 접근할 수 있는지만 확인되었습니다. 사용자·그룹 식별자와 운영 사유가 포함된 상세 규칙은 ACL 관리자에게만 표시됩니다.</p></section>}

        {data.canManage ? <form onSubmit={submit} className="surface-flat grid gap-4 p-4 sm:p-5 lg:grid-cols-2">
          <div className="lg:col-span-2"><h2 className="flex items-center gap-2 text-base font-bold text-white"><Plus className="size-4 text-emerald-300" /> {ACTION_LABELS[activeAction]} 규칙 추가</h2><p className="mt-1 text-xs leading-5 text-slate-400">차단 목록은 거부 규칙 뒤에 <code>perm:any</code> 허용 규칙을 두어야 나머지 사용자가 접근할 수 있습니다.</p></div>
          <Field label="효과"><select value={effect} onChange={(event) => setEffect(event.target.value as WikiAclRuleSummary['effect'])} className="wiki-acl-input"><option value="allow">허용</option><option value="deny">거부</option></select></Field>
          <Field label="주체 종류"><select value={subjectType} onChange={(event) => setSubjectType(event.target.value as WikiAclRuleSummary['subjectType'])} className="wiki-acl-input"><option value="perm">사용자 상태</option><option value="role">서버·위키 역할</option><option value="group">일반 그룹</option><option value="aclgroup">ACL 그룹</option><option value="user">특정 사용자</option></select></Field>
          <Field label="주체">{subjectType === 'user' ? <input value={subjectValue} onChange={(event) => setSubjectValue(event.target.value)} inputMode="numeric" pattern="[0-9]+" placeholder="위키 사용자 ID" required className="wiki-acl-input" /> : <select value={subjectValue} onChange={(event) => setSubjectValue(event.target.value)} required className="wiki-acl-input">{subjectOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</Field>
          <Field label="만료 시각 (선택)"><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="wiki-acl-input" /></Field>
          <Field label="운영 사유" wide><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required placeholder="제한 또는 허용이 필요한 이유" className="wiki-acl-input" /></Field>
          <div className="lg:col-span-2"><button type="submit" disabled={working || !subjectValue || !reason.trim()} className="btn-primary min-h-11 gap-2 disabled:opacity-50">{working ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}규칙 추가</button></div>
        </form> : <p className="surface-flat p-4 text-sm leading-6 text-slate-400">상세 규칙의 열람과 변경은 문서 ACL 관리자·공간/서버 소유자·전역 위키 관리자만 가능합니다. 관리 작업에는 최근 보안 인증이 필요합니다.</p>}
      </> : null}
    </div>
  );
}

function PolicyNote({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return <article className="surface-flat min-w-0 p-4"><h3 className="text-sm font-semibold text-slate-200">{title}</h3><p className="mt-2 text-xs leading-5 text-slate-500">{children}</p></article>;
}

function Field({ label, children, wide = false }: { readonly label: string; readonly children: React.ReactNode; readonly wide?: boolean }) {
  return <label className={`grid min-w-0 gap-2 text-xs font-semibold text-slate-400 ${wide ? 'lg:col-span-2' : ''}`}><span>{label}</span>{children}</label>;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
