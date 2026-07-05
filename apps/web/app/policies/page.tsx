import { PolicyCenter } from '../../components/policies/policy-center';
import { createPageMetadata } from '../../lib/metadata';

export const metadata = createPageMetadata({
  title: '운영 정책 센터',
  description:
    'MineWiki 서비스 이용약관, 개인정보처리방침, 운영/투표 정책 및 개정 이력을 확인하세요.',
  path: '/policies',
});

interface PageProps {
  readonly searchParams?: Promise<{
    readonly category?: string;
    readonly q?: string;
    readonly sort?: string;
  }>;
}

function toCategory(value?: string) {
  if (value === 'terms' || value === 'privacy' || value === 'operations' || value === 'voting') {
    return value;
  }
  return 'all';
}

function toSort(value?: string) {
  if (value === 'importance') {
    return 'importance';
  }
  return 'latest';
}

export default async function PoliciesIndexPage({ searchParams }: PageProps) {
  const params = await searchParams;

  return (
    <PolicyCenter
      initialCategory={toCategory(params?.category)}
      initialKeyword={params?.q ?? ''}
      initialSort={toSort(params?.sort)}
    />
  );
}
