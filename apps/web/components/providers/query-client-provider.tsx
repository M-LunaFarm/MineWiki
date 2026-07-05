"use client";

import {
  QueryClient,
  QueryClientProvider as BaseQueryClientProvider
} from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryClientProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1
          }
        }
      })
  );

  return <BaseQueryClientProvider client={client}>{children}</BaseQueryClientProvider>;
}
