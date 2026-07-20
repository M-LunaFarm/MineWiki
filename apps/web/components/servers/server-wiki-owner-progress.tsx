'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, BookOpen, CheckCircle2, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { serverWikiOwnerProgress } from '../../lib/server-wiki-owner-progress.mjs';
import { useAuth } from '../providers/auth-context';
import type { ServerWikiReadiness } from './server-wiki-readiness-card';

export function ServerWikiOwnerProgress({
  serverId,
  apiBaseUrl,
  publicWikiUrl,
}: {
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly publicWikiUrl?: string | null;
}) {
  const { account } = useAuth();
  const [readiness, setReadiness] = useState<ServerWikiReadiness | null>(null);
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);

  useEffect(() => {
    setReadiness(null);
    if (!account || publicWikiUrl) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const ownership = await fetch(`${baseUrl}/v1/servers/${serverId}/ownership`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!ownership.ok) return;
        const owner = (await ownership.json()) as { isOwner?: boolean };
        if (!owner.isOwner) return;
        const response = await fetch(`${baseUrl}/v1/servers/${serverId}/wiki-readiness`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        setReadiness((await response.json()) as ServerWikiReadiness);
      } catch (error) {
        if (!controller.signal.aborted) console.warn('서버 위키 상단 진행 상태 로드 실패', error);
      }
    };
    void load();
    return () => controller.abort();
  }, [account, baseUrl, publicWikiUrl, serverId]);

  const progress = serverWikiOwnerProgress(readiness, serverId);
  if (!progress) return null;
  const tone = progress.tone === 'danger'
    ? 'border-red-300/25 bg-red-400/[0.055]'
    : progress.tone === 'attention'
      ? 'border-amber-300/25 bg-amber-300/[0.055]'
      : 'border-emerald-400/25 bg-emerald-400/[0.055]';
  const Icon = progress.tone === 'danger'
    ? Wrench
    : progress.tone === 'attention'
      ? AlertTriangle
      : progress.tone === 'ready'
        ? CheckCircle2
        : BookOpen;
  const iconTone = progress.tone === 'danger'
    ? 'border-red-300/20 bg-red-300/[0.07] text-red-200'
    : progress.tone === 'attention'
      ? 'border-amber-300/20 bg-amber-300/[0.07] text-amber-200'
      : 'border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200';

  return (
    <section className={`surface-card mb-6 overflow-hidden border p-5 sm:p-6 ${tone}`} aria-labelledby="server-wiki-owner-progress-title" aria-live="polite">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className={`grid size-11 shrink-0 place-items-center rounded-xl border ${iconTone}`}>
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-300">{progress.eyebrow}</p>
            <h2 id="server-wiki-owner-progress-title" className="mt-1 text-lg font-bold text-white sm:text-xl">{progress.title}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{progress.description}</p>
          </div>
        </div>
        <Link href={progress.href} className="btn-primary min-h-11 shrink-0 px-5">
          {progress.action}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
