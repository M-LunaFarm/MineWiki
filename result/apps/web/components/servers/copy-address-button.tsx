'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';

interface CopyAddressButtonProps {
  readonly address: string;
  readonly className?: string;
  readonly idleLabel?: string;
  readonly copiedLabel?: string;
  readonly children?: ReactNode;
}

export function CopyAddressButton({
  address,
  className,
  idleLabel = '주소 복사',
  copiedLabel = '복사 완료!',
  children,
}: CopyAddressButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className={
        className ??
        'rounded-lg border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-emerald-400/60 hover:text-emerald-200'
      }
    >
      {copied ? copiedLabel : children ?? idleLabel}
    </button>
  );
}
