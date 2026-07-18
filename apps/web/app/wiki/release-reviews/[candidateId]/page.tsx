import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServerWikiReleaseReviewDetailClient } from '../../../../components/wiki/server-wiki-release-review-client';

export const metadata: Metadata = { title: '릴리스 후보 검토', robots: { index: false, follow: false } };

export default async function ServerWikiReleaseReviewDetailPage({ params }: { readonly params: Promise<{ candidateId: string }> }) {
  const { candidateId } = await params;
  if (!/^[1-9][0-9]{0,19}$/u.test(candidateId)) notFound();
  return <section className="mx-auto w-full max-w-5xl"><ServerWikiReleaseReviewDetailClient candidateId={candidateId} /></section>;
}
