'use client';

import { AlertTriangle, ExternalLink, Files, FileText, LayoutList, LayoutTemplate, Link2, Loader2, Save, Users } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { csrfHeaders } from '../../lib/csrf';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';
import { PrivilegedActionGate } from '../auth/privileged-action-gate';
import { ServerWikiCollaboratorsContent } from './server-wiki-collaborators';
import { ServerWikiLayoutPlansContent } from './server-wiki-layout-plans';
import { ServerWikiNavigationSettings } from './server-wiki-navigation-settings';
import { ServerWikiPublicationSettings } from './server-wiki-publication-settings';
import { ServerWikiTemplateSettings } from './server-wiki-template-settings';

interface ContentSettings {
  readonly serverWikiId: string;
  readonly slug: string;
  readonly siteSlug: string;
  readonly wikiUrl: string;
  readonly version: number;
  readonly contributionPolicyVersion: number;
  readonly contributionPolicySource: string | null;
  readonly editHelpSource: string | null;
  readonly topNoticeSource: string | null;
  readonly bottomNoticeSource: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly seoIndexingEnabled: boolean;
  readonly requireContributionPolicyAck: boolean;
  readonly updatedAt: string | null;
  readonly updatedByProfileId: string | null;
  readonly access: SettingsAccess;
}

interface SettingsAccess {
  readonly canManageContentSettings: true;
  readonly canManageLayout: boolean;
  readonly canManageCollaborators: boolean;
}

type SourceField = 'contributionPolicySource' | 'editHelpSource' | 'topNoticeSource' | 'bottomNoticeSource';
type FormState = Pick<ContentSettings, SourceField | 'requireContributionPolicyAck' | 'seoTitle' | 'seoDescription' | 'seoIndexingEnabled'>;
type SettingsTab = 'content' | 'structure' | 'templates' | 'layout' | 'collaborators';

const FIELD_LIMITS: Record<SourceField, number> = {
  contributionPolicySource: 8 * 1024,
  editHelpSource: 8 * 1024,
  topNoticeSource: 2 * 1024,
  bottomNoticeSource: 2 * 1024,
};

const EMPTY_FORM: FormState = {
  contributionPolicySource: null,
  editHelpSource: null,
  topNoticeSource: null,
  bottomNoticeSource: null,
  requireContributionPolicyAck: false,
  seoTitle: null,
  seoDescription: null,
  seoIndexingEnabled: true,
};

export function ServerWikiSettings({ serverId }: { readonly serverId: string }) {
  return (
    <PrivilegedActionGate
      purpose="server_admin"
      title="서버 위키 설정 잠금 해제"
      description="허용된 서버 위키 설정을 변경하려면 다중 인증으로 계정 권한을 다시 확인해 주세요."
    >
      <ServerWikiSettingsContent serverId={serverId} />
    </PrivilegedActionGate>
  );
}

function ServerWikiSettingsContent({ serverId }: { readonly serverId: string }) {
  const [tab, setTab] = useState<SettingsTab>('content');
  const [access, setAccess] = useState<SettingsAccess | null>(null);
  const tabIdPrefix = useId();
  const tabButtons = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const settingsTabs = useMemo<readonly SettingsTab[]>(() => {
    const allowed: SettingsTab[] = ['content', 'structure', 'templates'];
    if (access?.canManageLayout) allowed.push('layout');
    if (access?.canManageCollaborators) allowed.push('collaborators');
    return allowed;
  }, [access]);

  useEffect(() => {
    if (!settingsTabs.includes(tab)) setTab('content');
  }, [settingsTabs, tab]);

  function tabId(value: SettingsTab): string {
    return `${tabIdPrefix}-${value}-tab`;
  }

  function panelId(value: SettingsTab): string {
    return `${tabIdPrefix}-${value}-panel`;
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: SettingsTab) {
    const currentIndex = settingsTabs.indexOf(current);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % settingsTabs.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = settingsTabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = settingsTabs[nextIndex];
    setTab(nextTab);
    tabButtons.current[nextTab]?.focus();
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">Server Wiki Settings</p>
        <h1 className="mt-3 text-3xl font-extrabold text-white">서버 위키 설정</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-400">{access?.canManageLayout || access?.canManageCollaborators ? 'GitBook처럼 문서 전체에 적용할 운영 정책과 안내, 협업자 권한을 관리하고 서버 브랜드에 맞는 레이아웃을 선택합니다.' : '문서 전체에 적용할 기여 정책, 편집 도움말과 상단·하단 안내를 관리합니다.'}</p>
      </header>
      <ServerWikiPublicationSettings serverId={serverId} />
      <div className="grid rounded-xl border border-white/10 bg-white/[0.025] p-1" style={{ gridTemplateColumns: `repeat(${settingsTabs.length}, minmax(0, 1fr))` }} role="tablist" aria-label="서버 위키 설정 분류">
        <Tab
          id={tabId('content')}
          controls={panelId('content')}
          active={tab === 'content'}
          onClick={() => setTab('content')}
          onKeyDown={(event) => handleTabKeyDown(event, 'content')}
          buttonRef={(node) => { tabButtons.current.content = node; }}
          icon={<FileText className="size-4" aria-hidden="true" />}
        >
          정책·문서 안내
        </Tab>
        <Tab
          id={tabId('structure')}
          controls={panelId('structure')}
          active={tab === 'structure'}
          onClick={() => setTab('structure')}
          onKeyDown={(event) => handleTabKeyDown(event, 'structure')}
          buttonRef={(node) => { tabButtons.current.structure = node; }}
          icon={<LayoutList className="size-4" aria-hidden="true" />}
        >
          문서 구조
        </Tab>
        <Tab
          id={tabId('templates')}
          controls={panelId('templates')}
          active={tab === 'templates'}
          onClick={() => setTab('templates')}
          onKeyDown={(event) => handleTabKeyDown(event, 'templates')}
          buttonRef={(node) => { tabButtons.current.templates = node; }}
          icon={<Files className="size-4" aria-hidden="true" />}
        >
          문서 양식
        </Tab>
        {access?.canManageLayout ? <Tab
          id={tabId('layout')}
          controls={panelId('layout')}
          active={tab === 'layout'}
          onClick={() => setTab('layout')}
          onKeyDown={(event) => handleTabKeyDown(event, 'layout')}
          buttonRef={(node) => { tabButtons.current.layout = node; }}
          icon={<LayoutTemplate className="size-4" aria-hidden="true" />}
        >
          레이아웃·요금제
        </Tab> : null}
        {access?.canManageCollaborators ? <Tab
          id={tabId('collaborators')}
          controls={panelId('collaborators')}
          active={tab === 'collaborators'}
          onClick={() => setTab('collaborators')}
          onKeyDown={(event) => handleTabKeyDown(event, 'collaborators')}
          buttonRef={(node) => { tabButtons.current.collaborators = node; }}
          icon={<Users className="size-4" aria-hidden="true" />}
        >
          협업자
        </Tab> : null}
      </div>
      <TabPanel id={panelId('content')} labelledBy={tabId('content')} active={tab === 'content'}>
        {tab === 'content' ? <ContentSettingsForm serverId={serverId} onAccessLoaded={setAccess} /> : null}
      </TabPanel>
      <TabPanel id={panelId('structure')} labelledBy={tabId('structure')} active={tab === 'structure'}>
        {tab === 'structure' ? <ServerWikiNavigationSettings serverId={serverId} /> : null}
      </TabPanel>
      <TabPanel id={panelId('templates')} labelledBy={tabId('templates')} active={tab === 'templates'}>
        {tab === 'templates' ? <ServerWikiTemplateSettings serverId={serverId} /> : null}
      </TabPanel>
      {access?.canManageLayout ? <TabPanel id={panelId('layout')} labelledBy={tabId('layout')} active={tab === 'layout'}>
        {tab === 'layout' ? <ServerWikiLayoutPlansContent serverId={serverId} /> : null}
      </TabPanel> : null}
      {access?.canManageCollaborators ? <TabPanel id={panelId('collaborators')} labelledBy={tabId('collaborators')} active={tab === 'collaborators'}>
        {tab === 'collaborators' ? <ServerWikiCollaboratorsContent serverId={serverId} /> : null}
      </TabPanel> : null}
    </div>
  );
}

function ContentSettingsForm({ serverId, onAccessLoaded }: { readonly serverId: string; readonly onAccessLoaded: (access: SettingsAccess) => void }) {
  const baseUrl = normalizeApiBaseUrl();
  const [settings, setSettings] = useState<ContentSettings | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const dirty = settings ? serializeForm(form) !== serializeForm(toForm(settings)) : false;
  const byteCounts = useMemo(() => Object.fromEntries(
    (Object.keys(FIELD_LIMITS) as SourceField[]).map((field) => [field, bytes(form[field] ?? '')]),
  ) as Record<SourceField, number>, [form]);
  const invalid = (Object.keys(FIELD_LIMITS) as SourceField[]).some((field) => byteCounts[field] > FIELD_LIMITS[field]);
  const totalBytes = Object.values(byteCounts).reduce((sum, value) => sum + value, 0);

  const load = async () => {
    setLoading(true); setError(null); setConflictVersion(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-settings`, { credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '서버 위키 설정을 불러오지 못했습니다.');
      const next = body as ContentSettings;
      const nextAccess = settingsAccess(next);
      setSettings(next); setForm(toForm(next)); onAccessLoaded(nextAccess);
    } catch (value) { setError(value instanceof Error ? value.message : '서버 위키 설정을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [baseUrl, serverId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save() {
    if (!settings || invalid || totalBytes > 20 * 1024) return;
    setSaving(true); setError(null); setNotice(null); setConflictVersion(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-settings`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ expectedVersion: settings.version, ...normalizeForm(form) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.code === 'SERVER_WIKI_SETTINGS_CONFLICT') setConflictVersion(Number(body.currentVersion));
        throw new Error(body.message ?? '서버 위키 설정을 저장하지 못했습니다.');
      }
      const next = body as ContentSettings;
      const nextAccess = settingsAccess(next);
      setSettings(next); setForm(toForm(next)); onAccessLoaded(nextAccess); setNotice('서버 위키 설정을 저장했습니다. 공개 문서와 편집기에 즉시 반영됩니다.');
    } catch (value) { setError(value instanceof Error ? value.message : '서버 위키 설정을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="flex min-h-[35vh] items-center justify-center"><Loader2 className="size-6 animate-spin text-emerald-300" /></div>;
  if (!settings) return <Message tone="error">{error ?? '설정을 불러오지 못했습니다.'}</Message>;

  return (
    <section className="space-y-6">
      {error ? <Message tone="error">{error}</Message> : null}
      {notice ? <Message tone="success">{notice}</Message> : null}
      {conflictVersion !== null ? <div className="flex flex-col gap-3 rounded-xl border border-amber-300/25 bg-amber-400/10 p-4 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between"><span>다른 관리자의 변경이 먼저 저장되었습니다. 현재 버전은 {conflictVersion}입니다.</span><button type="button" onClick={() => void load()} className="btn-secondary min-h-11">최신 설정 다시 불러오기</button></div> : null}
      {settings.access.canManageLayout ? <SiteAddressForm serverId={serverId} initialSiteSlug={settings.siteSlug} /> : null}
      <section className="rounded-xl border border-sky-300/20 bg-sky-400/[0.04] p-4 sm:p-5">
        <div><strong className="text-sm text-white">검색 및 링크 공유</strong><p className="mt-1 text-xs leading-5 text-slate-400">검색 결과와 Discord 등 링크 미리보기에 사용할 정보입니다. 저장 후 다음 서버 위키 릴리스가 게시될 때 공개됩니다.</p></div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label className="grid gap-2 text-sm text-slate-300">사이트 제목<input value={form.seoTitle ?? ''} onChange={(event) => setForm((current) => ({ ...current, seoTitle: event.target.value }))} maxLength={70} placeholder="기본값: 서버 이름 + 위키" className="input min-h-11" /></label>
          <label className="grid gap-2 text-sm text-slate-300">사이트 설명<input value={form.seoDescription ?? ''} onChange={(event) => setForm((current) => ({ ...current, seoDescription: event.target.value }))} maxLength={200} placeholder="비워 두면 공개 문서 내용으로 생성합니다." className="input min-h-11" /></label>
        </div>
        <label className="mt-4 flex min-h-11 items-center gap-3 text-sm text-slate-200"><input type="checkbox" checked={form.seoIndexingEnabled} onChange={(event) => setForm((current) => ({ ...current, seoIndexingEnabled: event.target.checked }))} className="h-5 w-5 accent-emerald-400" />공개 릴리스의 검색엔진 색인 허용</label>
        <div className="mt-4 rounded-lg border border-white/10 bg-[#0d1219] p-4"><p className="text-xs text-slate-500">검색 미리보기</p><p className="mt-2 text-base font-semibold text-sky-300">{form.seoTitle?.trim() || '서버 이름 위키'}</p><p className="mt-1 line-clamp-2 text-sm text-slate-400">{form.seoDescription?.trim() || '공개 문서 내용에서 설명을 자동 생성합니다.'}</p></div>
      </section>
      <div className="grid gap-6 xl:grid-cols-2">
        <SourceEditor label="기여 정책" description="편집 전에 기여자가 확인할 운영 원칙입니다." field="contributionPolicySource" value={form.contributionPolicySource} bytes={byteCounts.contributionPolicySource} onChange={(value) => setForm((current) => ({ ...current, contributionPolicySource: value }))} />
        <SourceEditor label="편집 도움말" description="문서 문체, 분류와 작성 규칙을 안내합니다." field="editHelpSource" value={form.editHelpSource} bytes={byteCounts.editHelpSource} onChange={(value) => setForm((current) => ({ ...current, editHelpSource: value }))} />
        <SourceEditor label="문서 상단 공지" description="모든 서버 위키 문서 본문 위에 표시됩니다." field="topNoticeSource" value={form.topNoticeSource} bytes={byteCounts.topNoticeSource} onChange={(value) => setForm((current) => ({ ...current, topNoticeSource: value }))} compact />
        <SourceEditor label="문서 하단 공지" description="모든 서버 위키 문서 본문 아래에 표시됩니다." field="bottomNoticeSource" value={form.bottomNoticeSource} bytes={byteCounts.bottomNoticeSource} onChange={(value) => setForm((current) => ({ ...current, bottomNoticeSource: value }))} compact />
      </div>
      <label className={`flex min-h-14 items-start gap-3 rounded-xl border p-4 ${form.contributionPolicySource?.trim() ? 'cursor-pointer border-emerald-400/25 bg-emerald-400/[0.06]' : 'border-white/10 bg-white/[0.02] opacity-60'}`}>
        <input type="checkbox" checked={form.requireContributionPolicyAck} disabled={!form.contributionPolicySource?.trim()} onChange={(event) => setForm((current) => ({ ...current, requireContributionPolicyAck: event.target.checked }))} className="mt-0.5 h-5 w-5 accent-emerald-400" />
        <span className="text-sm text-slate-200"><strong className="text-white">편집 전 기여 정책 동의 필수</strong><span className="mt-1 block text-xs leading-5 text-slate-400">정책 내용이나 필수 여부를 변경하면 정책 버전이 올라가며, 열린 편집 요청도 최신 버전 확인이 필요합니다.</span></span>
      </label>
      <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-white/10 bg-[#10161e]/95 p-4 shadow-2xl backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className={`text-xs ${invalid || totalBytes > 20 * 1024 ? 'text-red-300' : 'text-slate-400'}`}>전체 {totalBytes.toLocaleString()} / 20,480 bytes · 설정 v{settings.version} · 정책 v{settings.contributionPolicyVersion}</p>
        <button type="button" onClick={() => void save()} disabled={!dirty || invalid || totalBytes > 20 * 1024 || saving} className="btn-primary min-h-11 min-w-36 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}설정 저장</button>
      </div>
    </section>
  );
}

function SiteAddressForm({ serverId, initialSiteSlug }: { readonly serverId: string; readonly initialSiteSlug: string }) {
  const baseUrl = normalizeApiBaseUrl();
  const [savedSlug, setSavedSlug] = useState(initialSiteSlug);
  const [siteSlug, setSiteSlug] = useState(initialSiteSlug);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const valid = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(siteSlug);

  async function saveSiteSlug() {
    if (!valid || siteSlug === savedSlug || saving) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`${baseUrl}/v1/servers/${encodeURIComponent(serverId)}/wiki-site-slug`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(await csrfHeaders()) },
        body: JSON.stringify({ siteSlug }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? '서버 위키 주소를 변경하지 못했습니다.');
      setSavedSlug(body.siteSlug); setSiteSlug(body.siteSlug);
      setMessage({ tone: 'success', text: '서버 위키 주소를 변경했습니다. 기존 주소는 새 주소로 연결됩니다.' });
    } catch (value) {
      setMessage({ tone: 'error', text: value instanceof Error ? value.message : '서버 위키 주소를 변경하지 못했습니다.' });
    } finally { setSaving(false); }
  }

  return <div className="rounded-xl border border-emerald-300/15 bg-emerald-400/[0.04] p-4 sm:p-5">
    <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300"><Link2 className="size-4" aria-hidden="true" /></span><div><strong className="text-sm text-white">서버 위키 사이트 주소</strong><p className="mt-1 text-xs leading-5 text-slate-400">문서의 내부 경로와 분리된 고유 주소입니다. 영문 소문자, 숫자, 하이픈으로 3~63자를 입력하세요.</p></div></div>
    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"><label className="min-w-0 flex-1"><span className="sr-only">서버 위키 사이트 주소</span><span className="flex min-h-11 overflow-hidden rounded-lg border border-white/10 bg-[#0d1219] focus-within:border-emerald-300/50"><span className="flex items-center border-r border-white/10 px-3 text-xs text-slate-500">minewiki.kr/serverWiki/</span><input value={siteSlug} onChange={(event) => setSiteSlug(event.target.value.trim().toLowerCase())} maxLength={63} spellCheck={false} className="min-w-0 flex-1 bg-transparent px-3 text-sm text-white outline-none" /></span></label><button type="button" onClick={() => void saveSiteSlug()} disabled={!valid || siteSlug === savedSlug || saving} className="btn-primary min-h-11 shrink-0 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}주소 저장</button><a href={`/serverWiki/${encodeURIComponent(savedSlug)}`} className="btn-secondary min-h-11 shrink-0" target="_blank" rel="noreferrer">열기<ExternalLink className="size-4" /></a></div>
    {!valid && siteSlug.length > 0 ? <p className="mt-2 text-xs text-red-300">영문 소문자, 숫자, 하이픈 조합으로 3~63자를 입력하세요.</p> : null}
    {message ? <div className="mt-3"><Message tone={message.tone}>{message.text}</Message></div> : null}
  </div>;
}

function SourceEditor({ label, description, field, value, bytes: size, onChange, compact = false }: { readonly label: string; readonly description: string; readonly field: SourceField; readonly value: string | null; readonly bytes: number; readonly onChange: (value: string) => void; readonly compact?: boolean }) {
  const limit = FIELD_LIMITS[field];
  return <label className="block rounded-xl border border-white/10 bg-white/[0.025] p-4"><span className="flex items-center justify-between gap-3"><strong className="text-sm text-white">{label}</strong><span className={`text-[11px] ${size > limit ? 'text-red-300' : 'text-slate-500'}`}>{size.toLocaleString()} / {limit.toLocaleString()} bytes</span></span><span className="mt-1 block text-xs leading-5 text-slate-400">{description}</span><textarea value={value ?? ''} onChange={(event) => onChange(event.target.value)} spellCheck={false} className={`${compact ? 'min-h-32' : 'min-h-56'} mt-4 w-full resize-y rounded-lg border border-white/10 bg-[#0d1219] p-3 font-mono text-sm leading-6 text-slate-100 outline-none focus:border-emerald-300/50`} placeholder="MineWiki 마크업으로 입력하세요." /></label>;
}

function Tab({ id, controls, active, onClick, onKeyDown, buttonRef, icon, children }: { readonly id: string; readonly controls: string; readonly active: boolean; readonly onClick: () => void; readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void; readonly buttonRef: (node: HTMLButtonElement | null) => void; readonly icon: ReactNode; readonly children: ReactNode }) {
  return <button ref={buttonRef} id={id} type="button" role="tab" aria-controls={controls} aria-selected={active} tabIndex={active ? 0 : -1} onClick={onClick} onKeyDown={onKeyDown} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold leading-5 transition sm:gap-2 sm:px-3 sm:text-sm ${active ? 'bg-emerald-400/10 text-emerald-300' : 'text-slate-400 hover:text-white'}`}>{icon}<span>{children}</span></button>;
}

function TabPanel({ id, labelledBy, active, children }: { readonly id: string; readonly labelledBy: string; readonly active: boolean; readonly children: ReactNode }) {
  return <div id={id} role="tabpanel" aria-labelledby={labelledBy} hidden={!active} tabIndex={active ? 0 : -1} className="outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 focus-visible:ring-offset-4 focus-visible:ring-offset-[#0d1219]">{children}</div>;
}

function Message({ tone, children }: { readonly tone: 'error' | 'success'; readonly children: React.ReactNode }) {
  return <div className={`flex gap-3 rounded-xl border p-4 text-sm ${tone === 'error' ? 'border-red-300/20 bg-red-500/10 text-red-100' : 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100'}`}>{tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 flex-none" /> : null}<span>{children}</span></div>;
}

function toForm(settings: ContentSettings): FormState { return { contributionPolicySource: settings.contributionPolicySource, editHelpSource: settings.editHelpSource, topNoticeSource: settings.topNoticeSource, bottomNoticeSource: settings.bottomNoticeSource, requireContributionPolicyAck: settings.requireContributionPolicyAck, seoTitle: settings.seoTitle, seoDescription: settings.seoDescription, seoIndexingEnabled: settings.seoIndexingEnabled }; }
function normalizeForm(form: FormState): FormState { const clean = (value: string | null) => value?.trim() ? value.replaceAll('\r\n', '\n').trim() : null; const cleanSeo = (value: string | null) => value ? Array.from(value, (character) => { const code = character.codePointAt(0) ?? 0; return code <= 31 || code === 127 ? ' ' : character; }).join('').replace(/\s+/gu, ' ').trim() || null : null; const contributionPolicySource = clean(form.contributionPolicySource); return { contributionPolicySource, editHelpSource: clean(form.editHelpSource), topNoticeSource: clean(form.topNoticeSource), bottomNoticeSource: clean(form.bottomNoticeSource), requireContributionPolicyAck: Boolean(contributionPolicySource && form.requireContributionPolicyAck), seoTitle: cleanSeo(form.seoTitle), seoDescription: cleanSeo(form.seoDescription), seoIndexingEnabled: form.seoIndexingEnabled }; }
function serializeForm(form: FormState): string { return JSON.stringify(normalizeForm(form)); }
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function settingsAccess(settings: ContentSettings): SettingsAccess {
  if (settings.access?.canManageContentSettings !== true) throw new Error('서버 위키 설정 권한 응답이 올바르지 않습니다.');
  return {
    canManageContentSettings: true,
    canManageLayout: settings.access.canManageLayout === true,
    canManageCollaborators: settings.access.canManageCollaborators === true,
  };
}
