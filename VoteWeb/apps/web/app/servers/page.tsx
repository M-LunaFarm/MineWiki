import type { ServerSummary } from '@creepervote/schemas';
import { fetchServerSummaries } from '../../lib/api';
import {
  ServerListExplorer,
  type ServerListInitialFilters,
} from '../../components/servers/server-list-explorer';
import { createPageMetadata } from '../../lib/metadata';

interface PageProps {
  readonly searchParams?:
    | {
        edition?: string | string[];
        tag?: string | string[];
        search?: string | string[];
        sort?: string | string[];
        grade?: string | string[];
        page?: string | string[];
      }
    | Promise<{
        edition?: string | string[];
        tag?: string | string[];
        search?: string | string[];
        sort?: string | string[];
        grade?: string | string[];
        page?: string | string[];
      }>;
}

export const metadata = createPageMetadata({
  title: '마인크래프트 서버 목록',
  description: '한국 마인크래프트 서버를 접속 상태, 투표, 리뷰, 에디션 기준으로 비교하세요.',
  path: '/servers',
});

export const revalidate = 60;

export default async function ServerListPage({ searchParams }: PageProps) {
  const resolvedParams = searchParams instanceof Promise ? await searchParams : searchParams;
  const toSingleValue = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value);

  const editionParam = toSingleValue(resolvedParams?.edition);
  const tagParam = toSingleValue(resolvedParams?.tag);
  const searchParam = toSingleValue(resolvedParams?.search);
  const sortParam = toSingleValue(resolvedParams?.sort);
  const gradeParam = toSingleValue(resolvedParams?.grade);
  const pageParam = toSingleValue(resolvedParams?.page);

  const initialSort: ServerListInitialFilters['sort'] =
    sortParam === 'reviews_desc' || sortParam === 'latest' ? sortParam : 'votes24h_desc';

  const initialFilters: ServerListInitialFilters = {
    search: searchParam ?? '',
    edition: editionParam === 'java' || editionParam === 'bedrock' ? editionParam : 'all',
    grade: gradeParam === 'Verified' || gradeParam === 'Unverified' ? gradeParam : 'all',
    sort: initialSort,
    tags: tagParam
      ? tagParam
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    page: pageParam && Number(pageParam) > 0 ? Number(pageParam) : 1,
  };

  let servers: ServerSummary[] = [];
  try {
    servers = await fetchServerSummaries();
  } catch (error) {
    console.error('Failed to load server list page data', error);
  }

  return <ServerListExplorer servers={servers} initialFilters={initialFilters} />;
}
