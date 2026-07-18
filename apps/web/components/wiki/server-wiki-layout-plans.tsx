'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, CreditCard, Crown, Loader2, LockKeyhole, Settings2 } from 'lucide-react';

import { csrfHeaders } from '../../lib/csrf';
import { billingActionError, billingSupportHref, validatedPaddleRedirectUrl } from '../../lib/paddle-billing-client.mjs';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { PrivilegedActionGate } from '../auth/privileged-action-gate';

interface LayoutSettings {
  readonly selected: 'docs' | 'handbook' | 'brand';
  readonly layouts: ReadonlyArray<{
    readonly key: 'docs' | 'handbook' | 'brand';
    readonly conceptNumber: 1 | 2 | 3;
    readonly name: string;
    readonly description: string;
    readonly tier: 'free' | 'premium';
    readonly entitled: boolean;
    readonly entitlementExpiresAt: string | null;
  }>;
}

interface BillingAvailability {
  readonly onlineCheckout: boolean;
  readonly portalAvailable: boolean;
  readonly environment: 'sandbox' | 'production';
}

type PremiumLayoutKey = Exclude<LayoutSettings['selected'], 'docs'>;

export function ServerWikiLayoutPlans({ serverId }: { readonly serverId: string }) {
  return (
    <PrivilegedActionGate
      purpose="server_admin"
      title="서버 위키 레이아웃 관리 잠금 해제"
      description="유료 레이아웃 권한과 서버 위키 표시 설정을 변경하려면 다중 인증으로 서버 관리 권한을 다시 확인해 주세요."
    >
      <ServerWikiLayoutPlansContent serverId={serverId} />
    </PrivilegedActionGate>
  );
}

export function ServerWikiLayoutPlansContent({ serverId }: { readonly serverId: string }) {
  const [settings, setSettings] = useState<LayoutSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingAvailability | null>(null);
  const [billingAction, setBillingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = normalizeApiBaseUrl();

  useEffect(() => {
    let active = true;
    fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-layouts`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('서버 위키 레이아웃을 불러오지 못했습니다.');
        return response.json() as Promise<LayoutSettings>;
      })
      .then((value) => { if (active) setSettings(value); })
      .catch((value) => { if (active) setError(value instanceof Error ? value.message : '레이아웃을 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/billing/availability`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('온라인 결제 상태를 확인하지 못했습니다.');
        return response.json() as Promise<BillingAvailability>;
      })
      .then((value) => { if (active) setBilling(value); })
      .catch(() => { if (active) setBilling(null); });
    return () => { active = false; };
  }, [baseUrl, serverId]);

  async function selectLayout(layoutKey: LayoutSettings['selected']) {
    setSaving(layoutKey); setError(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-layout`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ layoutKey }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '레이아웃을 변경하지 못했습니다.');
      setSettings((current) => current ? { ...current, selected: layoutKey } : current);
    } catch (value) {
      setError(value instanceof Error ? value.message : '레이아웃을 변경하지 못했습니다.');
    } finally { setSaving(null); }
  }

  async function openBilling(action: 'checkout' | 'portal', layoutKey?: PremiumLayoutKey) {
    const actionKey = layoutKey ? `${action}:${layoutKey}` : action;
    setBillingAction(actionKey);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/billing/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: action === 'checkout' ? JSON.stringify({ layoutKey }) : '{}',
      });
      const body = await response.json().catch(() => ({})) as { checkoutUrl?: unknown; portalUrl?: unknown; message?: unknown };
      if (!response.ok) {
        throw new Error(billingActionError(response.status, action, body.message));
      }
      const target = validatedPaddleRedirectUrl(
        action === 'checkout' ? body.checkoutUrl : body.portalUrl,
        action,
        window.location.origin,
      );
      if (!target) throw new Error('Paddle가 안전하지 않은 이동 주소를 반환해 요청을 중단했습니다.');
      window.location.assign(target);
    } catch (value) {
      setError(value instanceof Error ? value.message : '결제 요청을 완료하지 못했습니다.');
    } finally {
      setBillingAction(null);
    }
  }

  if (loading) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;
  if (!settings) return <div className="rounded-xl border border-red-300/20 bg-red-500/10 p-5 text-sm text-red-100">{error}</div>;

  return (
    <div className="space-y-8">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Server Wiki Layouts</p>
          {billing?.onlineCheckout && billing.environment === 'sandbox' ? <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[11px] font-bold text-amber-200">Paddle 테스트 모드 · 실제 청구 없음</span> : null}
        </div>
        <h1 className="mt-3 text-3xl font-extrabold text-white">서버 위키 레이아웃</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-400">3번 Docs는 모든 서버에 무료로 제공됩니다. 1번 Handbook과 2번 Brand는 요금제 권한이 활성화된 서버에서 선택할 수 있습니다.</p>
      </header>
      {error ? <div className="rounded-lg border border-red-300/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div> : null}
      {billing?.portalAvailable ? (
        <section className="surface-flat flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 font-semibold text-white"><CreditCard className="size-4 text-emerald-300" />Paddle 결제 관리</p>
            <p className="mt-1 text-sm leading-6 text-slate-400">결제 수단, 청구 내역과 구독 변경·해지를 Paddle 고객 포털에서 관리합니다.</p>
          </div>
          <button type="button" onClick={() => void openBilling('portal')} disabled={billingAction !== null} className="btn-secondary min-h-11 shrink-0 gap-2 disabled:opacity-50">
            {billingAction === 'portal' ? <Loader2 className="size-4 animate-spin" /> : <Settings2 className="size-4" />}결제 관리 열기
          </button>
        </section>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-3">
        {settings.layouts.map((layout) => {
          const selected = settings.selected === layout.key;
          return (
            <article key={layout.key} className={`overflow-hidden rounded-2xl border bg-[#10161e] ${selected ? 'border-emerald-300/60 shadow-xl shadow-emerald-950/30' : 'border-white/10'}`}>
              <div className="relative aspect-[3/2] bg-black"><Image src={`/design/server-wiki/concept-${layout.conceptNumber}.png`} alt={`${layout.conceptNumber}번 ${layout.name} 레이아웃`} fill sizes="(min-width:1280px) 33vw, 100vw" className="object-cover" /></div>
              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div><p className="text-xs font-semibold text-emerald-300">시안 {layout.conceptNumber}</p><h2 className="mt-1 text-xl font-bold text-white">{layout.name}</h2></div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${layout.tier === 'free' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-violet-400/10 text-violet-300'}`}>{layout.tier === 'free' ? '무료 기본' : '프리미엄'}</span>
                </div>
                <p className="mt-3 min-h-12 text-sm leading-6 text-slate-400">{layout.description}</p>
                {layout.tier === 'premium' && layout.entitled ? <p className="mt-3 text-xs text-violet-200">{formatEntitlement(layout.entitlementExpiresAt)}</p> : null}
                <LayoutPlanAction
                  layout={layout}
                  selected={selected}
                  saving={saving}
                  billing={billing}
                  billingAction={billingAction}
                  serverId={serverId}
                  onSelect={selectLayout}
                  onCheckout={(layoutKey) => void openBilling('checkout', layoutKey)}
                />
              </div>
            </article>
          );
        })}
      </div>
      <p className="text-xs leading-5 text-slate-500">결제를 시작하기 전 Paddle 화면에서 최종 금액과 청구 주기를 확인해 주세요. 온라인 결제가 열리지 않으면 지원 요청으로 문의할 수 있습니다.</p>
    </div>
  );
}

function LayoutPlanAction({ layout, selected, saving, billing, billingAction, serverId, onSelect, onCheckout }: {
  readonly layout: LayoutSettings['layouts'][number];
  readonly selected: boolean;
  readonly saving: string | null;
  readonly billing: BillingAvailability | null;
  readonly billingAction: string | null;
  readonly serverId: string;
  readonly onSelect: (layoutKey: LayoutSettings['selected']) => Promise<void>;
  readonly onCheckout: (layoutKey: PremiumLayoutKey) => void;
}) {
  const layoutKey = layout.key;
  if (selected) return <div className="mt-5 flex h-11 items-center justify-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-400/10 text-sm font-semibold text-emerald-300"><Check className="size-4" />현재 사용 중</div>;
  if (layout.entitled) return <button type="button" onClick={() => void onSelect(layoutKey)} disabled={Boolean(saving) || billingAction !== null} className="btn-primary mt-5 h-11 w-full gap-2 disabled:opacity-50">{saving === layoutKey ? <Loader2 className="size-4 animate-spin" /> : <Crown className="size-4" />}이 레이아웃 사용</button>;
  if (isPremiumLayoutKey(layoutKey) && billing?.onlineCheckout) {
    const pending = billingAction === `checkout:${layoutKey}`;
    return <button type="button" onClick={() => onCheckout(layoutKey)} disabled={billingAction !== null || Boolean(saving)} className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-violet-300/30 bg-violet-400/10 text-sm font-semibold text-violet-200 transition hover:bg-violet-400/15 disabled:opacity-50">{pending ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}{billing.environment === 'sandbox' ? '테스트 결제 시작' : '요금제 결제'}</button>;
  }
  if (layoutKey === 'docs') return null;
  return <Link href={billingSupportHref(serverId, layoutKey)} className="mt-5 flex h-11 items-center justify-center gap-2 rounded-lg border border-violet-300/30 bg-violet-400/10 text-sm font-semibold text-violet-200 transition hover:bg-violet-400/15"><LockKeyhole className="size-4" />요금제 문의</Link>;
}

function isPremiumLayoutKey(layoutKey: LayoutSettings['selected']): layoutKey is PremiumLayoutKey {
  return layoutKey === 'handbook' || layoutKey === 'brand';
}

function formatEntitlement(expiresAt: string | null): string {
  if (!expiresAt) return '현재 이용 가능';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '현재 이용 가능';
  return `${date.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 이용 가능`;
}
