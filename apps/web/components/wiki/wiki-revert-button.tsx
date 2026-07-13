'use client';

import { useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { revertWikiPage } from '../../lib/wiki-api';

interface WikiRevertButtonProps {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly currentRevisionId: string;
  readonly routePath: string;
}

export function WikiRevertButton(props: WikiRevertButtonProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revert() {
    if (!window.confirm(`r${props.revisionNo} 판의 내용으로 되돌릴까요? 이 작업은 새 판으로 기록됩니다.`)) return;
    setWorking(true);
    setError(null);
    try {
      await revertWikiPage({
        pageId: props.pageId,
        revisionId: props.revisionId,
        baseRevisionId: props.currentRevisionId,
        reason: `r${props.revisionNo} 판으로 되돌리기`
      });
      window.location.assign(props.routePath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '되돌리기에 실패했습니다.');
      setWorking(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={() => void revert()} disabled={working} className="chip chip-muted inline-flex items-center gap-1.5 disabled:opacity-50">
        {working ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        되돌리기
      </button>
      {error ? <span role="alert" className="max-w-48 text-xs text-red-200">{error}</span> : null}
    </span>
  );
}
