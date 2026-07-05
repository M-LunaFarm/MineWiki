'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReviewGateStatus, ServerReview } from '@minewiki/schemas';
import { ReviewComposer } from './review-composer';

interface ReviewComposerModalProps {
  readonly open: boolean;
  readonly serverId: string;
  readonly apiBaseUrl?: string;
  readonly gateStatus: ReviewGateStatus;
  readonly onClose: () => void;
  readonly onSubmitted?: (review: ServerReview) => void;
  readonly onGateStatusRefresh?: () => void;
}

export function ReviewComposerModal({
  open,
  serverId,
  apiBaseUrl,
  gateStatus,
  onClose,
  onSubmitted,
  onGateStatusRefresh
}: ReviewComposerModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!open) {
      document.body.style.removeProperty('overflow');
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!mounted || !open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="relative w-full max-w-lg rounded-xl border border-[#30343b] bg-[#151922] p-5 shadow-2xl shadow-black/40">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full border border-[#30343b] bg-[#101216] px-2 py-1 text-xs font-semibold text-slate-300 transition hover:border-blue-400/60 hover:text-blue-100"
          aria-label="리뷰 작성 창 닫기"
        >
          닫기
        </button>
        <ReviewComposer
          serverId={serverId}
          apiBaseUrl={apiBaseUrl}
          gateStatus={gateStatus}
          onSubmitted={onSubmitted}
          onGateStatusRefresh={onGateStatusRefresh}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body
  );
}
