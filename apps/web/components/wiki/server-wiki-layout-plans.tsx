'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, Crown, Loader2, LockKeyhole } from 'lucide-react';

import { csrfHeaders } from '../../lib/csrf';
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

function ServerWikiLayoutPlansContent({ serverId }: { readonly serverId: string }) {
  const [settings, setSettings] = useState<LayoutSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = normalizeApiBaseUrl();

  useEffect(() => {
    fetch(`${baseUrl}/v1/servers/${serverId}/wiki-layouts`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('서버 위키 레이아웃을 불러오지 못했습니다.');
        return response.json() as Promise<LayoutSettings>;
      })
      .then(setSettings)
      .catch((value) => setError(value instanceof Error ? value.message : '레이아웃을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [baseUrl, serverId]);

  async function selectLayout(layoutKey: LayoutSettings['selected']) {
    setSaving(layoutKey); setError(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${serverId}/wiki-layout`, {
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

  if (loading) return <div className="flex min-h-[40vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;
  if (!settings) return <div className="rounded-xl border border-red-300/20 bg-red-500/10 p-5 text-sm text-red-100">{error}</div>;

  return (
    <div className="space-y-8">
      <header><p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Server Wiki Layouts</p><h1 className="mt-3 text-3xl font-extrabold text-white">서버 위키 레이아웃</h1><p className="mt-3 max-w-2xl text-sm leading-7 text-slate-400">3번 Docs는 모든 서버에 무료로 제공됩니다. 1번 Handbook과 2번 Brand는 요금제 권한이 활성화된 서버에서 선택할 수 있습니다.</p></header>
      {error ? <div className="rounded-lg border border-red-300/20 bg-red-500/10 p-4 text-sm text-red-100">{error}</div> : null}
      <div className="grid gap-6 xl:grid-cols-3">
        {settings.layouts.map((layout) => {
          const selected = settings.selected === layout.key;
          return <article key={layout.key} className={`overflow-hidden rounded-2xl border bg-[#10161e] ${selected ? 'border-emerald-300/60 shadow-xl shadow-emerald-950/30' : 'border-white/10'}`}>
            <div className="relative aspect-[3/2] bg-black"><Image src={`/design/server-wiki/concept-${layout.conceptNumber}.png`} alt={`${layout.conceptNumber}번 ${layout.name} 레이아웃`} fill sizes="(min-width:1280px) 33vw, 100vw" className="object-cover" /></div>
            <div className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-emerald-300">시안 {layout.conceptNumber}</p><h2 className="mt-1 text-xl font-bold text-white">{layout.name}</h2></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${layout.tier === 'free' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-violet-400/10 text-violet-300'}`}>{layout.tier === 'free' ? '무료 기본' : '프리미엄'}</span></div><p className="mt-3 min-h-12 text-sm leading-6 text-slate-400">{layout.description}</p>
              {selected ? <div className="mt-5 flex h-11 items-center justify-center gap-2 rounded-lg border border-emerald-300/30 bg-emerald-400/10 text-sm font-semibold text-emerald-300"><Check className="size-4" />현재 사용 중</div> : layout.entitled ? <button type="button" onClick={() => void selectLayout(layout.key)} disabled={Boolean(saving)} className="btn-primary mt-5 h-11 w-full gap-2">{saving === layout.key ? <Loader2 className="size-4 animate-spin" /> : <Crown className="size-4" />}이 레이아웃 사용</button> : <Link href={`/support/new?category=billing&serverId=${encodeURIComponent(serverId)}&layout=${layout.key}`} className="mt-5 flex h-11 items-center justify-center gap-2 rounded-lg border border-violet-300/30 bg-violet-400/10 text-sm font-semibold text-violet-200 transition hover:bg-violet-400/15"><LockKeyhole className="size-4" />요금제 문의</Link>}
            </div>
          </article>;
        })}
      </div>
      <p className="text-xs leading-5 text-slate-500">프리미엄 권한, 결제 기간, 환불과 해지는 MineWiki 결제 정책을 따릅니다. 문의: support@minewiki.kr</p>
    </div>
  );
}
