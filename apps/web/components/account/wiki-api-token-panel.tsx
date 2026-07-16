'use client';

import {
  Check,
  Clipboard,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  createWikiApiToken,
  listWikiApiTokens,
  listWikiApiTokenSpaces,
  revokeWikiApiToken,
  type WikiApiTokenCreated,
  type WikiApiTokenScope,
  type WikiApiTokenSpace,
  type WikiApiTokenSummary,
} from '../../lib/wiki-api';

const SCOPE_OPTIONS: ReadonlyArray<{
  readonly value: WikiApiTokenScope;
  readonly label: string;
  readonly description: string;
}> = [
  { value: 'wiki:read', label: '문서 읽기', description: '경로 조회와 원문 가져오기' },
  { value: 'wiki:create', label: '문서 만들기', description: '새 Wiki 문서 생성' },
  { value: 'wiki:edit', label: '문서 편집', description: '기존 문서의 새 리비전 저장' },
];

export function WikiApiTokenPanel() {
  const [tokens, setTokens] = useState<WikiApiTokenSummary[]>([]);
  const [spaces, setSpaces] = useState<WikiApiTokenSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<WikiApiTokenScope[]>(['wiki:read']);
  const [spaceId, setSpaceId] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [createdToken, setCreatedToken] = useState<WikiApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const activeCount = useMemo(
    () => tokens.filter((token) => token.status === 'active').length,
    [tokens],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextTokens, nextSpaces] = await Promise.all([
          listWikiApiTokens(),
          listWikiApiTokenSpaces(),
        ]);
        if (!cancelled) {
          setTokens(nextTokens);
          setSpaces(nextSpaces);
        }
      } catch (problem) {
        if (!cancelled) {
          setError(problem instanceof Error ? problem.message : 'Wiki API 토큰을 불러오지 못했습니다.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleScope = (scope: WikiApiTokenScope) => {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (working || !name.trim() || scopes.length === 0) return;
    setWorking(true);
    setError(null);
    setCreatedToken(null);
    setCopied(false);
    try {
      const created = await createWikiApiToken({
        name: name.trim(),
        scopes,
        spaceId: spaceId || undefined,
        expiresInDays,
      });
      setCreatedToken(created);
      setTokens((current) => [created, ...current.filter((token) => token.id !== created.id)]);
      setName('');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Wiki API 토큰을 만들지 못했습니다.');
    } finally {
      setWorking(false);
    }
  };

  const copyToken = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      setCopied(true);
    } catch {
      setError('토큰을 복사하지 못했습니다. 직접 선택해 복사해 주세요.');
    }
  };

  const revoke = async (token: WikiApiTokenSummary) => {
    if (revokingId || !window.confirm(`“${token.name}” 토큰을 즉시 폐기할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    setRevokingId(token.id);
    setError(null);
    try {
      await revokeWikiApiToken(token.id);
      setTokens((current) => current.map((item) => item.id === token.id
        ? { ...item, status: 'revoked' }
        : item));
      if (createdToken?.id === token.id) setCreatedToken(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '토큰을 폐기하지 못했습니다.');
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section className="mb-6 rounded-lg border border-[#30363d] bg-[#181a1d] p-4 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-white">
            <KeyRound className="h-5 w-5 text-[#13ec80]" />
            Wiki API 토큰
          </h3>
          <p className="mt-1 text-xs leading-5 text-[#8f98a3]">
            GitHub Actions와 서버 봇이 Wiki 문서를 동기화할 때 사용합니다. 브라우저 로그인이나 관리자 권한을 대신하지 않습니다.
          </p>
        </div>
        <span className="w-fit rounded-full border border-[#13ec80]/25 bg-[#13ec80]/10 px-3 py-1 text-xs font-semibold text-[#71f5b1]">
          활성 {activeCount}개
        </span>
      </div>

      {createdToken ? (
        <div className="mt-5 rounded-xl border border-amber-300/35 bg-amber-300/10 p-4" role="alert">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="flex items-center gap-2 font-bold text-amber-100">
                <ShieldCheck className="h-4 w-4" /> 토큰을 지금 저장하세요
              </h4>
              <p className="mt-1 text-xs leading-5 text-amber-100/80">
                이 값은 다시 표시되지 않습니다. GitHub Actions Secrets 같은 비밀 저장소에 보관하세요.
              </p>
            </div>
            <button type="button" onClick={() => setCreatedToken(null)} className="rounded-md p-1.5 text-amber-100/70 hover:bg-white/10 hover:text-amber-50" aria-label="일회성 토큰 닫기">
              <X className="h-4 w-4" />
            </button>
          </div>
          <code className="mt-3 block select-all break-all rounded-lg border border-amber-100/20 bg-black/25 p-3 font-mono text-xs leading-5 text-amber-50">
            {createdToken.token}
          </code>
          <button type="button" onClick={() => void copyToken()} className="mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-amber-100/30 px-3 py-2 text-xs font-semibold text-amber-50">
            {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            {copied ? '복사 완료' : '토큰 복사'}
          </button>
        </div>
      ) : null}

      <form className="mt-5 rounded-lg border border-[#30363d] bg-[#111315] p-4" onSubmit={create}>
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold text-[#c5ccd3]">토큰 이름</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder="예: 서버 규칙 배포" className="mt-1.5 w-full rounded-lg border border-[#3a424a] bg-[#0d0f11] px-3 py-2.5 text-sm text-white outline-none placeholder:text-[#6f7882] focus:border-[#13ec80]" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-semibold text-[#c5ccd3]">Wiki 공간 제한</span>
              <select value={spaceId} onChange={(event) => setSpaceId(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[#3a424a] bg-[#0d0f11] px-3 py-2.5 text-sm text-white outline-none focus:border-[#13ec80]">
                <option value="">모든 공간</option>
                {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-[#c5ccd3]">만료</span>
              <select value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} className="mt-1.5 w-full rounded-lg border border-[#3a424a] bg-[#0d0f11] px-3 py-2.5 text-sm text-white outline-none focus:border-[#13ec80]">
                <option value={30}>30일</option>
                <option value={90}>90일</option>
                <option value={180}>180일</option>
                <option value={365}>1년</option>
              </select>
            </label>
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-[#c5ccd3]">최소 권한 선택</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {SCOPE_OPTIONS.map((option) => {
              const checked = scopes.includes(option.value);
              return (
                <label key={option.value} className={`cursor-pointer rounded-lg border p-3 transition ${checked ? 'border-[#13ec80]/40 bg-[#13ec80]/10' : 'border-[#30363d] bg-black/10'}`}>
                  <span className="flex items-center gap-2 text-xs font-semibold text-white">
                    <input type="checkbox" checked={checked} onChange={() => toggleScope(option.value)} className="h-4 w-4 accent-[#13ec80]" />
                    {option.label}
                  </span>
                  <span className="mt-1 block text-[11px] leading-4 text-[#8f98a3]">{option.description}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-5 text-[#8f98a3]">생성은 최근 15분 이내 로그인 또는 다중 인증 세션에서만 허용됩니다.</p>
          <button type="submit" disabled={working || loading || !name.trim() || scopes.length === 0} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#13ec80] px-4 py-2.5 text-sm font-bold text-[#07130d] disabled:cursor-not-allowed disabled:opacity-45">
            {working ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Plus className="h-4 w-4" />}
            {working ? '만드는 중' : '새 토큰 만들기'}
          </button>
        </div>
      </form>

      {error ? <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200" role="alert">{error}</p> : null}

      <div className="mt-5 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-[#8f98a3]" role="status"><Loader2 className="h-4 w-4 animate-spin text-[#13ec80] motion-reduce:animate-none" />토큰을 불러오는 중입니다.</div>
        ) : tokens.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[#3a424a] px-4 py-5 text-center text-sm text-[#8f98a3]">아직 만든 Wiki API 토큰이 없습니다.</p>
        ) : tokens.map((token) => (
          <div key={token.id} className="flex flex-col gap-3 rounded-lg border border-[#30363d] bg-[#111315] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-semibold text-white">{token.name}</p>
                <TokenStatus status={token.status} />
              </div>
              <p className="mt-1 break-all font-mono text-[11px] text-[#8f98a3]">mwk_{token.tokenPrefix}_••••••••</p>
              <p className="mt-1 text-[11px] leading-5 text-[#8f98a3]">
                {token.scopes.join(' · ')} · {token.space?.name ?? '모든 Wiki 공간'} · 만료 {formatDate(token.expiresAt)}
                {token.lastUsedAt ? ` · 최근 사용 ${formatDate(token.lastUsedAt)}` : ' · 사용 기록 없음'}
              </p>
            </div>
            {token.status === 'active' ? (
              <button type="button" onClick={() => void revoke(token)} disabled={revokingId !== null} className="inline-flex min-h-10 flex-shrink-0 items-center justify-center gap-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-50">
                {revokingId === token.id ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-4 w-4" />}
                즉시 폐기
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function TokenStatus({ status }: { readonly status: string }) {
  const label = status === 'active' ? '활성' : status === 'expired' ? '만료' : status === 'revoked' ? '폐기됨' : status;
  const tone = status === 'active'
    ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
    : 'border-white/10 bg-white/[0.04] text-[#8f98a3]';
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{label}</span>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(new Date(value));
}
