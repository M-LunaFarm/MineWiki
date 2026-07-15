export const OAUTH_LINK_INTENT_KEY = 'minewiki.oauth-link-intent.v1';

const LINKABLE_PROVIDERS = new Set(['discord', 'naver']);

export function createOAuthLinkIntent({ provider, state, expiresAt }, now = Date.now()) {
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !LINKABLE_PROVIDERS.has(provider)
    || typeof state !== 'string'
    || state.length < 8
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= now
  ) {
    throw new Error('유효한 OAuth 계정 연결 요청만 저장할 수 있습니다.');
  }
  return JSON.stringify({ provider, state, expiresAt });
}

export function storeOAuthLinkIntent(storage, intent) {
  try {
    storage.setItem(OAUTH_LINK_INTENT_KEY, createOAuthLinkIntent(intent));
    return true;
  } catch {
    return false;
  }
}

export function closeOAuthWindowOrNavigate(windowRef, navigate, fallbackPath = '/me') {
  try {
    windowRef.close();
  } catch {
    // A browser may reject script-initiated closing for a same-window flow.
  }
  windowRef.setTimeout(() => {
    if (!windowRef.closed) navigate(fallbackPath);
  }, 100);
}

export function consumeOAuthLinkIntent(storage, { provider, state }, now = Date.now()) {
  let raw;
  try {
    raw = storage.getItem(OAUTH_LINK_INTENT_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;

  let intent;
  try {
    intent = JSON.parse(raw);
  } catch {
    removeOAuthLinkIntent(storage);
    return false;
  }

  const expiresAtMs = Date.parse(intent?.expiresAt);
  if (
    !LINKABLE_PROVIDERS.has(intent?.provider)
    || typeof intent?.state !== 'string'
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= now
  ) {
    removeOAuthLinkIntent(storage);
    return false;
  }
  if (intent.provider !== provider || intent.state !== state) return false;

  removeOAuthLinkIntent(storage);
  return true;
}

function removeOAuthLinkIntent(storage) {
  try {
    storage.removeItem(OAUTH_LINK_INTENT_KEY);
  } catch {
    // Storage can be unavailable in hardened or private browser contexts.
  }
}
