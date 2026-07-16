'use client';

import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface WikiEditorLoadErrorProps {
  readonly title: string;
  readonly message: string;
  readonly backHref: string;
  readonly onRetry?: () => void;
}

export function WikiEditorLoadError({ title, message, backHref, onRetry }: WikiEditorLoadErrorProps) {
  const alertRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    alertRef.current?.focus();
  }, []);

  function retry() {
    if (onRetry) {
      onRetry();
      return;
    }
    window.location.reload();
  }

  return (
    <div className="mx-auto flex min-h-[50vh] w-full max-w-3xl items-center px-4 py-12">
      <div
        ref={alertRef}
        role="alert"
        tabIndex={-1}
        className="w-full rounded-xl border border-red-300/30 bg-red-500/10 p-5 outline-none focus-visible:ring-2 focus-visible:ring-red-200/70 sm:p-6"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 flex-none text-red-200" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-white">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-red-100">{message}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <button type="button" onClick={retry} className="btn-primary min-h-11 w-full gap-2 sm:w-auto">
            <RotateCcw className="size-4" />
            다시 시도
          </button>
          <Link href={backHref} className="btn-secondary min-h-11 w-full sm:w-auto">
            문서로 돌아가기
          </Link>
        </div>
      </div>
    </div>
  );
}
