import { Suspense, use } from 'react';
import { OAuthCallbackClient } from './callback-client';
import { createPageMetadata } from '../../../../lib/metadata';
import {
  CallbackShell,
} from '../../../../components/auth/callback-shell';

export const metadata = createPageMetadata({
  title: '계정 인증 처리',
  description: '외부 계정 인증 응답을 확인하고 MineWiki 세션을 준비합니다.',
  path: '/auth/callback',
  noIndex: true,
});

interface PageParams {
  readonly provider: string;
}

interface PageProps {
  readonly params: Promise<PageParams>;
}

export default function OAuthCallbackPage({ params }: PageProps) {
  const resolved = use(params);
  return (
    <Suspense fallback={<CallbackFallback />}>
      <OAuthCallbackClient provider={resolved.provider} />
    </Suspense>
  );
}

function CallbackFallback() {
  return (
    <CallbackShell
      eyebrow="계정 인증"
      title="계정 인증 응답을 확인하고 있습니다."
      subtitle="콜백 파라미터를 읽고 세션 처리를 준비하는 중입니다."
      status="pending"
    >
      <div className="space-y-4">
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full w-2/3 animate-pulse bg-[#35e5b7]" />
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-[#0d1416] px-4 py-4">
          <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-[#35e5b7]" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-white">간편 로그인 확인 중</p>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              잠시 후 인증 결과 화면으로 이어집니다.
            </p>
          </div>
        </div>
      </div>
    </CallbackShell>
  );
}
