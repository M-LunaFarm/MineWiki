'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';
import { useAuth } from '../providers/auth-context';
import { fetchAuditEvents, type AuditEvent } from '../../lib/audit-api';

const CATEGORIES = [
  '',
  'auth',
  'wiki',
  'file',
  'server',
  'vote',
  'plugin.sync',
  'discord.verify',
  'guild',
  'admin'
];

export function AuditConsole() {
  const { account, loading: authLoading } = useAuth();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (selectedCategory = category) => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await fetchAuditEvents({ category: selectedCategory || undefined, limit: 100 }));
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '감사 이벤트를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!account) {
      setLoading(false);
      return;
    }
    void load();
  }, [account, authLoading, load]);

  if (authLoading || loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-300" />
      </div>
    );
  }

  if (!account) {
    return (
      <section className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-2xl font-semibold text-white">로그인이 필요합니다</h1>
        <Link href="/login?returnTo=/admin/audit" className="btn-primary mt-5 h-10">
          로그인
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
              <ShieldAlert className="h-4 w-4" />
              Audit
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-white">감사 이벤트</h1>
          </div>
          <select
            value={category}
            onChange={(event) => {
              const next = event.target.value;
              setCategory(next);
              void load(next);
            }}
            className="h-10 rounded-md border border-white/10 bg-[#15171b] px-3 text-sm text-white"
          >
            {CATEGORIES.map((item) => (
              <option key={item || 'all'} value={item}>
                {item || '전체 카테고리'}
              </option>
            ))}
          </select>
        </div>
      </section>

      {error ? (
        <div className="flex gap-3 rounded-lg border border-red-300/30 bg-red-500/10 p-4 text-sm text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <p>{error}</p>
        </div>
      ) : null}

      <section className="overflow-x-auto rounded-lg border border-white/10 bg-[#111821]">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-white/10 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">시간</th>
              <th className="px-4 py-3">카테고리</th>
              <th className="px-4 py-3">동작</th>
              <th className="px-4 py-3">대상</th>
              <th className="px-4 py-3">메타데이터</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10 text-slate-300">
            {events.map((event) => (
              <tr key={event.id}>
                <td className="px-4 py-3 whitespace-nowrap">{formatDate(event.createdAt)}</td>
                <td className="px-4 py-3 font-semibold text-white">{event.category}</td>
                <td className="px-4 py-3">{event.action}</td>
                <td className="px-4 py-3">
                  {event.subjectType ? `${event.subjectType}:${event.subjectId ?? '-'}` : '-'}
                </td>
                <td className="max-w-[32rem] truncate px-4 py-3 font-mono text-xs text-slate-400">
                  {formatMetadata(event.metadata)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function formatMetadata(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(new Date(value));
}
