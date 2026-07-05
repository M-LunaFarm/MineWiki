'use client';

import * as Tabs from '@radix-ui/react-tabs';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BadgeCheck,
  CircleDashed,
  Link2,
  Loader2,
  MessageSquareMore,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  TrendingUp,
  Vote,
} from 'lucide-react';
import { useAuth } from '../../components/providers/auth-context';
import {
  fetchDashboardOverview,
  removeOwnedServer,
  type DashboardActivityItem,
  type DashboardOverview,
  type DashboardServerSummary,
  type DashboardVerificationTask,
} from '../../lib/dashboard-api';
import { buildServerPath } from '../../lib/server-routes';

export default function DashboardPage() {
  const { account, loading: authLoading } = useAuth();
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingServerId, setRemovingServerId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!account) {
      setOverview(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchDashboardOverview();
        if (!cancelled) {
          setOverview(data);
        }
      } catch (fetchError) {
        if (!cancelled) {
          if ((fetchError as Error).message === 'UNAUTHORIZED') {
            setOverview(null);
          } else {
            setError((fetchError as Error).message);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [account, authLoading]);

  const servers = useMemo(() => overview?.servers ?? [], [overview]);
  const activity = useMemo(() => overview?.activity ?? [], [overview]);
  const verification = useMemo(() => overview?.verification ?? [], [overview]);

  const totalVotes24h = useMemo(
    () => servers.reduce((sum, server) => sum + server.votes24h, 0),
    [servers],
  );

  const totalReviews = useMemo(
    () => servers.reduce((sum, server) => sum + server.reviewsCount, 0),
    [servers],
  );

  const voteDelta = useMemo(() => {
    if (servers.length === 0 || totalVotes24h === 0) {
      return 0;
    }
    const monthly = servers.reduce((sum, server) => sum + (server.votesMonthly ?? 0), 0);
    if (monthly <= 0) {
      return 12;
    }
    const ratio = Math.round((totalVotes24h / monthly) * 100);
    return Math.max(1, Math.min(ratio, 99));
  }, [servers, totalVotes24h]);

  const providerLabel = useMemo(() => {
    if (!account) {
      return '-';
    }
    if (account.provider === 'discord') {
      return 'Discord';
    }
    if (account.provider === 'naver') {
      return 'NAVER';
    }
    return 'Email';
  }, [account]);

  const pendingVerificationCount = verification.filter((item) => item.status !== 'verified').length;

  const handleRemoveServer = async (server: DashboardServerSummary) => {
    if (removingServerId) {
      return;
    }
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        `"${server.name}" 서버를 제거하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`,
      );
      if (!confirmed) {
        return;
      }
    }

    setActionNotice(null);
    setActionError(null);
    setRemovingServerId(server.id);
    try {
      await removeOwnedServer(server.id);
      setOverview((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          servers: current.servers.filter((item) => item.id !== server.id),
          activity: current.activity.filter((item) => item.serverId !== server.id),
          verification: current.verification.filter((item) => item.serverId !== server.id),
        };
      });
      setActionNotice(`"${server.name}" 서버를 제거했습니다.`);
    } catch (removeError) {
      const message =
        removeError instanceof Error ? removeError.message : '서버 제거 중 오류가 발생했습니다.';
      setActionError(
        message === 'UNAUTHORIZED' ? '세션이 만료되었습니다. 다시 로그인해 주세요.' : message,
      );
    } finally {
      setRemovingServerId(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="rounded-lg border border-[#2f3438] bg-[#181a1d] p-6 text-sm text-[#b8c0c8]">
        운영자 대시보드를 불러오는 중입니다.
      </div>
    );
  }

  if (!account) {
    return (
      <div className="space-y-4 rounded-lg border border-[#2f3438] bg-[#181a1d] p-6 text-sm text-[#b8c0c8]">
        <div>
          <h1 className="text-lg font-semibold text-white">로그인이 필요합니다.</h1>
          <p className="mt-1">운영자 대시보드는 로그인 후 이용하실 수 있습니다.</p>
        </div>
        <Link
          href="/login?returnTo=/dashboard"
          className="inline-flex rounded-md bg-[#13ec80] px-4 py-2 text-xs font-semibold text-black transition hover:bg-[#35f29a]"
        >
          로그인하기
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-200">
        <p className="font-semibold">대시보드 데이터를 불러오지 못했습니다.</p>
        <p className="text-xs text-red-300">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {actionNotice ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {actionNotice}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {actionError}
        </div>
      ) : null}

      <section className="rounded-lg border border-[#2f3438] bg-[#181a1d]">
        <div className="flex flex-col gap-4 border-b border-[#2f3438] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8f98a3]">
              Operator Workspace
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-white">
              {account.displayName ?? '운영자'}님의 서버 운영 현황
            </h1>
            <p className="mt-1 text-sm text-[#b8c0c8]">
              등록 서버, 투표, 리뷰, 검증 업무를 한 화면에서 관리하실 수 있습니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/support"
              className="inline-flex items-center gap-2 rounded-md border border-[#3b4248] px-3 py-2 text-xs font-semibold text-[#d8dee5] transition hover:border-[#13ec80]/50 hover:text-[#13ec80]"
            >
              <MessageSquareMore className="h-3.5 w-3.5" />
              고객지원
            </Link>
            <Link
              href="/servers/register"
              className="inline-flex items-center gap-2 rounded-md bg-[#13ec80] px-3 py-2 text-xs font-semibold text-black transition hover:bg-[#35f29a]"
            >
              <Plus className="h-3.5 w-3.5" />
              서버 등록
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-px bg-[#2f3438] md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="내 서버"
            value={`${servers.length}`}
            detail="관리 중인 서버"
            icon={<Server className="h-5 w-5" />}
            iconClass="bg-emerald-500/10 text-emerald-500"
          />

          <div className="flex min-h-[132px] items-center justify-between bg-[#181a1d] p-5">
            <div>
              <div className="mb-1 text-sm font-medium text-[#b8c0c8]">24시간 투표수</div>
              <div className="text-2xl font-bold text-white">
                {totalVotes24h.toLocaleString('ko-KR')}
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs font-medium text-[#13ec80]">
                <TrendingUp className="h-3.5 w-3.5" /> +{voteDelta}%
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
              <Vote className="h-5 w-5" />
            </div>
          </div>

          <StatCard
            title="누적 리뷰"
            value={totalReviews.toLocaleString('ko-KR')}
            detail="전체 서버 리뷰"
            icon={<MessageSquareMore className="h-5 w-5" />}
            iconClass="bg-violet-500/10 text-violet-400"
          />

          <div className="flex min-h-[132px] items-center justify-between bg-[#181a1d] p-5">
            <div>
              <div className="mb-1 text-sm font-medium text-[#b8c0c8]">로그인 계정</div>
              <div className="mt-1 flex items-center gap-1 text-sm font-semibold text-white">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-[#2d2d2d] text-[10px]">
                  {providerLabel.charAt(0)}
                </span>
                {providerLabel}
              </div>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-500/10 text-slate-300">
              <Link2 className="h-5 w-5" />
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Tabs.Root defaultValue="servers">
            <div className="overflow-hidden rounded-lg border border-[#2f3438] bg-[#181a1d]">
              <div className="flex items-center justify-between border-b border-[#2f3438] px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">운영 항목</h2>
                  <p className="text-xs text-[#8f98a3]">
                    서버와 검증 상태를 기준으로 업무를 정리했습니다.
                  </p>
                </div>
              </div>
              <Tabs.List className="flex items-center gap-1 overflow-x-auto px-3">
                <TabTrigger value="servers">내 서버</TabTrigger>
                <TabTrigger value="activity">활동 로그</TabTrigger>
                <TabTrigger value="verification">
                  검증 상태
                  {pendingVerificationCount > 0 ? (
                    <span className="ml-1 rounded-full border border-yellow-500/20 bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-400">
                      {pendingVerificationCount}
                    </span>
                  ) : null}
                </TabTrigger>
              </Tabs.List>
            </div>

            <Tabs.Content value="servers" className="mt-5">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                {servers.map((server) => (
                  <article
                    key={server.id}
                    className="group rounded-lg border border-[#2f3438] bg-[#181a1d] p-5 transition-colors hover:border-[#13ec80]/40"
                  >
                    <div className="mb-4 flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 overflow-hidden rounded-md border border-[#30363d] bg-[#111315] p-0.5">
                          <div className="flex h-full w-full items-center justify-center rounded bg-[#23272b] text-sm font-bold text-white">
                            {server.name.charAt(0).toUpperCase()}
                          </div>
                        </div>
                        <div>
                          <h3 className="text-lg font-bold text-white">{server.name}</h3>
                          <div className="flex items-center gap-2 text-xs">
                            <span className={gradeClass(server.verificationGrade)}>
                              {gradeLabel(server.verificationGrade)}
                            </span>
                            <span className="text-[#A0A0A0]">{serverVersionHint(server.id)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mb-5 grid grid-cols-2 gap-4 rounded-md border border-[#30363d] bg-[#111315] p-3">
                      <Metric title="24h 투표" value={server.votes24h.toLocaleString('ko-KR')} />
                      <Metric
                        title="월간 투표"
                        value={(server.votesMonthly ?? 0).toLocaleString('ko-KR')}
                      />
                      <Metric title="리뷰" value={server.reviewsCount.toLocaleString('ko-KR')} />
                      <div>
                        <div className="mb-1 text-xs text-[#A0A0A0]">동기화</div>
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          {syncStatus(server.lastSyncedAt)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 border-t border-dashed border-[#30363d] pt-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs text-[#b8c0c8]">
                          {server.voteRequiresOwnership ? (
                            <>
                              <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                              <span>검증된 사용자 투표만 허용됩니다.</span>
                            </>
                          ) : (
                            <>
                              <BadgeCheck className="h-3.5 w-3.5 text-emerald-400" />
                              <span>투표 검증이 완료되었습니다.</span>
                            </>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRemoveServer(server)}
                            disabled={Boolean(removingServerId)}
                            className="inline-flex items-center gap-1 rounded border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {removingServerId === server.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                            {removingServerId === server.id ? '제거 중' : '서버 제거'}
                          </button>
                          <Link
                            href={`/claim?serverId=${server.id}`}
                            className="rounded-md bg-[#30363d] px-3 py-1.5 text-xs font-medium text-[#d8dee5] transition-colors hover:bg-[#3f4850] hover:text-white"
                          >
                            검증 관리
                          </Link>
                          <Link
                            href={buildServerPath(server)}
                            className="rounded-md border border-[#13ec80]/25 bg-[#13ec80]/10 px-3 py-1.5 text-xs font-medium text-[#13ec80] transition-colors hover:bg-[#13ec80]/20"
                          >
                            서버 상세
                          </Link>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}

                <Link
                  href="/servers/register"
                  className="group flex h-full min-h-[220px] flex-col items-center justify-center rounded-lg border border-dashed border-[#3b4248] bg-[#181a1d] p-5 text-center transition-all hover:border-[#13ec80]/50"
                >
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-md border border-[#30363d] bg-[#111315] text-[#b8c0c8] transition-colors group-hover:border-[#13ec80] group-hover:text-[#13ec80]">
                    <Plus className="h-5 w-5" />
                  </div>
                  <h3 className="font-bold text-white transition-colors group-hover:text-[#13ec80]">
                    새 서버 등록하기
                  </h3>
                  <p className="mt-1 text-xs text-[#b8c0c8]">
                    새로운 마인크래프트 서버를 등록하고 홍보하실 수 있습니다.
                  </p>
                </Link>
              </div>
            </Tabs.Content>

            <Tabs.Content value="activity" className="mt-5">
              <div className="space-y-3 rounded-lg border border-[#2f3438] bg-[#181a1d] p-4">
                {activity.length === 0 ? (
                  <EmptyLine
                    icon={<CircleDashed className="h-4 w-4" />}
                    text="표시할 활동 로그가 없습니다."
                  />
                ) : (
                  activity.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-md border border-[#30363d] bg-[#111315] px-4 py-3 transition-colors hover:border-[#4a4a4a]"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-white">{item.serverName}</span>
                        <span className="text-[#A0A0A0]">{formatRelative(item.createdAt)}</span>
                      </div>
                      <p className="text-sm text-[#cfcfcf]">{item.body}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.tags.map((tag) => (
                          <span
                            key={`${item.id}-${tag}`}
                            className="rounded border border-[#333333] px-1.5 py-0.5 text-[10px] text-[#A0A0A0]"
                          >
                            #{translateTag(tag)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Tabs.Content>

            <Tabs.Content value="verification" className="mt-5">
              <div className="overflow-hidden rounded-lg border border-[#2f3438] bg-[#181a1d]">
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-[#30363d] bg-[#111315]">
                        <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[#8f98a3]">
                          서버
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[#8f98a3]">
                          검증 방식
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[#8f98a3]">
                          상태
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[#8f98a3]">
                          관리
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#30363d]">
                      {verification.length === 0 ? (
                        <tr>
                          <td className="px-4 py-5 text-sm text-[#A0A0A0]" colSpan={4}>
                            모든 검증이 완료되었습니다.
                          </td>
                        </tr>
                      ) : (
                        verification.map((item, index) => (
                          <tr
                            key={`${item.serverId}-${item.method}-${index}`}
                            className="hover:bg-[#111315]"
                          >
                            <td className="px-4 py-3 text-sm font-medium text-white">
                              {item.serverName}
                            </td>
                            <td className="px-4 py-3 text-sm text-[#A0A0A0]">
                              {formatMethod(item.method)}
                            </td>
                            <td className="px-4 py-3">
                              <VerificationBadge status={item.status} />
                            </td>
                            <td className="px-4 py-3 text-right">
                              <Link
                                href={`/claim?serverId=${item.serverId}`}
                                className="text-sm text-[#13ec80] hover:text-[#0fb865]"
                              >
                                관리
                              </Link>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </div>

        <aside className="space-y-6 lg:col-span-1">
          <section className="overflow-hidden rounded-lg border border-[#2f3438] bg-[#181a1d]">
            <div className="flex items-center justify-between border-b border-[#2f3438] px-5 py-4">
              <h3 className="font-bold text-white">최근 활동 로그</h3>
              <Link href="/dashboard" className="text-xs text-[#13ec80] hover:text-[#0fb865]">
                더보기
              </Link>
            </div>
            <div className="divide-y divide-[#30363d]">
              {activity.slice(0, 3).map((item) => (
                <div key={`side-${item.id}`} className="p-4 transition-colors hover:bg-[#111315]">
                  <div className="mb-1 flex items-start justify-between">
                    <span className="text-xs font-medium text-[#A0A0A0]">{item.serverName}</span>
                    <span className="text-[10px] text-[#7a7a7a]">
                      {formatRelative(item.createdAt)}
                    </span>
                  </div>
                  <div className="mb-1 flex items-start gap-2">
                    <span className="rounded-[4px] border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold text-blue-400">
                      LOG
                    </span>
                    <p className="text-sm text-[#cfcfcf]">{item.body}</p>
                  </div>
                  <div className="text-xs text-[#A0A0A0]">
                    태그: {item.tags.map((tag) => translateTag(tag)).join(', ') || '-'}
                  </div>
                </div>
              ))}
              {activity.length === 0 ? (
                <div className="p-4 text-sm text-[#A0A0A0]">최근 활동 로그가 없습니다.</div>
              ) : null}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-[#2f3438] bg-[#181a1d]">
            <div className="flex items-center justify-between border-b border-[#2f3438] px-5 py-4">
              <h3 className="font-bold text-white">검증 상태</h3>
              <button type="button" className="text-[#A0A0A0] hover:text-white">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 p-4">
              {verification.slice(0, 3).map((item, index) => (
                <div
                  key={`status-${item.serverId}-${index}`}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[#30363d] bg-[#111315]">
                      <ShieldCheck className="h-4 w-4 text-emerald-500" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-white">{item.serverName}</div>
                      <div className="text-xs text-[#A0A0A0]">{formatMethod(item.method)}</div>
                    </div>
                  </div>
                  <VerificationBadge status={item.status} compact />
                </div>
              ))}
              {verification.length === 0 ? (
                <div className="text-sm text-[#A0A0A0]">처리할 검증 항목이 없습니다.</div>
              ) : null}

              <div className="pt-2">
                <Link
                  href="/claim"
                  className="block w-full rounded-md border border-[#30363d] py-2 text-center text-xs font-medium text-[#d8dee5] transition-colors hover:border-[#13ec80] hover:text-[#13ec80]"
                >
                  전체 검증 내역 관리
                </Link>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-[#2f3438] bg-[#181a1d] p-5">
            <div>
              <h3 className="mb-1 font-bold text-white">다음 운영 작업</h3>
              <p className="mb-3 text-xs text-[#b8c0c8]">
                서버 등록 또는 고객지원 인박스로 이동하실 수 있습니다.
              </p>
              <Link
                href="/dashboard/support"
                className="inline-flex items-center gap-1 rounded-md border border-[#13ec80]/30 bg-[#13ec80]/10 px-3 py-1.5 text-xs font-bold text-[#13ec80] transition-colors hover:bg-[#13ec80]/20"
              >
                지원 인박스 열기
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}

function TabTrigger({
  value,
  children,
}: {
  readonly value: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className="border-b-2 border-transparent px-4 py-3 text-sm font-medium text-[#b8c0c8] transition-colors data-[state=active]:border-[#13ec80] data-[state=active]:bg-[#13ec80]/5 data-[state=active]:text-[#13ec80] hover:bg-[#111315] hover:text-white"
    >
      {children}
    </Tabs.Trigger>
  );
}

function StatCard({
  title,
  value,
  detail,
  icon,
  iconClass,
}: {
  readonly title: string;
  readonly value: string;
  readonly detail?: string;
  readonly icon: React.ReactNode;
  readonly iconClass: string;
}) {
  return (
    <div className="flex min-h-[132px] items-center justify-between bg-[#181a1d] p-5">
      <div>
        <div className="mb-1 text-sm font-medium text-[#b8c0c8]">{title}</div>
        <div className="text-2xl font-bold text-white">{value}</div>
        {detail ? <div className="mt-1 text-xs text-[#8f98a3]">{detail}</div> : null}
      </div>
      <div className={`flex h-10 w-10 items-center justify-center rounded-md ${iconClass}`}>
        {icon}
      </div>
    </div>
  );
}

function Metric({ title, value }: { readonly title: string; readonly value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-[#A0A0A0]">{title}</div>
      <div className="font-bold text-white">{value}</div>
    </div>
  );
}

function EmptyLine({ icon, text }: { readonly icon: React.ReactNode; readonly text: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-dashed border-[#333333] bg-[#171717] px-3 py-2 text-sm text-[#A0A0A0]">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function VerificationBadge({
  status,
  compact = false,
}: {
  readonly status: DashboardVerificationTask['status'];
  readonly compact?: boolean;
}) {
  const classMap =
    status === 'verified'
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : status === 'pending'
        ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
        : status === 'expired'
          ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
          : 'bg-red-500/10 text-red-400 border-red-500/20';

  return (
    <span
      className={`inline-flex rounded border px-2 py-0.5 ${compact ? 'text-[10px]' : 'text-xs'} font-medium ${classMap}`}
    >
      {status === 'verified'
        ? '검증 완료'
        : status === 'pending'
          ? '검토 대기'
          : status === 'expired'
            ? '만료됨'
            : '실패함'}
    </span>
  );
}

function gradeLabel(grade: DashboardServerSummary['verificationGrade']) {
  return grade === 'Verified' ? '검증 완료' : '검증 필요';
}

function gradeClass(grade: DashboardServerSummary['verificationGrade']) {
  if (grade === 'Verified') {
    return 'rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono font-bold text-emerald-400';
  }
  return 'rounded border border-yellow-500/20 bg-yellow-500/10 px-1.5 py-0.5 font-mono font-bold text-yellow-400';
}

function serverVersionHint(id: string) {
  const index = id.charCodeAt(0) % 3;
  if (index === 0) {
    return 'v1.20.4';
  }
  if (index === 1) {
    return 'v1.20.1';
  }
  return 'v1.19.2';
}

function syncStatus(lastSyncedAt?: string | null) {
  if (!lastSyncedAt) {
    return '확인 필요';
  }
  const diff = Date.now() - Date.parse(lastSyncedAt);
  if (Number.isNaN(diff)) {
    return '확인 필요';
  }
  if (diff < 1000 * 60 * 10) {
    return '정상';
  }
  if (diff < 1000 * 60 * 60) {
    return '지연';
  }
  return '확인 필요';
}

function formatRelative(value?: string | null) {
  if (!value) {
    return '기록 없음';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return '기록 없음';
  }

  const diffMs = Date.now() - parsed;
  const minute = 1000 * 60;
  const hour = minute * 60;
  const day = hour * 24;

  if (diffMs < hour) {
    return `${Math.max(1, Math.floor(diffMs / minute))}분 전`;
  }
  if (diffMs < day) {
    return `${Math.max(1, Math.floor(diffMs / hour))}시간 전`;
  }
  return `${Math.max(1, Math.floor(diffMs / day))}일 전`;
}

function formatMethod(method: DashboardVerificationTask['method']) {
  if (method === 'dns') {
    return 'DNS TXT Record';
  }
  if (method === 'motd') {
    return 'MOTD Token';
  }
  if (method === 'plugin') {
    return 'Plugin Sync';
  }
  return method;
}

function translateTag(tag: DashboardActivityItem['tags'][number]) {
  if (tag === 'performance') {
    return '성능';
  }
  if (tag === 'community') {
    return '커뮤니티';
  }
  if (tag === 'staff') {
    return '운영진';
  }
  if (tag === 'stability') {
    return '안정성';
  }
  if (tag === 'content') {
    return '콘텐츠';
  }
  return '경제';
}
