/* eslint-disable @next/next/no-img-element */
import type { ServerDetail } from '@minewiki/schemas';
import {
  extractMarkdownImageUrls,
  renderSafeMarkdown,
  stripMarkdownImages,
} from '../../lib/markdown';
import { FileText, Images } from 'lucide-react';

interface ServerOverviewCardProps {
  readonly detail: ServerDetail;
}

export function ServerOverviewCard({ detail }: ServerOverviewCardProps) {
  const galleryImages = buildGalleryImages(detail);
  const sanitizedMarkdown = stripMarkdownImages(detail.longDescription);
  const descriptionHtml = renderSafeMarkdown(sanitizedMarkdown || detail.longDescription);

  return (
    <article className="space-y-8">
      <section className="surface-card p-6 md:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-lg bg-cyan-500/10 p-2 text-cyan-200">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">소개</p>
            <h3 className="mt-1 text-2xl font-bold text-white">서버 소개</h3>
          </div>
        </div>

        {descriptionHtml ? (
          <div
            className="prose prose-invert max-w-none space-y-3 text-[15px] leading-relaxed text-slate-300"
            dangerouslySetInnerHTML={{
              __html: descriptionHtml,
            }}
          />
        ) : (
          <p className="text-sm text-slate-500">등록된 서버 소개가 아직 없습니다.</p>
        )}
      </section>

      <section
        id="server-gallery"
        className="surface-card p-6 md:p-8"
      >
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-500/10 p-2 text-amber-200">
              <Images className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                미디어
              </p>
              <h4 className="mt-1 text-2xl font-bold text-white">갤러리</h4>
            </div>
          </div>
          <span className="chip chip-muted">
            {galleryImages.length}장
          </span>
        </div>

        {galleryImages.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {galleryImages.map((url, index) => (
              <a
                key={`${url}-${index}`}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="group overflow-hidden rounded-xl border border-white/[0.06] bg-[#0d1219]"
              >
                <img
                  src={url}
                  alt={`${detail.name} 갤러리 ${index + 1}`}
                  loading="lazy"
                  className="h-44 w-full object-cover transition duration-300 group-hover:scale-[1.03] group-hover:opacity-95"
                />
              </a>
            ))}
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] text-sm text-slate-500">
            등록된 갤러리 이미지가 없습니다.
          </div>
        )}
      </section>
    </article>
  );
}

function buildGalleryImages(detail: ServerDetail): string[] {
  const unique = new Set<string>();
  if (detail.bannerUrl && isRenderableImageUrl(detail.bannerUrl)) {
    unique.add(detail.bannerUrl);
  }

  for (const imageUrl of extractMarkdownImageUrls(detail.longDescription)) {
    if (isRenderableImageUrl(imageUrl)) {
      unique.add(imageUrl);
    }
  }

  return Array.from(unique);
}

function isRenderableImageUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
