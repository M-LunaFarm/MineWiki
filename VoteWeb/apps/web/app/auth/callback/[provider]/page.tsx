import { Suspense, use } from 'react';
import { OAuthCallbackClient } from './callback-client';
import { createPageMetadata } from '../../../../lib/metadata';
import {
  CallbackCard,
  CallbackShell,
  CallbackSideStat,
} from '../../../../components/auth/callback-shell';

export const metadata = createPageMetadata({
  title: '계정 인증 처리',
  description: '외부 계정 인증 응답을 확인하고 Lunaf 세션을 준비합니다.',
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
      aside={
        <>
          <CallbackSideStat label="공급자" value="확인 중" />
          <CallbackSideStat label="모드" value="자동" />
          <CallbackSideStat label="상태" value="처리 중" />
        </>
      }
    >
      <CallbackCard status="pending" progressWidth="66%" footerLabel="Lunaf.kr OAuth">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-[#6b7280]">
          OAuth Callback
        </p>
        <p className="mt-3 text-lg font-semibold text-white">계정 인증 응답을 확인하고 있습니다.</p>
        <p className="mt-2 text-sm leading-6 text-[#a9b0ba]">
          잠시 후 인증 결과 화면으로 전환됩니다.
        </p>
      </CallbackCard>
    </CallbackShell>
  );
}
