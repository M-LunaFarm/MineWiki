import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Hash, Save, ShieldCheck } from 'lucide-react';
import {
  fetchGuildDetail,
  updateGuildSettings,
  type GuildDetail,
  type GuildSettingsPayload,
} from '../../../../lib/guild-api';
import { createPageMetadata } from '../../../../lib/metadata';

interface PageProps {
  readonly params: Promise<{ guildId: string }>;
  readonly searchParams?: Promise<{ saved?: string | string[]; error?: string | string[] }>;
}

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps) {
  const { guildId } = await params;
  return createPageMetadata({
    title: `Discord 길드 ${guildId} 설정`,
    description: 'MineWiki Discord 인증 길드 설정을 수정합니다.',
    path: `/guilds/${guildId}/settings`,
    noIndex: true,
  });
}

export default async function GuildSettingsPage({ params, searchParams }: PageProps) {
  const { guildId } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  let guild: GuildDetail | null = null;
  let loadError: string | null = null;

  try {
    guild = await fetchGuildDetail(guildId);
  } catch (fetchError) {
    loadError = fetchError instanceof Error ? fetchError.message : '길드 설정을 불러오지 못했습니다.';
  }

  if (!guild && !loadError) {
    notFound();
  }

  async function saveSettings(formData: FormData) {
    'use server';

    const channelId = normalizeString(formData.get('channelId'));
    const redirectPath = `/guilds/${encodeURIComponent(guildId)}/settings`;
    let payload: GuildSettingsPayload;

    try {
      payload = {
        channelId: channelId ?? undefined,
        verifiedRoleId: normalizeString(formData.get('verifiedRoleId')),
        logChannelId: normalizeString(formData.get('logChannelId')),
        nicknameFormat: normalizeString(formData.get('nicknameFormat')),
        botMessageTemplate: normalizeString(formData.get('botMessageTemplate')),
        botMessagePayload: parseJsonField(formData.get('botMessagePayload')),
        verifyReplyPayload: parseJsonField(formData.get('verifyReplyPayload')),
        policyJson: parseJsonField(formData.get('policyJson')),
      };
    } catch {
      redirect(`${redirectPath}?error=json`);
    }

    try {
      await updateGuildSettings(guildId, payload);
    } catch (error) {
      console.error('Failed to update guild settings', error);
      redirect(`${redirectPath}?error=save`);
    }

    redirect(`${redirectPath}?saved=1`);
  }

  const saved = toSingleValue(resolvedSearchParams.saved) === '1';
  const error = toSingleValue(resolvedSearchParams.error);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <Link href={`/guilds/${encodeURIComponent(guildId)}`} className="chip chip-muted inline-flex items-center gap-1.5">
          <ArrowLeft className="h-3.5 w-3.5" />
          상세
        </Link>
      </div>

      {loadError ? (
        <section className="surface-card border-red-400/20 bg-red-500/10 p-5">
          <h1 className="text-lg font-semibold text-red-100">길드 설정을 불러오지 못했습니다</h1>
          <p className="mt-2 text-sm text-red-100/80">{loadError}</p>
        </section>
      ) : null}

      {guild ? (
        <>
          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#14c794]">
              Guild Settings
            </p>
            <h1 className="mt-3 break-all text-3xl font-bold tracking-tight text-white">
              {guild.guildId} 설정
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              채널 ID를 비워 저장하면 길드 기본 설정이 수정되고, 채널 ID를 입력하면 해당 채널의
              오버라이드가 저장됩니다.
            </p>
          </section>

          {saved ? (
            <p className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
              설정이 저장되었습니다.
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-100">
              {error === 'json'
                ? 'JSON 입력값을 확인해 주세요.'
                : '설정을 저장하지 못했습니다.'}
            </p>
          ) : null}

          <form action={saveSettings} className="surface-card space-y-6 p-5 md:p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                name="channelId"
                label="채널 오버라이드 ID"
                placeholder="비워두면 길드 기본 설정"
                defaultValue=""
              />
              <Field
                name="verifiedRoleId"
                label="인증 역할 ID"
                defaultValue={guild.verifiedRoleId ?? ''}
                icon={<ShieldCheck className="h-4 w-4" />}
              />
              <Field
                name="logChannelId"
                label="로그 채널 ID"
                defaultValue={guild.logChannelId ?? ''}
                icon={<Hash className="h-4 w-4" />}
              />
              <Field
                name="nicknameFormat"
                label="닉네임 포맷"
                defaultValue={guild.nicknameFormat ?? ''}
                placeholder="{player} 또는 {minecraftName}"
              />
            </div>

            <Field
              name="botMessageTemplate"
              label="봇 메시지 템플릿"
              defaultValue={guild.botMessageTemplate ?? ''}
              placeholder="인증 안내 메시지"
            />

            <div className="grid gap-4 lg:grid-cols-3">
              <JsonField
                name="botMessagePayload"
                label="봇 메시지 Payload"
                defaultValue={formatJsonTextarea(guild.botMessagePayload)}
              />
              <JsonField
                name="verifyReplyPayload"
                label="인증 Reply Payload"
                defaultValue={formatJsonTextarea(guild.verifyReplyPayload)}
              />
              <JsonField
                name="policyJson"
                label="정책 JSON"
                defaultValue={formatJsonTextarea(guild.policyJson)}
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#14c794] px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-[#1ee6a4]"
              >
                <Save className="h-4 w-4" />
                저장
              </button>
            </div>
          </form>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">현재 채널 오버라이드</h2>
            {guild.channels.length > 0 ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {guild.channels.map((channel) => (
                  <article key={channel.channelId} className="surface-card p-5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="break-all font-mono text-sm font-semibold text-white">
                        #{channel.channelId}
                      </h3>
                      <span className="chip chip-muted">채널</span>
                    </div>
                    <dl className="mt-4 grid gap-3 text-sm">
                      <SettingRow label="인증 역할" value={channel.verifiedRoleId} />
                      <SettingRow label="로그 채널" value={channel.logChannelId} />
                      <SettingRow label="닉네임" value={channel.nicknameFormat} />
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <div className="surface-card p-8 text-center text-sm text-slate-400">
                저장된 채널 오버라이드가 없습니다.
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function Field({
  name,
  label,
  defaultValue,
  placeholder,
  icon,
}: {
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly placeholder?: string;
  readonly icon?: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-2 text-sm font-semibold text-slate-200">
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <input
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="h-11 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 text-sm text-white placeholder:text-slate-600 focus:border-[#14c794]/60 focus:outline-none focus:ring-2 focus:ring-[#14c794]/15"
      />
    </label>
  );
}

function JsonField({
  name,
  label,
  defaultValue,
}: {
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-2 text-sm font-semibold text-slate-200">
      {label}
      <textarea
        name={name}
        defaultValue={defaultValue}
        spellCheck={false}
        className="h-44 w-full rounded-lg border border-white/[0.08] bg-black/30 p-3 font-mono text-xs leading-5 text-white placeholder:text-slate-600 focus:border-[#14c794]/60 focus:outline-none focus:ring-2 focus:ring-[#14c794]/15"
      />
    </label>
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

function normalizeString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function parseJsonField(value: FormDataEntryValue | null): unknown {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  return JSON.parse(normalized);
}

function formatJsonTextarea(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value, null, 2);
}

function toSingleValue(value?: string | string[]): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
