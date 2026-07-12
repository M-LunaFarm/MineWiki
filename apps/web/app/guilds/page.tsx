import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bot, ExternalLink, Hash, Settings, ShieldCheck, Users } from 'lucide-react';
import {
  buildDiscordBotInviteUrl,
  fetchGuilds,
  isGuildAuthenticationError,
  type GuildSummary,
} from '../../lib/guild-api';
import { createPageMetadata } from '../../lib/metadata';

export const dynamic = 'force-dynamic';

export const metadata = createPageMetadata({
  title: 'Discord 길드 관리',
  description: 'MineWiki Discord 인증 봇의 길드 설정과 인증 현황을 관리합니다.',
  path: '/guilds',
  noIndex: true,
});

export default async function GuildListPage() {
  const inviteUrl = buildDiscordBotInviteUrl();
  let guilds: GuildSummary[] = [];
  let error: string | null = null;

  try {
    guilds = await fetchGuilds();
  } catch (fetchError) {
    if (isGuildAuthenticationError(fetchError)) {
      redirect('/login?returnTo=%2Fguilds');
    }
    error = fetchError instanceof Error ? fetchError.message : '길드 목록을 불러오지 못했습니다.';
  }

  const configuredRoles = guilds.filter((guild) => guild.verifiedRoleId).length;
  const configuredLogs = guilds.filter((guild) => guild.logChannelId).length;

  return (
    <div className="space-y-8">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#14c794]">
            Discord Operations
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-white">길드 관리</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
            인증 역할, 로그 채널, 닉네임 포맷, 봇 응답 메시지를 MineWiki에서 직접 관리합니다.
          </p>
        </div>
        <div className="surface-card p-5">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-[#5865f2]/15 p-2 text-[#d9dcff]">
              <Bot className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">봇 연결</h2>
              <p className="mt-1 text-xs text-slate-400">새 길드에는 봇 초대가 먼저 필요합니다.</p>
            </div>
          </div>
          {inviteUrl ? (
            <a
              href={inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#4752c4]"
            >
              봇 초대
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : (
            <p className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-xs text-amber-100">
              Discord Client ID 환경 변수가 없어 초대 링크를 만들 수 없습니다.
            </p>
          )}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={<Users className="h-4 w-4" />} label="등록 길드" value={guilds.length} />
        <MetricCard
          icon={<ShieldCheck className="h-4 w-4" />}
          label="인증 역할 설정"
          value={configuredRoles}
        />
        <MetricCard icon={<Hash className="h-4 w-4" />} label="로그 채널 설정" value={configuredLogs} />
      </section>

      {error ? (
        <section className="surface-card border-red-400/20 bg-red-500/10 p-5">
          <h2 className="text-sm font-semibold text-red-100">길드 목록을 불러오지 못했습니다</h2>
          <p className="mt-2 text-sm text-red-100/80">{error}</p>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-white">연동된 길드</h2>
          <span className="text-xs text-slate-500">최근 업데이트 순</span>
        </div>
        {guilds.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {guilds.map((guild) => (
              <Link
                key={guild.guildId}
                href={`/guilds/${encodeURIComponent(guild.guildId)}`}
                className="surface-card surface-card-hover block p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-slate-500">{guild.guildId}</p>
                    <h3 className="mt-1 text-lg font-semibold text-white">
                      Discord 길드 {guild.guildId}
                    </h3>
                  </div>
                  <Settings className="h-5 w-5 shrink-0 text-slate-400" />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <StatusChip active={Boolean(guild.verifiedRoleId)} label="역할" />
                  <StatusChip active={Boolean(guild.logChannelId)} label="로그" />
                  <StatusChip active={Boolean(guild.nicknameFormat)} label="닉네임" />
                  <StatusChip active={Boolean(guild.botMessageTemplate)} label="메시지" />
                </div>
                <p className="mt-4 text-xs text-slate-500">수정됨 {formatDate(guild.updatedAt)}</p>
              </Link>
            ))}
          </div>
        ) : !error ? (
          <div className="surface-card p-8 text-center">
            <p className="text-sm font-semibold text-white">등록된 길드가 없습니다</p>
            <p className="mt-2 text-sm text-slate-400">
              봇이 길드 설정을 동기화하면 이 화면에 표시됩니다.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <div className="surface-card p-4">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <p className="text-xs font-semibold uppercase tracking-[0.16em]">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-bold text-white">{value.toLocaleString('ko-KR')}</p>
    </div>
  );
}

function StatusChip({ active, label }: { readonly active: boolean; readonly label: string }) {
  return <span className={`chip ${active ? 'chip-accent' : 'chip-muted'}`}>{label}</span>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}
