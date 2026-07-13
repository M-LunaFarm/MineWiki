'use client';

import Link from 'next/link';
import { BellRing, Loader2, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchWikiWatchStatus, markWikiPageWatchRead, setWikiPageWatched } from '../../lib/wiki-api';
import { useAuth } from '../providers/auth-context';

export function WikiWatchButton({ pageId, routePath }: { readonly pageId: string; readonly routePath: string }) {
  const { account, loading: authLoading } = useAuth();
  const [watched, setWatched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!account) return () => { active = false; };
    setLoading(true);
    void fetchWikiWatchStatus(pageId)
      .then(async (status) => {
        if (!active) return;
        setWatched(status.watched);
        if (status.unread) await markWikiPageWatchRead(pageId);
      })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : '관심 문서 상태를 불러오지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account, pageId]);

  if (authLoading) return <span className="chip chip-muted"><Loader2 className="size-3.5 animate-spin" /> 확인 중</span>;
  if (!account) {
    return <Link href={`/login?returnTo=${encodeURIComponent(routePath)}`} className="chip chip-muted inline-flex items-center gap-1.5"><Star className="size-3.5" /> 관심 문서</Link>;
  }

  async function toggle() {
    setLoading(true); setError(null);
    try {
      const status = await setWikiPageWatched(pageId, !watched);
      setWatched(status.watched);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '관심 문서 설정에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={() => void toggle()} disabled={loading} aria-pressed={watched} className={watched ? 'chip chip-accent inline-flex items-center gap-1.5' : 'chip chip-muted inline-flex items-center gap-1.5'}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : watched ? <BellRing className="size-3.5" /> : <Star className="size-3.5" />}
        {watched ? '관심 해제' : '관심 문서'}
      </button>
      {error ? <span role="alert" className="text-[11px] text-red-200">{error}</span> : null}
    </span>
  );
}
