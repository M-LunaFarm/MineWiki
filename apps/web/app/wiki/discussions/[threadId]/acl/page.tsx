import { WikiThreadAclClient } from '../../../../../components/wiki/wiki-thread-acl-client';

interface PageProps {
  readonly params: Promise<{ threadId: string }>;
  readonly searchParams: Promise<{ returnTo?: string }>;
}

export default async function WikiThreadAclPage({ params, searchParams }: PageProps) {
  const [{ threadId }, query] = await Promise.all([params, searchParams]);
  return <WikiThreadAclClient threadId={threadId} returnTo={safeReturnTo(query.returnTo)} />;
}

function safeReturnTo(value?: string): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/wiki/discussions';
}
