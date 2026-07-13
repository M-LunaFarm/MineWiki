import { WikiNotificationsClient } from '../../../components/wiki/wiki-notifications-client';

export default function WikiNotificationsPage() {
  return <section className="mx-auto w-full max-w-4xl space-y-7">
    <header className="border-b border-white/10 pb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Notifications</p>
      <h1 className="mt-3 text-3xl font-bold text-white">위키 알림</h1>
      <p className="mt-3 text-sm leading-6 text-slate-400">관심 문서 변경, 참여한 토론의 답글, 편집 요청 처리 결과를 확인합니다.</p>
    </header>
    <WikiNotificationsClient />
  </section>;
}
