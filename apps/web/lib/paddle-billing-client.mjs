const CHECKOUT_HOSTS = new Set([
  'checkout.paddle.com',
  'pay.paddle.io',
  'sandbox-checkout.paddle.com',
  'sandbox.pay.paddle.io',
]);

export function validatedPaddleRedirectUrl(value, kind, currentOrigin) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  let origin;
  try {
    url = new URL(value);
    origin = new URL(currentOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (kind === 'portal') {
    return ['customer-portal.paddle.com', 'sandbox-customer-portal.paddle.com'].includes(url.hostname)
      ? url.toString()
      : null;
  }
  const approvedMineWikiCheckout = url.origin === origin.origin
    && (url.pathname === '/billing/checkout' || url.pathname.startsWith('/billing/checkout/'));
  return approvedMineWikiCheckout || CHECKOUT_HOSTS.has(url.hostname) ? url.toString() : null;
}

export function billingActionError(status, action, providerMessage) {
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인한 뒤 시도해 주세요.';
  if (status === 403) return '이 서버의 결제를 관리할 권한이 없습니다.';
  if (status === 404 && action === 'portal') return '관리할 수 있는 Paddle 구독이 없습니다.';
  if (status === 409 && action === 'checkout') return '이미 활성 결제가 있습니다. 결제 관리에서 확인해 주세요.';
  if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 502 || status === 503) return 'Paddle 결제 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하거나 지원팀에 문의해 주세요.';
  return typeof providerMessage === 'string' && providerMessage.trim()
    ? providerMessage.trim().slice(0, 300)
    : '결제 요청을 완료하지 못했습니다.';
}

export function billingSupportHref(serverId, layoutKey) {
  const params = new URLSearchParams({
    category: 'server_claim',
    serverId,
    subject: `서버 위키 ${layoutKey} 요금제 문의`,
    body: `서버 위키 레이아웃 ${layoutKey} 요금제와 결제 방법을 문의합니다.\n서버 ID: ${serverId}`,
  });
  return `/support/new?${params.toString()}`;
}
