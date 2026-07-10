import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Bot, ExternalLink, Hash, Settings, ShieldCheck, Users } from 'lucide-react';
import {
  buildDiscordBotInviteUrl,
  fetchGuildDetail,
  type GuildActionProfile,
  type GuildChannelSetting,
  type GuildDetail,
} from '../../../lib/guild-api';
import { createPageMetadata } from '../../../lib/metadata';

interface PageProps {
  readonly params: Promise<{ guildId: string }>;
}

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps) {
  const { guildId } = await params;
  return createPageMetadata({
    title: `Discord 길드 ${guildId}`,
    description: 'MineWiki Discord 인증 길드 설정 상세입니다.',
    path: `/guilds/${guildId}`,
    noIndex: true,
  });
}

export default async function GuildDetailPage({ params }: PageProps) {
  const { guildId } = await params;
  let guild: GuildDetail | null = null;
  let error: string | null = null;

  try {
    guild = await fetchGuildDetail(guildId);
  } catch (fetchError) {
    error = fetchError instanceof Error ? fetchError.message : '길드 정보를 불러오지 못했습니다.';
  }

  if (!guild && !error) {
    notFound();
  }

  const inviteUrl = buildDiscordBotInviteUrl(guildId);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <Link href="/guilds" className="chip chip-muted inline-flex items-center gap-1.5">
          <ArrowLeft className="h-3.5 w-3.5" />
          길드 목록
        </Link>
        <div className="flex gap-2">
          {inviteUrl ? (
            <a
              href={inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="chip chip-cyan inline-flex items-center gap-1.5"
            >
              봇 초대
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          <Link
            href={`/guilds/${encodeURIComponent(guildId)}/settings`}
            className="chip chip-accent inline-flex items-center gap-1.5"
          >
            <Settings className="h-3.5 w-3.5" />
            설정
          </Link>
        </div>
      </div>

      {error ? (
        <section className="surface-card border-red-400/20 bg-red-500/10 p-5">
          <h1 className="text-lg font-semibold text-red-100">길드 정보를 불러오지 못했습니다</h1>
          <p className="mt-2 text-sm text-red-100/80">{error}</p>
        </section>
      ) : null}

      {guild ? (
        <>
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#14c794]">
                Guild Detail
              </p>
              <h1 className="mt-3 break-all text-3xl font-bold tracking-tight text-white">
                {guild.guildId}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
                Discord 인증 봇이 사용하는 역할, 로그, 응답 메시지, 채널별 정책을 확인합니다.
              </p>
            </div>
            <div className="surface-card p-5">
              <div className="flex items-center gap-3">
                <span className="rounded-lg bg-[#14c794]/15 p-2 text-[#14c794]">
                  <Users className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs text-slate-500">누적 인증</p>
                  <p className="text-2xl font-bold text-white">
                    {guild.verificationCount.toLocaleString('ko-KR')}
                  </p>
                </div>
              </div>
              <p className="mt-4 text-xs text-slate-500">수정됨 {formatDate(guild.updatedAt)}</p>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SettingCard icon={<ShieldCheck className="h-4 w-4" />} label="인증 역할" value={guild.verifiedRoleId} />
            <SettingCard icon={<Hash className="h-4 w-4" />} label="로그 채널" value={guild.logChannelId} />
            <SettingCard icon={<Users className="h-4 w-4" />} label="닉네임 포맷" value={guild.nicknameFormat} />
            <SettingCard icon={<Bot className="h-4 w-4" />} label="봇 메시지" value={guild.botMessageTemplate} />
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <JsonPanel title="봇 메시지 Payload" value={guild.botMessagePayload} />
            <JsonPanel title="인증 Reply Payload" value={guild.verifyReplyPayload} />
            <JsonPanel title="정책 JSON" value={guild.policyJson} />
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">채널 오버라이드</h2>
            {guild.channels.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {guild.channels.map((channel) => (
                  <ChannelCard key={channel.channelId} channel={channel} />
                ))}
              </div>
            ) : (
              <EmptyState text="채널별 오버라이드가 없습니다." />
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">액션 프로필</h2>
            {guild.actionProfiles.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {guild.actionProfiles.map((profile) => (
                  <ActionProfileCard key={profile.profileId} profile={profile} />
                ))}
              </div>
            ) : (
              <EmptyState text="등록된 액션 프로필이 없습니다." />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function SettingCard({
  icon,
  label,
  value,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value?: string | null;
}) {
  return (
    <div className="surface-card p-4">
      <div className="flex items-center gap-2 text-slate-400">
        {icon}
        <p className="text-xs font-semibold uppercase tracking-[0.16em]">{label}</p>
      </div>
      <p className="mt-3 break-all font-mono text-sm text-white">{value || '미설정'}</p>
    </div>
  );
}

function JsonPanel({ title, value }: { readonly title: string; readonly value: unknown }) {
  return (
    <div className="surface-card p-5">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs leading-5 text-slate-300">
        {formatJson(value)}
      </pre>
    </div>
  );
}

function ChannelCard({ channel }: { readonly channel: GuildChannelSetting }) {
  return (
    <article className="surface-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="break-all font-mono text-sm font-semibold text-white">#{channel.channelId}</h3>
        <span className="chip chip-muted">오버라이드</span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm">
        <SettingRow label="인증 역할" value={channel.verifiedRoleId} />
        <SettingRow label="로그 채널" value={channel.logChannelId} />
        <SettingRow label="닉네임" value={channel.nicknameFormat} />
      </dl>
    </article>
  );
}

function ActionProfileCard({ profile }: { readonly profile: GuildActionProfile }) {
  return (
    <article className="surface-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-semibold text-white">{profile.name}</h3>
          <p className="mt-1 font-mono text-xs text-slate-500">{profile.profileId}</p>
        </div>
        <span className={`chip ${profile.enabled ? 'chip-accent' : 'chip-muted'}`}>
          {profile.enabled ? '활성' : '비활성'}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm">
        <SettingRow label="트리거" value={profile.triggerEvent} />
        <SettingRow label="채널" value={profile.channelId} />
        <SettingRow label="수정됨" value={formatDate(profile.updatedAt)} />
      </dl>
    </article>
  );
}

function SettingRow({ label, value }: { readonly label: string; readonly value?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="break-all text-right font-mono text-slate-200">{value || '미설정'}</dd>
    </div>
  );
}

function EmptyState({ text }: { readonly text: string }) {
  return <div className="surface-card p-8 text-center text-sm text-slate-400">{text}</div>;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  return JSON.stringify(value, null, 2);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}
