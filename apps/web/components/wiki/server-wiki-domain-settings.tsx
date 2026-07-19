'use client';

import { CheckCircle2, Copy, Globe2, Loader2, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

type DomainStatus = 'pending' | 'verified' | 'provisioning' | 'active' | 'disabled';

interface DomainBinding {
  readonly hostname: string;
  readonly status: DomainStatus;
  readonly version: number;
  readonly challenge: { readonly name: string; readonly value: string | null; readonly expiresAt: string };
  readonly routing: { readonly type: 'CNAME'; readonly name: string; readonly value: string };
  readonly verifiedAt: string | null;
  readonly activatedAt: string | null;
  readonly tlsReadyAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly consecutiveFailures: number;
}

export function ServerWikiDomainSettings({ serverId }: { readonly serverId: string }) {
  const apiBase = normalizeApiBaseUrl();
  const [domain, setDomain] = useState<DomainBinding | null>(null);
  const [hostname, setHostname] = useState('');
  const [disableReason, setDisableReason] = useState('');
  const [disableConfirmation, setDisableConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'save' | 'verify' | 'disable' | null>(null);
  const [message, setMessage] = useState<{ readonly tone: 'error' | 'success'; readonly text: string } | null>(null);

  async function load() {
    setLoading(true); setMessage(null);
    try {
      const response = await fetch(`${apiBase}/v1/servers/${encodeURIComponent(serverId)}/wiki-domain`, { credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '커스텀 도메인 설정을 불러오지 못했습니다.');
      const next = (body.domain ?? null) as DomainBinding | null;
      setDomain(next); setHostname(next?.hostname ?? '');
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '커스텀 도메인 설정을 불러오지 못했습니다.' });
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [apiBase, serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function configure() {
    if (!hostname.trim() || working) return;
    setWorking('save'); setMessage(null);
    try {
      const response = await fetch(`${apiBase}/v1/servers/${encodeURIComponent(serverId)}/wiki-domain`, {
        method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ hostname: hostname.trim(), expectedVersion: domain?.version ?? 0 }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(domainError(body, '도메인을 저장하지 못했습니다.'));
      setDomain(body.domain); setHostname(body.domain.hostname);
      setMessage({ tone: 'success', text: 'DNS 확인 값을 발급했습니다. TXT 값은 지금 한 번만 표시되므로 DNS에 바로 등록하세요.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '도메인을 저장하지 못했습니다.' });
    } finally { setWorking(null); }
  }

  async function verify() {
    if (!domain || working) return;
    setWorking('verify'); setMessage(null);
    try {
      const response = await fetch(`${apiBase}/v1/servers/${encodeURIComponent(serverId)}/wiki-domain/verify`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: domain.version }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(domainError(body, 'DNS 확인에 실패했습니다.'));
      setDomain(body.domain);
      setMessage({ tone: 'success', text: 'DNS 소유권과 라우팅을 확인했습니다. TLS 인증서 준비가 끝나면 자동으로 공개됩니다.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'DNS 확인에 실패했습니다.' });
    } finally { setWorking(null); }
  }

  async function disable() {
    if (!domain || disableConfirmation !== domain.hostname || disableReason.trim().length < 5 || working) return;
    setWorking('disable'); setMessage(null);
    try {
      const response = await fetch(`${apiBase}/v1/servers/${encodeURIComponent(serverId)}/wiki-domain`, {
        method: 'DELETE', credentials: 'include',
        headers: { 'content-type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: domain.version, reason: disableReason.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(domainError(body, '도메인을 비활성화하지 못했습니다.'));
      setDomain(body.domain); setDisableReason(''); setDisableConfirmation('');
      setMessage({ tone: 'success', text: '커스텀 도메인을 비활성화했습니다. 해당 Host는 즉시 404로 응답합니다.' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '도메인을 비활성화하지 못했습니다.' });
    } finally { setWorking(null); }
  }

  if (loading) return <div className="grid min-h-56 place-items-center"><Loader2 className="size-6 animate-spin text-emerald-300" aria-label="도메인 설정 불러오는 중" /></div>;

  return (
    <section className="space-y-6">
      <header className="rounded-2xl border border-sky-300/20 bg-gradient-to-br from-sky-400/[0.09] to-emerald-400/[0.04] p-5 sm:p-6">
        <div className="flex items-start gap-4"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-sky-300/10 text-sky-200"><Globe2 className="size-5" /></span><div><h2 className="text-xl font-bold text-white">커스텀 도메인</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">GitBook처럼 <code className="text-sky-200">docs.example.com</code>에서 공개 릴리스를 제공합니다. 편집·ACL·로그인은 MineWiki 본 도메인에만 유지됩니다.</p></div></div>
      </header>
      {message ? <p role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-4 text-sm ${message.tone === 'error' ? 'border-red-300/20 bg-red-400/10 text-red-100' : 'border-emerald-300/20 bg-emerald-400/10 text-emerald-100'}`}>{message.text}</p> : null}
      <section className="rounded-xl border border-white/10 bg-white/[0.025] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-white">1. 도메인 연결</h3><p className="mt-1 text-xs leading-5 text-slate-500">루트 도메인 대신 문서용 하위 도메인을 권장합니다.</p></div>{domain ? <StatusBadge status={domain.status} /> : null}</div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row"><label className="min-w-0 flex-1 text-sm text-slate-300"><span className="sr-only">커스텀 호스트 이름</span><input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="docs.example.com" autoCapitalize="none" autoCorrect="off" className="input min-h-11 w-full font-mono" /></label><button type="button" onClick={() => void configure()} disabled={!hostname.trim() || working !== null || (domain?.status !== 'disabled' && hostname.trim().toLowerCase() === domain?.hostname)} className="btn-primary min-h-11 shrink-0 disabled:opacity-50">{working === 'save' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}확인 값 발급</button></div>
      </section>
      {domain ? <>
        <section className="rounded-xl border border-white/10 bg-white/[0.025] p-5"><h3 className="font-semibold text-white">2. DNS 레코드</h3><p className="mt-1 text-xs leading-5 text-slate-500">TXT로 소유권을 확인하고 CNAME으로 MineWiki 문서 ingress를 연결합니다.</p><div className="mt-4 grid gap-3"><DnsRecord type="TXT" name={domain.challenge.name} value={domain.challenge.value} /><DnsRecord type="CNAME" name={domain.routing.name} value={domain.routing.value} /></div>{!domain.challenge.value && domain.status === 'pending' ? <p className="mt-3 text-xs text-amber-200">보안상 TXT 값은 다시 표시되지 않습니다. 복사하지 못했다면 같은 도메인을 다시 저장해 새 값을 발급하세요.</p> : null}<button type="button" onClick={() => void verify()} disabled={working !== null || domain.status === 'disabled' || domain.status === 'active'} className="btn-secondary mt-4 min-h-11 disabled:opacity-50">{working === 'verify' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}DNS 확인</button></section>
        <section className="rounded-xl border border-white/10 bg-white/[0.025] p-5"><h3 className="flex items-center gap-2 font-semibold text-white"><ShieldCheck className="size-4 text-emerald-300" />3. TLS 및 공개 상태</h3><div className="mt-4 grid gap-3 sm:grid-cols-3"><State label="DNS 소유권" ready={Boolean(domain.verifiedAt)} /><State label="TLS 인증서" ready={Boolean(domain.tlsReadyAt)} /><State label="공개 라우팅" ready={domain.status === 'active'} /></div><p className="mt-4 text-xs leading-5 text-slate-500">활성화 후에도 소유권과 라우팅을 주기적으로 재확인합니다. 연속 실패 시 도메인은 자동 비활성화됩니다.{domain.lastCheckedAt ? ` 최근 확인: ${formatDate(domain.lastCheckedAt)}` : ''}</p>{domain.status === 'active' ? <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer" className="btn-primary mt-4 inline-flex min-h-11">사이트 열기</a> : null}</section>
        {domain.status !== 'disabled' ? <details className="rounded-xl border border-red-300/15 bg-red-400/[0.03] p-5"><summary className="cursor-pointer font-semibold text-red-100">도메인 비활성화</summary><div className="mt-4 grid gap-3"><input value={disableReason} onChange={(event) => setDisableReason(event.target.value)} maxLength={500} placeholder="비활성화 사유 (5자 이상)" className="input min-h-11" /><input value={disableConfirmation} onChange={(event) => setDisableConfirmation(event.target.value)} placeholder={`확인: ${domain.hostname}`} className="input min-h-11 font-mono" /><button type="button" onClick={() => void disable()} disabled={working !== null || disableReason.trim().length < 5 || disableConfirmation !== domain.hostname} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300/30 px-4 text-sm font-semibold text-red-100 disabled:opacity-40"><Trash2 className="size-4" />비활성화</button></div></details> : null}
      </> : null}
    </section>
  );
}

function DnsRecord({ type, name, value }: { readonly type: string; readonly name: string; readonly value: string | null }) {
  return <div className="grid gap-2 rounded-lg border border-white/10 bg-[#0d1219] p-4 sm:grid-cols-[5rem_minmax(0,1fr)_minmax(0,1.3fr)] sm:items-center"><span className="text-xs font-bold text-sky-200">{type}</span><code className="break-all text-xs text-slate-300">{name}</code><div className="flex min-w-0 items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs text-white">{value ?? '보안상 다시 표시되지 않음'}</code>{value ? <button type="button" onClick={() => void navigator.clipboard.writeText(value)} className="grid size-10 shrink-0 place-items-center rounded-lg hover:bg-white/10" aria-label={`${type} 값 복사`}><Copy className="size-4" /></button> : null}</div></div>;
}

function State({ label, ready }: { readonly label: string; readonly ready: boolean }) {
  return <div className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${ready ? 'border-emerald-300/20 bg-emerald-400/[0.06] text-emerald-100' : 'border-white/10 bg-black/10 text-slate-400'}`}>{ready ? <CheckCircle2 className="size-4" /> : <span className="size-4 rounded-full border border-current" />}{label}</div>;
}

function StatusBadge({ status }: { readonly status: DomainStatus }) {
  const labels: Record<DomainStatus, string> = { pending: 'DNS 대기', verified: 'DNS 확인됨', provisioning: 'TLS 준비 중', active: '활성', disabled: '비활성' };
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${status === 'active' ? 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100' : 'border-white/10 bg-white/[0.04] text-slate-300'}`}>{labels[status]}</span>;
}

function domainError(body: { readonly message?: unknown; readonly code?: unknown }, fallback: string): string {
  if (body.code === 'SERVER_WIKI_DOMAIN_DNS_NOT_READY') return 'TXT 소유권 또는 CNAME 라우팅이 아직 확인되지 않았습니다. DNS 전파 후 다시 시도하세요.';
  return typeof body.message === 'string' ? body.message : fallback;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
}
