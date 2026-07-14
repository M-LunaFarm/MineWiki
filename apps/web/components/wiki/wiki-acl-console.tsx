'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Plus, Shield, Trash2 } from 'lucide-react';

import {
  createWikiAclRule,
  deleteWikiAclRule,
  fetchWikiAclCatalog,
  fetchWikiAclRules,
  type WikiAclCatalog,
  type WikiAclRuleSummary,
} from '../../lib/wiki-api';
import { WikiAclGroupConsole } from './wiki-acl-group-console';

const ACTIONS = [
  ['read', '읽기'], ['edit', '편집'], ['create', '문서 생성'], ['move', '이동'],
  ['delete', '삭제'], ['revert', '되돌리기'], ['history', '역사'], ['raw', '원문'],
  ['discuss', '토론 (기존 규칙)'], ['create_thread', '토론 생성'],
  ['write_thread_comment', '토론 댓글 작성'],
  ['upload_file', '파일 업로드'], ['acl', 'ACL 관리'],
] as const;

const ROLE_SUBJECTS = [
  ['server_owner', '서버 소유자'], ['server_manager', '서버 매니저'], ['server_editor', '서버 편집자'],
  ['mod_wiki_manager', '모드 위키 관리자'], ['mod_wiki_editor', '모드 위키 편집자'],
  ['owner_user', '문서 작성자'], ['page_contributor', '문서 기여자'], ['space_contributor', '공간 기여자'],
] as const;

const PERMISSION_SUBJECTS = [
  ['any', '모든 사용자'], ['guest', '비회원'], ['member', '로그인 회원'],
  ['autoconfirmed', '자동 인증 회원'], ['trusted', '신뢰 사용자'], ['moderator', '중재자'],
  ['admin', '관리자'], ['developer', '개발자'],
] as const;

export function WikiAclConsole() {
  const [rules, setRules] = useState<WikiAclRuleSummary[]>([]);
  const [catalog, setCatalog] = useState<WikiAclCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetType, setTargetType] = useState<WikiAclRuleSummary['targetType']>('site');
  const [targetId, setTargetId] = useState('');
  const [action, setAction] = useState('read');
  const [effect, setEffect] = useState<WikiAclRuleSummary['effect']>('allow');
  const [subjectType, setSubjectType] = useState<WikiAclRuleSummary['subjectType']>('perm');
  const [subjectValue, setSubjectValue] = useState('any');
  const [reason, setReason] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [nextRules, nextCatalog] = await Promise.all([fetchWikiAclRules(), fetchWikiAclCatalog()]);
      setRules(nextRules);
      setCatalog(nextCatalog);
    } catch (value) {
      setError(value instanceof Error ? value.message : 'ACL 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const targetOptions = useMemo(() => {
    if (!catalog || targetType === 'site') return [];
    if (targetType === 'namespace') return catalog.namespaces.map((item) => ({ value: item.id, label: `${item.name} (${item.code})` }));
    if (targetType === 'space') return catalog.spaces.map((item) => ({ value: item.id, label: `${item.name} · ${item.type}` }));
    return catalog.pages.map((item) => ({ value: item.id, label: `${item.name} #${item.id}` }));
  }, [catalog, targetType]);

  const subjectOptions = useMemo(() => {
    if (!catalog) return [];
    if (subjectType === 'perm') return PERMISSION_SUBJECTS.map(([value, label]) => ({ value, label }));
    if (subjectType === 'role') return ROLE_SUBJECTS.map(([value, label]) => ({ value, label }));
    if (subjectType === 'group') return catalog.groups.map((item) => ({ value: item.code, label: item.name }));
    if (subjectType === 'aclgroup') return catalog.aclGroups.filter((item) => item.status === 'active').map((item) => ({ value: item.key, label: item.name }));
    return [];
  }, [catalog, subjectType]);

  useEffect(() => {
    setTargetId(targetOptions[0]?.value ?? '');
  }, [targetOptions]);
  useEffect(() => {
    if (subjectType !== 'user') setSubjectValue(subjectOptions[0]?.value ?? '');
  }, [subjectOptions, subjectType]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true); setError(null);
    try {
      const created = await createWikiAclRule({
        targetType,
        targetId: targetType === 'site' ? null : targetId,
        action,
        effect,
        subjectType,
        subjectValue,
        reason: reason || undefined,
      });
      setRules((current) => [...current, created]);
      setReason('');
    } catch (value) {
      setError(value instanceof Error ? value.message : 'ACL 규칙을 추가하지 못했습니다.');
    } finally { setWorking(false); }
  }

  async function remove(rule: WikiAclRuleSummary) {
    if (!window.confirm('이 ACL 규칙을 삭제할까요? 변경 이력은 유지됩니다.')) return;
    setWorking(true); setError(null);
    try {
      await deleteWikiAclRule(rule.id, '관리자 ACL 화면에서 삭제');
      setRules((current) => current.filter((item) => item.id !== rule.id));
    } catch (value) {
      setError(value instanceof Error ? value.message : 'ACL 규칙을 삭제하지 못했습니다.');
    } finally { setWorking(false); }
  }

  function subjectLabel(rule: WikiAclRuleSummary): string {
    if (rule.subjectType !== 'aclgroup') return `${rule.subjectType}:${rule.subjectValue}`;
    const group = catalog?.aclGroups.find((item) => item.key === rule.subjectValue);
    if (!group) return `aclgroup:${rule.subjectValue} (삭제됨)`;
    return `aclgroup:${group.name}${group.status === 'active' ? '' : ' (보관됨)'}`;
  }

  if (loading) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="flex items-center gap-3"><Shield className="size-5 text-emerald-300" /><div><h1 className="text-2xl font-bold text-white">위키 ACL</h1><p className="mt-1 text-sm text-slate-400">문서가 가장 우선이며 공간, 네임스페이스, 사이트 순으로 상속됩니다. 같은 범위에서는 위 규칙부터 처음 일치한 항목을 적용합니다.</p></div></div><nav className="flex flex-wrap gap-2"><Link href="/admin/wiki" className="chip chip-muted">최근 변경</Link><Link href="/admin/wiki/pages" className="chip chip-muted">문서</Link><span className="chip chip-accent">ACL</span><Link href="/admin/wiki/users" className="chip chip-muted">사용자 차단</Link><Link href="/admin/wiki/batch-rollback" className="chip chip-muted">일괄 복구</Link></nav></div>
      </section>

      {error ? <div className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100"><AlertTriangle className="size-4 shrink-0" />{error}</div> : null}

      <WikiAclGroupConsole />

      <form onSubmit={submit} className="grid gap-4 rounded-xl border border-white/10 bg-[#111821] p-5 lg:grid-cols-4">
        <Field label="범위"><select value={targetType} onChange={(e) => setTargetType(e.target.value as WikiAclRuleSummary['targetType'])} className="admin-acl-input"><option value="site">사이트 전체</option><option value="namespace">네임스페이스</option><option value="space">위키 공간</option><option value="page">개별 문서</option></select></Field>
        <Field label="대상"><select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={targetType === 'site'} className="admin-acl-input"><option value="">사이트 전체</option>{targetOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
        <Field label="동작"><select value={action} onChange={(e) => setAction(e.target.value)} className="admin-acl-input">{ACTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="효과"><select value={effect} onChange={(e) => setEffect(e.target.value as WikiAclRuleSummary['effect'])} className="admin-acl-input"><option value="allow">허용</option><option value="deny">거부</option></select></Field>
        <Field label="주체 종류"><select value={subjectType} onChange={(e) => setSubjectType(e.target.value as WikiAclRuleSummary['subjectType'])} className="admin-acl-input"><option value="perm">일반 사용자 상태</option><option value="group">일반 위키 그룹</option><option value="role">서버/모드 역할</option><option value="aclgroup">ACL 그룹</option><option value="user">특정 사용자</option></select></Field>
        <Field label="주체"><>{subjectType === 'user' ? <input value={subjectValue} onChange={(e) => setSubjectValue(e.target.value)} placeholder="위키 사용자 ID" className="admin-acl-input" /> : <select value={subjectValue} onChange={(e) => setSubjectValue(e.target.value)} className="admin-acl-input">{subjectOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>}</></Field>
        <Field label="사유"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="운영 사유" className="admin-acl-input" /></Field>
        <div className="flex items-end"><button type="submit" disabled={working || !subjectValue || (targetType !== 'site' && !targetId)} className="btn-primary h-10 w-full gap-2"><Plus className="size-4" />규칙 추가</button></div>
      </form>

      <section className="overflow-x-auto rounded-xl border border-white/10 bg-[#111821]">
        <table className="min-w-full text-left text-sm"><thead className="border-b border-white/10 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">범위</th><th className="px-4 py-3">동작</th><th className="px-4 py-3">주체</th><th className="px-4 py-3">효과</th><th className="px-4 py-3">사유</th><th className="px-4 py-3">작업</th></tr></thead><tbody className="divide-y divide-white/10 text-slate-300">{rules.map((rule) => <tr key={rule.id}><td className="px-4 py-3 font-mono text-xs">{rule.targetType}:{rule.targetId ?? '*'}</td><td className="px-4 py-3">{rule.action}</td><td className="px-4 py-3">{subjectLabel(rule)}</td><td className={`px-4 py-3 font-semibold ${rule.effect === 'allow' ? 'text-emerald-300' : 'text-red-300'}`}>{rule.effect === 'allow' ? '허용' : '거부'}</td><td className="max-w-xs px-4 py-3 text-slate-400">{rule.reason ?? '-'}</td><td className="px-4 py-3"><button type="button" onClick={() => void remove(rule)} disabled={working} className="rounded-md border border-white/10 p-2 hover:border-red-300/40 hover:text-red-300"><Trash2 className="size-4" /></button></td></tr>)}</tbody></table>
        {rules.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">등록된 ACL 규칙이 없습니다. 기본 보호 정책이 적용됩니다.</p> : null}
      </section>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) { return <label className="grid gap-2 text-xs font-semibold text-slate-400"><span>{label}</span>{children}</label>; }
