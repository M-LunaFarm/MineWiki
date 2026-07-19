'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

type CollaboratorRole = 'manager' | 'editor' | 'reviewer';

interface WikiCollaborator {
  readonly profileId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: CollaboratorRole;
  readonly grantedAt: string;
  readonly grantedByName: string;
}

interface WikiCollaboratorsPayload {
  readonly serverId: string;
  readonly spaceId: string;
  readonly assignableRoles: readonly CollaboratorRole[];
  readonly items: readonly WikiCollaborator[];
  readonly pendingInvitations: readonly WikiCollaboratorInvitation[];
}

interface WikiCollaboratorInvitation {
  readonly id: string;
  readonly profileId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: CollaboratorRole;
  readonly reason: string;
  readonly invitedAt: string;
  readonly expiresAt: string;
  readonly resendCount: number;
  readonly version: number;
}

interface MutationInput {
  readonly key: string;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly path?: string;
  readonly body: Record<string, string | number>;
  readonly successMessage: string;
}

const REASON_MIN_LENGTH = 5;
const REASON_MAX_LENGTH = 500;

const ROLE_DETAILS: Record<CollaboratorRole, { readonly label: string; readonly description: string }> = {
  manager: {
    label: '관리자',
    description: '문서 구조와 운영 작업을 관리합니다. 협업자 권한은 서버 소유자만 변경할 수 있습니다.',
  },
  editor: {
    label: '편집자',
    description: '서버 위키 문서를 작성하고 기존 내용을 수정합니다.',
  },
  reviewer: {
    label: '검토자',
    description: '제안된 문서 변경을 검토하고 게시 흐름을 관리합니다.',
  },
};

const GRANTED_AT_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function ServerWikiCollaboratorsContent({ serverId }: { readonly serverId: string }) {
  const baseUrl = normalizeApiBaseUrl();
  const endpoint = `${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-collaborators`;
  const [payload, setPayload] = useState<WikiCollaboratorsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [addUsername, setAddUsername] = useState('');
  const [addRole, setAddRole] = useState<CollaboratorRole>('editor');
  const [addReason, setAddReason] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<Record<string, CollaboratorRole>>({});
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [revokeProfileId, setRevokeProfileId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [cancelInvitationId, setCancelInvitationId] = useState<string | null>(null);
  const [invitationReason, setInvitationReason] = useState('');

  const busy = mutationKey !== null;
  const revokeTarget = useMemo(
    () => payload?.items.find((item) => item.profileId === revokeProfileId) ?? null,
    [payload, revokeProfileId],
  );

  const loadCollaborators = useCallback(async ({
    initial = false,
    failureMessage = '협업자 목록을 불러오지 못했습니다.',
    clearNotice = true,
  }: {
    readonly initial?: boolean;
    readonly failureMessage?: string;
    readonly clearNotice?: boolean;
  } = {}): Promise<boolean> => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    if (clearNotice) setNotice(null);

    try {
      const response = await fetch(endpoint, {
        credentials: 'include',
        cache: 'no-store',
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(body, failureMessage));

      const next = parsePayload(body);
      if (next.serverId !== serverId) throw new Error('협업자 목록의 서버 정보가 요청과 일치하지 않습니다.');

      setPayload(next);
      setRoleDrafts(Object.fromEntries(next.items.map((item) => [item.profileId, item.role])));
      setReasonDrafts({});
      setAddRole((current) => next.assignableRoles.includes(current) ? current : (next.assignableRoles[0] ?? 'editor'));
      setConflict(null);
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : failureMessage);
      return false;
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, [endpoint, serverId]);

  useEffect(() => {
    void loadCollaborators({ initial: true });
  }, [loadCollaborators]);

  async function performMutation(input: MutationInput): Promise<boolean> {
    setMutationKey(input.key);
    setError(null);
    setNotice(null);
    setConflict(null);

    try {
      const response = await fetch(`${endpoint}${input.path ?? ''}`, {
        method: input.method,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(await csrfHeaders()),
        },
        body: JSON.stringify(input.body),
      });
      const body: unknown = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = apiErrorMessage(
          body,
          response.status === 409
            ? '다른 관리자가 먼저 협업자 권한을 변경했습니다. 최신 목록을 확인해 주세요.'
            : '협업자 권한을 변경하지 못했습니다.',
        );
        if (response.status === 409) {
          setConflict(message);
        } else {
          setError(message);
        }
        return false;
      }

      const refreshed = await loadCollaborators({
        failureMessage: '변경 요청은 처리되었지만 협업자 목록을 다시 확인하지 못했습니다. 목록을 새로고침해 주세요.',
        clearNotice: false,
      });
      if (!refreshed) return false;

      setNotice(input.successMessage);
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : '협업자 권한을 변경하지 못했습니다.');
      return false;
    } finally {
      setMutationKey(null);
    }
  }

  async function addCollaborator(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = addUsername.trim();
    const reason = normalizedReason(addReason);
    if (!username) {
      setError('추가할 사용자의 정확한 사용자명을 입력해 주세요.');
      return;
    }
    if (!reason) {
      setError(`추가 사유를 ${REASON_MIN_LENGTH}~${REASON_MAX_LENGTH}자로 입력해 주세요.`);
      return;
    }

    const succeeded = await performMutation({
      key: 'add',
      method: 'POST',
      body: { username, role: addRole, reason },
      successMessage: `${username}님에게 ${ROLE_DETAILS[addRole].label} 역할 초대를 보냈습니다. 수락 전에는 권한이 부여되지 않습니다.`,
    });
    if (succeeded) {
      setAddUsername('');
      setAddReason('');
    }
  }

  async function updateCollaborator(event: React.FormEvent<HTMLFormElement>, item: WikiCollaborator) {
    event.preventDefault();
    const role = roleDrafts[item.profileId] ?? item.role;
    const reason = normalizedReason(reasonDrafts[item.profileId] ?? '');
    if (role === item.role) {
      setError(`${item.displayName}님의 변경할 역할을 선택해 주세요.`);
      return;
    }
    if (!reason) {
      setError(`역할 변경 사유를 ${REASON_MIN_LENGTH}~${REASON_MAX_LENGTH}자로 입력해 주세요.`);
      return;
    }

    await performMutation({
      key: `update:${item.profileId}`,
      method: 'PATCH',
      path: `/${encodeURIComponent(item.profileId)}`,
      body: { role, expectedRole: item.role, reason },
      successMessage: `${item.displayName}님의 역할을 ${ROLE_DETAILS[role].label}(으)로 변경했습니다.`,
    });
  }

  async function revokeCollaborator(item: WikiCollaborator) {
    const reason = normalizedReason(revokeReason);
    if (!reason) {
      setError(`권한 회수 사유를 ${REASON_MIN_LENGTH}~${REASON_MAX_LENGTH}자로 입력해 주세요.`);
      return;
    }

    const succeeded = await performMutation({
      key: `revoke:${item.profileId}`,
      method: 'DELETE',
      path: `/${encodeURIComponent(item.profileId)}`,
      body: { expectedRole: item.role, reason },
      successMessage: `${item.displayName}님의 서버 위키 협업 권한을 회수했습니다.`,
    });
    if (succeeded) {
      setRevokeProfileId(null);
      setRevokeReason('');
    }
  }

  async function cancelInvitation(item: WikiCollaboratorInvitation) {
    const reason = normalizedReason(invitationReason);
    if (!reason) {
      setError(`초대 취소 사유를 ${REASON_MIN_LENGTH}~${REASON_MAX_LENGTH}자로 입력해 주세요.`);
      return;
    }
    const succeeded = await performMutation({
      key: `cancel-invitation:${item.id}`,
      method: 'DELETE',
      path: `/invitations/${encodeURIComponent(item.id)}`,
      body: { expectedVersion: item.version, reason },
      successMessage: `${item.displayName}님에게 보낸 협업 초대를 취소했습니다.`,
    });
    if (succeeded) {
      setCancelInvitationId(null);
      setInvitationReason('');
    }
  }

  async function resendInvitation(item: WikiCollaboratorInvitation) {
    const reason = normalizedReason(invitationReason);
    if (!reason) {
      setError(`재전송 사유를 ${REASON_MIN_LENGTH}~${REASON_MAX_LENGTH}자로 입력해 주세요.`);
      return;
    }
    const succeeded = await performMutation({
      key: `resend-invitation:${item.id}`,
      method: 'POST',
      path: `/invitations/${encodeURIComponent(item.id)}/resend`,
      body: { expectedVersion: item.version, reason },
      successMessage: `${item.displayName}님에게 협업 초대를 다시 보냈습니다.`,
    });
    if (succeeded) setInvitationReason('');
  }

  if (loading) {
    return (
      <div className="flex min-h-[35vh] flex-col items-center justify-center gap-3 text-sm text-slate-400" role="status" aria-live="polite">
        <Loader2 className="size-6 animate-spin text-emerald-300" aria-hidden="true" />
        협업자 목록을 불러오는 중입니다.
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="space-y-4">
        <StatusMessage tone="error">{error ?? '협업자 목록을 불러오지 못했습니다.'}</StatusMessage>
        <button
          type="button"
          onClick={() => void loadCollaborators({ initial: true })}
          className="btn-secondary min-h-11 gap-2"
        >
          <RefreshCw className="size-4" aria-hidden="true" /> 다시 시도
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-6" aria-busy={busy || refreshing}>
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Wiki Collaborators</p>
        <h2 className="mt-3 text-2xl font-extrabold text-white">서버 위키 협업자</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
          서버 위키 공간의 역할을 사용자명 기준으로 부여합니다. 목록에 없는 계정을 검색하거나 노출하지 않습니다.
        </p>
      </div>

      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {notice ? <StatusMessage tone="success">{notice}</StatusMessage> : null}
      {conflict ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-300/25 bg-amber-400/10 p-4 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span><strong className="block text-amber-50">협업자 정보가 변경되었습니다.</strong>{conflict}</span>
          <button
            type="button"
            onClick={() => void loadCollaborators()}
            disabled={refreshing || busy}
            className="btn-secondary min-h-11 flex-none gap-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> 최신 목록 불러오기
          </button>
        </div>
      ) : null}

      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:p-5" aria-labelledby="collaborator-role-guide">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-emerald-300" aria-hidden="true" />
          <h3 id="collaborator-role-guide" className="font-bold text-white">역할 안내</h3>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {payload.assignableRoles.map((role) => (
            <div key={role} className="rounded-xl border border-white/10 bg-[#0d1219] p-4">
              <strong className="text-sm text-slate-100">{ROLE_DETAILS[role].label}</strong>
              <p className="mt-1 text-xs leading-5 text-slate-400">{ROLE_DETAILS[role].description}</p>
            </div>
          ))}
        </div>
      </section>

      <form onSubmit={(event) => void addCollaborator(event)} className="rounded-2xl border border-emerald-300/20 bg-emerald-400/[0.045] p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300">
            <UserPlus className="size-5" aria-hidden="true" />
          </span>
          <div>
          <h3 className="font-bold text-white">협업자 초대</h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">정확한 사용자명을 직접 입력하세요. 자동 완성이나 계정 검색은 제공하지 않습니다.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(12rem,0.55fr)]">
          <label className="block text-sm font-semibold text-slate-200">
            정확한 사용자명
            <input
              type="text"
              value={addUsername}
              onChange={(event) => setAddUsername(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              disabled={busy || refreshing}
              className="mt-2 min-h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-emerald-300/50 disabled:opacity-60"
              placeholder="예: Steve"
            />
          </label>
          <RoleSelect
            label="부여할 역할"
            value={addRole}
            roles={payload.assignableRoles}
            disabled={busy || refreshing}
            onChange={setAddRole}
          />
          <ReasonField
            label="추가 사유"
            value={addReason}
            onChange={setAddReason}
            disabled={busy || refreshing}
            className="lg:col-span-2"
            placeholder="권한이 필요한 이유를 5자 이상 입력하세요."
          />
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={busy || refreshing || !addUsername.trim() || !isValidReason(addReason)}
            className="btn-primary min-h-11 w-full gap-2 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:min-w-36"
          >
            {mutationKey === 'add' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <UserPlus className="size-4" aria-hidden="true" />}
            초대 보내기
          </button>
        </div>
      </form>

      <section aria-labelledby="pending-invitations-heading">
        <h3 id="pending-invitations-heading" className="text-lg font-bold text-white">응답 대기 중인 초대</h3>
        <p className="mt-1 text-xs text-slate-500">수락 전에는 문서 접근 권한이 생기지 않으며 초대는 7일 뒤 만료됩니다.</p>
        {payload.pendingInvitations.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-white/10 p-5 text-sm text-slate-500">대기 중인 초대가 없습니다.</p>
        ) : (
          <div className="mt-4 grid gap-3">
            {payload.pendingInvitations.map((item) => {
              const expanded = cancelInvitationId === item.id;
              const resending = mutationKey === `resend-invitation:${item.id}`;
              const cancelling = mutationKey === `cancel-invitation:${item.id}`;
              return (
                <article key={item.id} className="rounded-2xl border border-amber-300/15 bg-amber-400/[0.04] p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-bold text-white">{item.displayName} <span className="font-normal text-slate-400">@{item.username}</span></h4>
                        <span className="rounded-full bg-amber-300/10 px-2.5 py-1 text-[11px] font-bold text-amber-200">대기 중 · {ROLE_DETAILS[item.role].label}</span>
                      </div>
                      <p className="mt-2 text-xs text-slate-400">발송 <time dateTime={item.invitedAt}>{formatGrantedAt(item.invitedAt)}</time> · 만료 <time dateTime={item.expiresAt}>{formatGrantedAt(item.expiresAt)}</time></p>
                      <p className="mt-2 text-xs leading-5 text-slate-500">{item.reason}</p>
                    </div>
                    <button type="button" aria-expanded={expanded} aria-controls={`invite-actions-${item.id}`} onClick={() => { setCancelInvitationId(expanded ? null : item.id); setInvitationReason(''); }} disabled={busy || refreshing} className="btn-secondary min-h-11 px-3 disabled:opacity-50">초대 관리</button>
                  </div>
                  {expanded ? (
                    <section id={`invite-actions-${item.id}`} className="mt-4 border-t border-white/10 pt-4">
                      <ReasonField label="관리 사유" value={invitationReason} onChange={setInvitationReason} disabled={busy || refreshing} compact autoFocus placeholder="재전송 또는 취소 사유를 5자 이상 입력하세요." />
                      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:justify-end">
                        <button type="button" onClick={() => void resendInvitation(item)} disabled={busy || refreshing || !isValidReason(invitationReason)} className="btn-secondary min-h-11 gap-2 disabled:opacity-50">{resending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />} 다시 보내기</button>
                        <button type="button" onClick={() => void cancelInvitation(item)} disabled={busy || refreshing || !isValidReason(invitationReason)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 text-sm font-bold text-white disabled:opacity-50">{cancelling ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />} 초대 취소</button>
                      </div>
                    </section>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="collaborator-roster-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 id="collaborator-roster-heading" className="text-lg font-bold text-white">현재 협업자</h3>
            <p className="mt-1 text-xs text-slate-500">{payload.items.length.toLocaleString()}명 · 공간 ID {payload.spaceId}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadCollaborators()}
            disabled={refreshing || busy}
            className="btn-secondary min-h-11 gap-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> 목록 새로고침
          </button>
        </div>

        {payload.items.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-5 py-12 text-center">
            <Users className="mx-auto size-8 text-slate-600" aria-hidden="true" />
            <p className="mt-4 font-semibold text-slate-200">등록된 협업자가 없습니다.</p>
            <p className="mt-1 text-sm text-slate-500">위 양식에서 정확한 사용자명과 역할을 입력해 첫 협업자를 추가하세요.</p>
          </div>
        ) : (
          <div className="mt-4 grid gap-4">
            {payload.items.map((item) => {
              const selectedRole = roleDrafts[item.profileId] ?? item.role;
              const updateReason = reasonDrafts[item.profileId] ?? '';
              const updating = mutationKey === `update:${item.profileId}`;
              const revoking = mutationKey === `revoke:${item.profileId}`;
              const showingRevoke = revokeTarget?.profileId === item.profileId;

              return (
                <article key={item.profileId} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="truncate font-bold text-white">{item.displayName}</h4>
                        <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-300">{ROLE_DETAILS[item.role].label}</span>
                      </div>
                      <p className="mt-1 break-all text-sm text-slate-400">@{item.username}</p>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        <time dateTime={item.grantedAt}>{formatGrantedAt(item.grantedAt)}</time> · {item.grantedByName}님이 부여
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setRevokeProfileId(showingRevoke ? null : item.profileId);
                        setRevokeReason('');
                        setError(null);
                        setNotice(null);
                      }}
                      aria-expanded={showingRevoke}
                      disabled={busy || refreshing}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300/20 bg-red-500/[0.06] px-3 text-sm font-semibold text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 className="size-4" aria-hidden="true" /> 권한 회수
                    </button>
                  </div>

                  <form onSubmit={(event) => void updateCollaborator(event, item)} className="mt-5 grid gap-4 border-t border-white/10 pt-5 lg:grid-cols-[minmax(12rem,0.55fr)_minmax(0,1fr)_auto] lg:items-end">
                    <RoleSelect
                      label="역할 변경"
                      value={selectedRole}
                      roles={payload.assignableRoles}
                      disabled={busy || refreshing}
                      onChange={(role) => setRoleDrafts((current) => ({ ...current, [item.profileId]: role }))}
                    />
                    <ReasonField
                      label="변경 사유"
                      value={updateReason}
                      onChange={(value) => setReasonDrafts((current) => ({ ...current, [item.profileId]: value }))}
                      disabled={busy || refreshing}
                      compact
                      placeholder="역할 변경 사유를 5자 이상 입력하세요."
                    />
                    <button
                      type="submit"
                      disabled={busy || refreshing || selectedRole === item.role || !isValidReason(updateReason)}
                      className="btn-secondary min-h-11 min-w-28 gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {updating ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
                      역할 저장
                    </button>
                  </form>

                  {showingRevoke ? (
                    <section className="mt-5 rounded-xl border border-red-300/25 bg-red-500/[0.07] p-4" aria-labelledby={`revoke-title-${item.profileId}`}>
                      <h5 id={`revoke-title-${item.profileId}`} className="font-bold text-red-100">{item.displayName}님의 권한 회수 확인</h5>
                      <p className="mt-1 text-xs leading-5 text-red-100/70">이 작업은 즉시 적용됩니다. 회수할 사용자가 맞는지 확인하고 감사 기록에 남길 사유를 입력하세요.</p>
                      <div className="mt-4">
                        <ReasonField
                          label="권한 회수 사유"
                          value={revokeReason}
                          onChange={setRevokeReason}
                          disabled={busy || refreshing}
                          autoFocus
                          compact
                          placeholder="권한을 회수하는 이유를 5자 이상 입력하세요."
                        />
                      </div>
                      <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            setRevokeProfileId(null);
                            setRevokeReason('');
                          }}
                          disabled={busy}
                          className="btn-secondary min-h-11 px-4 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          취소
                        </button>
                        <button
                          type="button"
                          onClick={() => void revokeCollaborator(item)}
                          disabled={busy || refreshing || !isValidReason(revokeReason)}
                          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 text-sm font-bold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {revoking ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
                          권한 회수 확인
                        </button>
                      </div>
                    </section>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}

function RoleSelect({
  label,
  value,
  roles,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: CollaboratorRole;
  readonly roles: readonly CollaboratorRole[];
  readonly disabled: boolean;
  readonly onChange: (role: CollaboratorRole) => void;
}) {
  return (
    <label className="block text-sm font-semibold text-slate-200">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as CollaboratorRole)}
        disabled={disabled}
        className="mt-2 min-h-11 w-full rounded-lg border border-white/10 bg-[#0d1219] px-3 text-sm text-white outline-none focus:border-emerald-300/50 disabled:opacity-60"
      >
        {roles.map((role) => <option key={role} value={role}>{ROLE_DETAILS[role].label}</option>)}
      </select>
      <span className="mt-1.5 block text-xs font-normal leading-5 text-slate-500">{ROLE_DETAILS[value].description}</span>
    </label>
  );
}

function ReasonField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  className,
  compact = false,
  autoFocus = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly className?: string;
  readonly compact?: boolean;
  readonly autoFocus?: boolean;
}) {
  const trimmedLength = value.trim().length;
  const invalid = value.length > 0 && !isValidReason(value);
  return (
    <label className={`block text-sm font-semibold text-slate-200 ${className ?? ''}`}>
      <span className="flex items-center justify-between gap-3">
        <span>{label} <span className="text-red-300" aria-hidden="true">*</span></span>
        <span className={`text-[11px] font-normal ${invalid ? 'text-red-300' : 'text-slate-500'}`}>{trimmedLength} / {REASON_MAX_LENGTH}자</span>
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minLength={REASON_MIN_LENGTH}
        maxLength={REASON_MAX_LENGTH}
        required
        disabled={disabled}
        autoFocus={autoFocus}
        rows={compact ? 2 : 3}
        className="mt-2 min-h-11 w-full resize-y rounded-lg border border-white/10 bg-[#0d1219] px-3 py-2.5 text-sm leading-5 text-white outline-none placeholder:text-slate-600 focus:border-emerald-300/50 disabled:opacity-60"
        placeholder={placeholder}
      />
      <span className={`mt-1.5 block text-xs font-normal ${invalid ? 'text-red-300' : 'text-slate-500'}`}>필수 · 공백 제외 {REASON_MIN_LENGTH}~{REASON_MAX_LENGTH}자</span>
    </label>
  );
}

function StatusMessage({ tone, children }: { readonly tone: 'error' | 'success'; readonly children: React.ReactNode }) {
  const error = tone === 'error';
  return (
    <div
      className={`flex gap-3 rounded-xl border p-4 text-sm ${error ? 'border-red-300/20 bg-red-500/10 text-red-100' : 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'}`}
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
    >
      {error ? <AlertTriangle className="mt-0.5 size-4 flex-none" aria-hidden="true" /> : <CheckCircle2 className="mt-0.5 size-4 flex-none" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

function isCollaboratorRole(value: unknown): value is CollaboratorRole {
  return value === 'manager' || value === 'editor' || value === 'reviewer';
}

function parsePayload(value: unknown): WikiCollaboratorsPayload {
  if (!isRecord(value)
    || typeof value.serverId !== 'string'
    || typeof value.spaceId !== 'string'
    || !Array.isArray(value.assignableRoles)
    || value.assignableRoles.length === 0
    || !value.assignableRoles.every(isCollaboratorRole)
    || !Array.isArray(value.items)
    || !value.items.every(isCollaborator)
    || !Array.isArray(value.pendingInvitations)
    || !value.pendingInvitations.every(isInvitation)) {
    throw new Error('협업자 목록 응답 형식이 올바르지 않습니다.');
  }
  return value as unknown as WikiCollaboratorsPayload;
}

function isInvitation(value: unknown): value is WikiCollaboratorInvitation {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.profileId === 'string'
    && typeof value.username === 'string'
    && typeof value.displayName === 'string'
    && isCollaboratorRole(value.role)
    && typeof value.reason === 'string'
    && typeof value.invitedAt === 'string'
    && typeof value.expiresAt === 'string'
    && typeof value.resendCount === 'number'
    && typeof value.version === 'number';
}

function isCollaborator(value: unknown): value is WikiCollaborator {
  return isRecord(value)
    && typeof value.profileId === 'string'
    && typeof value.username === 'string'
    && typeof value.displayName === 'string'
    && isCollaboratorRole(value.role)
    && typeof value.grantedAt === 'string'
    && typeof value.grantedByName === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function apiErrorMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.message === 'string' && value.message.trim()) return value.message;
  if (Array.isArray(value.message)) {
    const message = value.message.filter((item): item is string => typeof item === 'string').join(' ');
    if (message) return message;
  }
  return fallback;
}

function normalizedReason(value: string): string | null {
  const reason = value.trim();
  return reason.length >= REASON_MIN_LENGTH && reason.length <= REASON_MAX_LENGTH ? reason : null;
}

function isValidReason(value: string): boolean {
  return normalizedReason(value) !== null;
}

function formatGrantedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? GRANTED_AT_FORMAT.format(timestamp) : '부여 시각 기록 없음';
}
