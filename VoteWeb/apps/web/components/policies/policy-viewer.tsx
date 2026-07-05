'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Link as LinkIcon } from 'lucide-react';

interface PolicySection {
  readonly heading: string;
  readonly body: readonly string[];
}

export interface PolicyVersion {
  readonly id: string;
  readonly label: string;
  readonly effectiveDate: string;
  readonly summary?: string;
  readonly changeNotes?: readonly string[];
  readonly sections: readonly PolicySection[];
}

interface PolicyViewerProps {
  readonly documentName: string;
  readonly versions: readonly PolicyVersion[];
}

function sectionSlug(heading: string) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function formatDate(value: string) {
  const normalized = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (normalized) {
    return `${normalized[1]}.${normalized[2]}.${normalized[3]}.`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const year = String(parsed.getUTCFullYear());
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `${year}.${month}.${day}.`;
}

export function PolicyViewer({ documentName, versions }: PolicyViewerProps) {
  const sortedVersions = useMemo(
    () =>
      [...versions].sort(
        (a, b) => Number(new Date(b.effectiveDate)) - Number(new Date(a.effectiveDate)),
      ),
    [versions],
  );
  const hasMultipleVersions = sortedVersions.length > 1;

  const [selectedVersionId, setSelectedVersionId] = useState(() => sortedVersions[0]?.id ?? '');
  const selectedVersion =
    sortedVersions.find((version) => version.id === selectedVersionId) ?? sortedVersions[0];

  if (!selectedVersion) {
    return (
      <div className="border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-200">
        정책 문서를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-6xl">
      <div className="mb-5">
        <Link
          href="/policies"
          className="inline-flex items-center gap-2 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 transition hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" />
          정책 센터로 돌아가기
        </Link>
      </div>

      <div className="grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-28 lg:h-fit">
          <div className="border border-white/10">
            <div className="border-b border-white/10 p-4">
              <p className="text-xs font-semibold text-slate-500">정책 문서</p>
              <h2 className="mt-1 text-base font-semibold text-slate-50">{documentName}</h2>
              <p className="mt-2 font-mono text-xs text-slate-400">
                시행 {formatDate(selectedVersion.effectiveDate)}
              </p>
            </div>

            {hasMultipleVersions ? (
              <div className="border-b border-white/10 p-4">
                <label className="block text-xs font-semibold text-slate-500" htmlFor="policy-version">
                  개정 버전
                </label>
                <select
                  id="policy-version"
                  className="mt-2 h-10 w-full border border-white/10 bg-[#0f0f0f] px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
                  value={selectedVersion.id}
                  onChange={(event) => setSelectedVersionId(event.target.value)}
                >
                  {sortedVersions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.label} / 시행 {formatDate(version.effectiveDate)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <nav aria-label="문서 목차" className="max-h-[calc(100vh-16rem)] overflow-y-auto p-2">
              {selectedVersion.sections.map((section, index) => {
                const anchor = sectionSlug(section.heading);
                return (
                  <a
                    key={`${selectedVersion.id}-${section.heading}`}
                    href={`#${anchor}`}
                    className={`block border-l-2 px-3 py-2 text-xs leading-5 transition ${
                      index === 0
                        ? 'border-emerald-300 bg-white/[0.04] text-slate-100'
                        : 'border-transparent text-slate-400 hover:bg-white/[0.03] hover:text-slate-100'
                    }`}
                  >
                    {section.heading}
                  </a>
                );
              })}
            </nav>
          </div>
        </aside>

        <div className="min-w-0 border border-white/10">
          <header className="border-b border-white/10 p-5 md:p-7">
            <p className="text-xs font-semibold text-slate-500">Lunaf.kr</p>
            <h1 className="mt-2 text-2xl font-semibold leading-tight text-slate-50 md:text-3xl">
              {selectedVersion.label}
            </h1>

            <dl className="mt-5 grid gap-px overflow-hidden border border-white/10 bg-white/10 text-xs sm:grid-cols-3">
              <div className="bg-[#121212] px-4 py-3">
                <dt className="text-slate-500">문서명</dt>
                <dd className="mt-1 text-slate-100">{documentName}</dd>
              </div>
              <div className="bg-[#121212] px-4 py-3">
                <dt className="text-slate-500">시행일</dt>
                <dd className="mt-1 font-mono text-slate-100">
                  {formatDate(selectedVersion.effectiveDate)}
                </dd>
              </div>
              <div className="bg-[#121212] px-4 py-3">
                <dt className="text-slate-500">목차</dt>
                <dd className="mt-1 font-mono text-slate-100">
                  {selectedVersion.sections.length}개 조항
                </dd>
              </div>
            </dl>

            {selectedVersion.summary ? (
              <p className="mt-5 max-w-3xl text-sm leading-6 text-slate-300">{selectedVersion.summary}</p>
            ) : null}
          </header>

          {selectedVersion.changeNotes && selectedVersion.changeNotes.length > 0 ? (
            <section className="border-b border-white/10 px-5 py-4 md:px-7" aria-labelledby="revision-heading">
              <h2 id="revision-heading" className="text-sm font-semibold text-slate-100">
                이번 개정 주요 사항
              </h2>
              <ul className="mt-3 space-y-1.5 text-sm leading-6 text-slate-300">
                {selectedVersion.changeNotes.map((note, index) => (
                  <li key={`change-${index}`}>{note}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="divide-y divide-white/10">
            {selectedVersion.sections.map((section) => {
              const anchor = sectionSlug(section.heading);
              return (
                <section
                  key={`${selectedVersion.id}-${section.heading}`}
                  id={anchor}
                  className="scroll-mt-28 px-5 py-6 md:px-7"
                >
                  <h2 className="group flex items-start gap-2 text-lg font-semibold leading-7 text-slate-50">
                    <span>{section.heading}</span>
                    <a
                      href={`#${anchor}`}
                      className="mt-1 text-slate-600 transition hover:text-slate-200"
                      aria-label={`${section.heading} 링크`}
                    >
                      <LinkIcon className="h-4 w-4" />
                    </a>
                  </h2>

                  <div className="mt-4 space-y-3 text-sm leading-7 text-slate-300">
                    {section.body.map((paragraph, index) => (
                      <p key={`${section.heading}-${index}`}>{paragraph}</p>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <footer className="border-t border-white/10 p-5 md:p-7">
            <div className="flex items-start gap-3 border border-yellow-500/20 bg-yellow-500/10 p-4 text-yellow-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs leading-5">
                {hasMultipleVersions
                  ? '정책 문서는 버전별로 관리됩니다. 실제 효력은 시행일 기준 최신 버전에 따릅니다.'
                  : '이 문서는 현재 단일 최신 버전만 제공합니다.'}
              </p>
            </div>
          </footer>
        </div>
      </div>
    </article>
  );
}
