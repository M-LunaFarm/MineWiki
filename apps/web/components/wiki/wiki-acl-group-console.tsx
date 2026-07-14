'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Archive, Clock3, Loader2, Network, Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import {
  addWikiAclGroupMember,
  createWikiAclGroup,
  deleteWikiAclGroup,
  fetchWikiAclGroupMembers,
  fetchWikiAclGroups,
  removeWikiAclGroupMember,
  updateWikiAclGroup,
  updateWikiAclGroupMemberExpiry,
  type WikiAclGroupMemberSummary,
  type WikiAclGroupSummary
} from '../../lib/wiki-api';

export function WikiAclGroupConsole() {
  const [groups, setGroups] = useState<WikiAclGroupSummary[]>([]);
  const [groupCursor, setGroupCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<WikiAclGroupMemberSummary[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selfRemovable, setSelfRemovable] = useState(false);
  const [memberType, setMemberType] = useState<'user' | 'ip' | 'cidr'>('user');
  const [memberValue, setMemberValue] = useState('');
  const [memberReason, setMemberReason] = useState('');
  const [memberExpiry, setMemberExpiry] = useState('');

  const selected = groups.find((group) => group.id === selectedId) ?? null;

  useEffect(() => {
    void fetchWikiAclGroups({ status: 'active' }).then((result) => {
      setGroups(result.items);
      setGroupCursor(result.nextCursor);
      setSelectedId((current) => current ?? result.items[0]?.id ?? null);
    }).catch((value) => setError(message(value))).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) { setMembers([]); setMemberCursor(null); return; }
    setLoading(true);
    void fetchWikiAclGroupMembers(selectedId).then((result) => {
      setMembers(result.items); setMemberCursor(result.nextCursor);
    }).catch((value) => setError(message(value))).finally(() => setLoading(false));
  }, [selectedId]);

  async function createGroup(event: FormEvent) {
    event.preventDefault(); setWorking(true); setError(null);
    try {
      const created = await createWikiAclGroup({ key, title, description: description || undefined, selfRemovable });
      setGroups((current) => [created, ...current]); setSelectedId(created.id);
      setKey(''); setTitle(''); setDescription(''); setSelfRemovable(false);
    } catch (value) { setError(message(value)); } finally { setWorking(false); }
  }

  async function addMember(event: FormEvent) {
    event.preventDefault(); if (!selected) return; setWorking(true); setError(null);
    try {
      const created = await addWikiAclGroupMember(selected.id, {
        memberType,
        ...(memberType === 'user' ? { userId: memberValue } : { address: memberValue }),
        expiresAt: memberExpiry ? new Date(memberExpiry).toISOString() : null,
        reason: memberReason
      });
      setMembers((current) => [created, ...current]);
      setGroups((current) => current.map((group) => group.id === selected.id ? { ...group, activeMemberCount: group.activeMemberCount + 1 } : group));
      setMemberValue(''); setMemberReason(''); setMemberExpiry('');
    } catch (value) { setError(message(value)); } finally { setWorking(false); }
  }

  async function toggleSelfRemove(group: WikiAclGroupSummary) {
    setWorking(true); setError(null);
    try {
      const updated = await updateWikiAclGroup(group.id, {
        selfRemovable: !group.selfRemovable,
        reason: 'ACL 그룹 직접 제거 정책 변경'
      });
      setGroups((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (value) { setError(message(value)); } finally { setWorking(false); }
  }

  async function archiveGroup(group: WikiAclGroupSummary) {
    const reason = window.prompt('그룹 보관 사유를 입력하세요. 활성 구성원도 함께 제거됩니다.');
    if (!reason) return;
    setWorking(true); setError(null);
    try {
      await deleteWikiAclGroup(group.id, reason);
      setGroups((current) => current.filter((item) => item.id !== group.id));
      setSelectedId((current) => current === group.id ? null : current);
    } catch (value) { setError(message(value)); } finally { setWorking(false); }
  }

  async function removeMember(member: WikiAclGroupMemberSummary) {
    if (!selected) return;
    const reason = window.prompt('구성원 제거 사유를 입력하세요.');
    if (!reason) return;
    setWorking(true); setError(null);
    try {
      await removeWikiAclGroupMember(selected.id, member.id, reason);
      setMembers((current) => current.filter((item) => item.id !== member.id));
      setGroups((current) => current.map((group) => group.id === selected.id ? { ...group, activeMemberCount: Math.max(0, group.activeMemberCount - 1) } : group));
    } catch (value) { setError(message(value)); } finally { setWorking(false); }
  }

  async function changeExpiry(member: WikiAclGroupMemberSummary) {
    if (!selected) return;
    const raw = window.prompt('새 만료 시각을 ISO 형식으로 입력하세요. 비우면 영구입니다.', member.expiresAt ?? '');
    if (raw === null) return;
    const reason = window.prompt('만료 변경 사유를 입력하세요.');
    if (!reason) return;
    setWorking(true); setError(null);
    try {
      const updated = await updateWikiAclGroupMemberExpiry(selected.id, member.id, raw.trim() ? new Date(raw).toISOString() : null, reason);
      setMembers((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (value) { setError(message(value)); } finally { setWorking(false); }
  }

  async function moreGroups() {
    if (!groupCursor) return;
    const result = await fetchWikiAclGroups({ cursor: groupCursor, status: 'active' });
    setGroups((current) => [...current, ...result.items]); setGroupCursor(result.nextCursor);
  }

  async function moreMembers() {
    if (!selected || !memberCursor) return;
    const result = await fetchWikiAclGroupMembers(selected.id, { cursor: memberCursor });
    setMembers((current) => [...current, ...result.items]); setMemberCursor(result.nextCursor);
  }

  return (
    <section className="space-y-4 rounded-xl border border-white/10 bg-[#111821] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-lg font-bold text-white"><ShieldCheck className="size-5 text-emerald-300" />ACL 그룹 운영</h2><p className="mt-1 text-xs text-slate-400">사용자와 IPv4/IPv6 네트워크 구성원을 별도로 관리합니다. 모든 변경은 ACL 감사 이력에 원자적으로 기록됩니다.</p></div>
        {loading ? <Loader2 className="size-5 animate-spin text-emerald-300" /> : null}
      </div>
      {error ? <p className="rounded-lg border border-red-300/30 bg-red-500/10 p-3 text-sm text-red-100">{error}</p> : null}
      <form onSubmit={createGroup} className="grid gap-3 rounded-lg border border-white/10 bg-black/20 p-4 md:grid-cols-2 xl:grid-cols-5">
        <input className="admin-acl-input" value={key} onChange={(event) => setKey(event.target.value)} placeholder="그룹 키 (영문)" required />
        <input className="admin-acl-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="그룹 이름" required />
        <input className="admin-acl-input xl:col-span-2" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="설명" />
        <div className="flex items-center gap-3"><label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={selfRemovable} onChange={(event) => setSelfRemovable(event.target.checked)} />직접 제거 허용</label><button disabled={working} className="btn-primary ml-auto h-10 gap-2"><Plus className="size-4" />생성</button></div>
      </form>
      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,2fr)]">
        <div className="space-y-2">
          {groups.map((group) => <button type="button" key={group.id} onClick={() => setSelectedId(group.id)} className={`w-full rounded-lg border p-3 text-left ${selectedId === group.id ? 'border-emerald-300/50 bg-emerald-400/10' : 'border-white/10 bg-black/20 hover:border-white/20'}`}><span className="block font-semibold text-white">{group.title}</span><span className="mt-1 block font-mono text-[11px] text-slate-500">{group.key} · {group.activeMemberCount}명</span></button>)}
          {groupCursor ? <button type="button" onClick={() => void moreGroups()} className="w-full rounded-lg border border-white/10 py-2 text-xs text-slate-300">그룹 더 보기</button> : null}
        </div>
        {selected ? <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 p-3"><div><p className="font-semibold text-white">{selected.title}</p><p className="text-xs text-slate-500">{selected.description ?? '설명 없음'}</p></div><div className="flex gap-2"><button type="button" disabled={working} onClick={() => void toggleSelfRemove(selected)} className="chip chip-muted">직접 제거 {selected.selfRemovable ? '허용' : '차단'}</button><button type="button" disabled={working} onClick={() => void archiveGroup(selected)} className="rounded-md border border-red-300/20 p-2 text-red-200"><Archive className="size-4" /></button></div></div>
          <form onSubmit={addMember} className="grid gap-3 rounded-lg border border-white/10 p-3 md:grid-cols-2 xl:grid-cols-5">
            <select className="admin-acl-input" value={memberType} onChange={(event) => setMemberType(event.target.value as typeof memberType)}><option value="user">사용자</option><option value="ip">단일 IP</option><option value="cidr">CIDR 범위</option></select>
            <input className="admin-acl-input" value={memberValue} onChange={(event) => setMemberValue(event.target.value)} placeholder={memberType === 'user' ? '위키 사용자 ID' : memberType === 'ip' ? '192.0.2.1 또는 2001:db8::1' : '192.0.2.0/24'} required />
            <input className="admin-acl-input" type="datetime-local" value={memberExpiry} onChange={(event) => setMemberExpiry(event.target.value)} />
            <input className="admin-acl-input" value={memberReason} onChange={(event) => setMemberReason(event.target.value)} placeholder="운영 사유" required minLength={3} />
            <button disabled={working} className="btn-primary h-10 gap-2"><Plus className="size-4" />구성원 추가</button>
          </form>
          <div className="overflow-x-auto rounded-lg border border-white/10"><table className="min-w-full text-left text-sm"><thead className="border-b border-white/10 text-xs text-slate-500"><tr><th className="px-3 py-2">종류</th><th className="px-3 py-2">대상</th><th className="px-3 py-2">사유</th><th className="px-3 py-2">만료</th><th className="px-3 py-2">작업</th></tr></thead><tbody className="divide-y divide-white/10">{members.map((member) => <tr key={member.id}><td className="px-3 py-3 text-slate-300">{member.memberType === 'user' ? <UserRound className="size-4" /> : <Network className="size-4" />}</td><td className="px-3 py-3 font-mono text-xs text-white">{member.userName ?? member.cidr}</td><td className="max-w-xs px-3 py-3 text-xs text-slate-400">{member.reason}</td><td className="px-3 py-3 text-xs text-slate-400">{member.expiresAt ? new Date(member.expiresAt).toLocaleString('ko-KR') : '영구'}</td><td className="px-3 py-3"><div className="flex gap-2"><button type="button" onClick={() => void changeExpiry(member)} className="rounded border border-white/10 p-2"><Clock3 className="size-3.5" /></button><button type="button" onClick={() => void removeMember(member)} className="rounded border border-red-300/20 p-2 text-red-200"><Trash2 className="size-3.5" /></button></div></td></tr>)}</tbody></table>{members.length === 0 ? <p className="p-6 text-center text-xs text-slate-500">활성 구성원이 없습니다.</p> : null}</div>
          {memberCursor ? <button type="button" onClick={() => void moreMembers()} className="w-full rounded-lg border border-white/10 py-2 text-xs text-slate-300">구성원 더 보기</button> : null}
        </div> : <p className="rounded-lg border border-white/10 p-8 text-center text-sm text-slate-500">관리할 ACL 그룹을 선택하세요.</p>}
      </div>
    </section>
  );
}

function message(value: unknown): string { return value instanceof Error ? value.message : 'ACL 그룹 요청을 처리하지 못했습니다.'; }
