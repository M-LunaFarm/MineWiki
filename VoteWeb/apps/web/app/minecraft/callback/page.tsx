import { MinecraftCallbackClient } from './callback-client';
import { createPageMetadata } from '../../../lib/metadata';

export const metadata = createPageMetadata({
  title: 'Minecraft 소유권 확인',
  description: 'Minecraft 계정 소유권 확인 응답을 처리합니다.',
  path: '/minecraft/callback',
  noIndex: true,
});

interface PageProps {
  readonly searchParams?: Promise<{
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>;
}

export default async function MinecraftCallbackPage({ searchParams }: PageProps) {
  const params = searchParams ? await searchParams : {};
  return (
    <MinecraftCallbackClient
      code={params.code}
      state={params.state}
      error={params.error}
      errorDescription={params.error_description}
    />
  );
}
