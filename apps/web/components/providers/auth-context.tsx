'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  fetchCurrentAccount,
  loginEmail,
  logout as apiLogout,
  registerEmail,
  verifyEmail as apiVerifyEmail,
  resendVerification as apiResendVerification,
  startOAuthLogin,
  type AuthAccount,
  type OAuthProvider,
  type EmailRegistrationResult,
  type ResendVerificationResult,
} from '../../lib/auth-client';
import { unsubscribeCurrentBrowserPush } from '../../lib/web-push';

interface AuthContextValue {
  readonly account: AuthAccount | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly loginEmail: (payload: { email: string; password: string }) => Promise<void>;
  readonly registerEmail: (payload: {
    email: string;
    password: string;
    displayName?: string;
    agreeTerms: true;
    agreePrivacy: true;
  }) => Promise<EmailRegistrationResult>;
  readonly verifyEmail: (token: string) => Promise<void>;
  readonly resendVerification: (email: string) => Promise<ResendVerificationResult>;
  readonly loginOAuth: (provider: OAuthProvider, options: { returnTo?: string; agreeTerms?: boolean; agreePrivacy?: boolean; handoffDelayMs?: number }) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [account, setAccount] = useState<AuthAccount | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const current = await fetchCurrentAccount();
      setAccount(current);
    } catch (error) {
      console.warn('세션 확인 실패', error);
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      loading ||
      !account?.policyConsent?.required ||
      pathname.startsWith('/policies') ||
      pathname.startsWith('/auth/callback')
    ) {
      return;
    }
    const currentPath = `${pathname}${typeof window === 'undefined' ? '' : window.location.search}`;
    router.replace(`/policies/consent?returnTo=${encodeURIComponent(currentPath)}`);
  }, [account, loading, pathname, router]);

  const login = useCallback(async (payload: { email: string; password: string }) => {
    setLoading(true);
    try {
      const next = await loginEmail(payload);
      setAccount(next);
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(
    async (payload: {
      email: string;
      password: string;
      displayName?: string;
      agreeTerms: true;
      agreePrivacy: true;
    }) => {
      setLoading(true);
      try {
        const result = await registerEmail(payload);
        return result;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const verifyAccount = useCallback(async (token: string) => {
    setLoading(true);
    try {
      const verified = await apiVerifyEmail(token);
      setAccount(verified);
    } finally {
      setLoading(false);
    }
  }, []);

  const resend = useCallback(async (email: string) => {
    return apiResendVerification(email);
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.race([
        unsubscribeCurrentBrowserPush().catch(() => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1200)),
      ]);
      await apiLogout();
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loginOAuth = useCallback(
    async (provider: OAuthProvider, options: { returnTo?: string; agreeTerms?: boolean; agreePrivacy?: boolean; handoffDelayMs?: number }) => {
      if (typeof window === 'undefined') {
        throw new Error('OAuth 로그인이 클라이언트 환경에서만 지원됩니다.');
      }
      setLoading(true);
      try {
        const redirectUri = `${window.location.origin}/auth/callback/${provider}`;
        const result = await startOAuthLogin(provider, {
          redirectUri,
          returnTo: options?.returnTo,
          agreeTerms: options.agreeTerms === true,
          agreePrivacy: options.agreePrivacy === true,
        });
        const handoffDelayMs = Math.min(Math.max(options.handoffDelayMs ?? 0, 0), 1200);
        if (handoffDelayMs > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, handoffDelayMs));
        }
        setLoading(false);
        window.location.assign(result.authorizationUrl);
      } catch (error) {
        setLoading(false);
        throw error;
      }
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      account,
      loading,
      refresh,
      loginEmail: login,
      registerEmail: register,
      verifyEmail: verifyAccount,
      resendVerification: resend,
      loginOAuth,
      logout,
    }),
    [account, loading, refresh, login, register, verifyAccount, resend, loginOAuth, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth는 AuthProvider 내부에서만 사용할 수 있습니다.');
  }
  return context;
}
