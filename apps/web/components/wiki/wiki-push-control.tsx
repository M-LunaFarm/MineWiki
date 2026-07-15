'use client';

import { AlertTriangle, BellOff, BellRing, Loader2, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  fetchWikiPushStatus,
  registerWikiPushSubscription,
  unregisterWikiPushSubscription,
} from '../../lib/wiki-api';
import {
  decodeVapidPublicKey,
  isIosWithoutStandaloneInstall,
  pushEndpointFingerprint,
  pushSubscriptionMatchesKey,
  supportsWebPush,
} from '../../lib/web-push';

type PushUiState = 'loading' | 'unsupported' | 'disabled' | 'denied' | 'off' | 'on' | 'stale';

export function WikiPushControl() {
  const [state, setState] = useState<PushUiState>('loading');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iosInstallRequired, setIosInstallRequired] = useState(false);

  useEffect(() => {
    let active = true;
    setIosInstallRequired(isIosWithoutStandaloneInstall());
    void inspectPushState().then((next) => { if (active) setState(next); }).catch(() => {
      if (active) { setState('off'); setError('브라우저 알림 상태를 확인하지 못했습니다.'); }
    });
    return () => { active = false; };
  }, []);

  async function enable() {
    if (!supportsWebPush()) { setState('unsupported'); return; }
    setWorking(true); setError(null);
    let subscriptionForRollback: PushSubscription | null = null;
    try {
      const status = await fetchWikiPushStatus();
      if (!status.enabled || !status.publicKey) { setState('disabled'); return; }
      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== 'granted') { setState('denied'); return; }

      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !pushSubscriptionMatchesKey(subscription, status.publicKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(status.publicKey),
      });
      subscriptionForRollback = subscription;
      const value = subscription.toJSON();
      if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
        throw new Error('브라우저가 완전한 알림 구독 정보를 제공하지 않았습니다.');
      }
      await registerWikiPushSubscription({
        endpoint: value.endpoint,
        expirationTime: value.expirationTime ?? null,
        keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
      });
      subscriptionForRollback = null;
      setState('on');
    } catch (caught) {
      await subscriptionForRollback?.unsubscribe().catch(() => false);
      setError(caught instanceof Error ? caught.message : '브라우저 알림을 활성화하지 못했습니다.');
      setState('off');
    } finally { setWorking(false); }
  }

  async function disable() {
    setWorking(true); setError(null);
    try {
      await unregisterWikiPushSubscription();
      if (supportsWebPush()) {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      }
      setState('off');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '브라우저 알림을 해제하지 못했습니다.');
    } finally { setWorking(false); }
  }

  const copy = pushStateCopy(state);
  return <section aria-labelledby="wiki-push-title" className="border border-white/10 bg-[#0d1219] p-4 sm:p-5">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-0.5 flex size-10 flex-none items-center justify-center rounded-full ${state === 'on' ? 'bg-emerald-300/10 text-emerald-300' : 'bg-white/[0.05] text-slate-400'}`}>
          {state === 'on' ? <BellRing className="size-5" /> : <BellOff className="size-5" />}
        </span>
        <div className="min-w-0">
          <h2 id="wiki-push-title" className="font-semibold text-white">이 기기에서 알림 받기</h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">{copy}</p>
          {iosInstallRequired ? <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-200"><Smartphone className="mt-0.5 size-3.5 flex-none" /> iPhone·iPad에서는 MineWiki를 홈 화면에 추가한 뒤 사용할 수 있습니다.</p> : null}
        </div>
      </div>
      {state === 'loading' ? <span className="chip chip-muted inline-flex min-h-11 items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> 확인 중</span>
        : state === 'on' ? <button type="button" disabled={working} onClick={() => void disable()} className="chip chip-muted inline-flex min-h-11 w-full items-center justify-center gap-2 sm:w-auto">{working ? <Loader2 className="size-4 animate-spin" /> : <BellOff className="size-4" />} 이 기기 알림 해제</button>
          : <button type="button" disabled={working || state === 'unsupported' || state === 'disabled' || state === 'denied' || iosInstallRequired} onClick={() => void enable()} className="chip chip-accent inline-flex min-h-11 w-full items-center justify-center gap-2 disabled:opacity-45 sm:w-auto">{working ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />} {state === 'stale' ? '알림 다시 연결' : '알림 켜기'}</button>}
    </div>
    {error ? <p role="alert" className="mt-3 flex items-start gap-2 border-t border-red-300/15 pt-3 text-sm text-red-200"><AlertTriangle className="mt-0.5 size-4 flex-none" /> {error}</p> : null}
    <p className="mt-3 border-t border-white/[0.07] pt-3 text-xs leading-5 text-slate-600">잠금 화면에는 문서명이나 댓글 내용 대신 새 알림이 있다는 사실만 표시합니다. 자세한 내용은 로그인 후 알림함에서 확인합니다.</p>
  </section>;
}

async function inspectPushState(): Promise<PushUiState> {
  const status = await fetchWikiPushStatus();
  if (!status.enabled || !status.publicKey) return 'disabled';
  if (!supportsWebPush()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return status.subscribed ? 'stale' : 'off';
  if (!pushSubscriptionMatchesKey(subscription, status.publicKey)) return 'stale';
  if (status.endpointFingerprint !== await pushEndpointFingerprint(subscription.endpoint)) return 'stale';
  return status.subscribed ? 'on' : 'stale';
}

function pushStateCopy(state: PushUiState): string {
  if (state === 'loading') return '현재 브라우저의 알림 연결 상태를 확인하고 있습니다.';
  if (state === 'on') return '멘션, 토론 답글, 관심 문서 변경을 브라우저 알림으로 받습니다.';
  if (state === 'stale') return '브라우저와 MineWiki의 연결 정보가 달라 다시 연결해야 합니다.';
  if (state === 'denied') return '브라우저에서 알림 권한이 차단되어 있습니다. 사이트 설정에서 허용해 주세요.';
  if (state === 'unsupported') return '이 브라우저 또는 현재 접속 환경에서는 Web Push를 지원하지 않습니다.';
  if (state === 'disabled') return '서비스 알림 발송 준비 중입니다. 알림함은 계속 사용할 수 있습니다.';
  return '버튼을 누른 경우에만 브라우저 권한을 요청합니다.';
}
