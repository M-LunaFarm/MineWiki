import type { Environments, Paddle } from '@paddle/paddle-js';

const TRANSACTION_ID_PATTERN = /^txn_[a-z0-9]{1,60}$/u;
const CLIENT_TOKEN_PATTERN = /^(live|test)_[A-Za-z0-9]{8,}$/u;

let paddlePromise: Promise<Paddle | undefined> | null = null;
let initializedEnvironment: Environments | null = null;

export async function openPaddleTransaction(
  transactionId: string,
  environment: Environments,
): Promise<boolean> {
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim() ?? '';
  if (!isCompatibleClientToken(token, environment) || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    return false;
  }
  try {
    if (!paddlePromise || initializedEnvironment !== environment) {
      initializedEnvironment = environment;
      paddlePromise = import('@paddle/paddle-js')
        .then(({ initializePaddle }) => initializePaddle({ token, environment }));
    }
    const paddle = await paddlePromise;
    if (!paddle) return false;
    paddle.Checkout.open({
      transactionId,
      settings: {
        displayMode: 'overlay',
        theme: 'dark',
        locale: 'ko',
        successUrl: window.location.href,
      },
    });
    return true;
  } catch {
    paddlePromise = null;
    initializedEnvironment = null;
    return false;
  }
}

export function isCompatibleClientToken(token: string, environment: Environments): boolean {
  if (!CLIENT_TOKEN_PATTERN.test(token)) return false;
  return environment === 'production' ? token.startsWith('live_') : token.startsWith('test_');
}
