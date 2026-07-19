'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'minewiki:server-wiki:wide-reading';

export function ServerWikiReadingModeToggle() {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    let saved = false;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      // Reading mode remains usable when storage is unavailable.
    }
    setWide(saved);
    applyWideMode(saved);
    return () => {
      delete document.documentElement.dataset.serverWikiWide;
    };
  }, []);

  function toggle() {
    const next = !wide;
    setWide(next);
    applyWideMode(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // The current-page mode still applies without persistence.
    }
  }

  return <button
    type="button"
    onClick={toggle}
    aria-pressed={wide}
    className="hidden h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium text-[#666] transition hover:bg-[#f5f5f5] hover:text-[#202020] xl:inline-flex"
    title={wide ? '문서 탐색 패널 다시 표시' : '탐색 패널을 접고 본문 넓게 읽기'}
  >
    {wide ? <PanelLeftOpen className="size-3.5" aria-hidden="true" /> : <PanelLeftClose className="size-3.5" aria-hidden="true" />}
    {wide ? '패널 표시' : '넓게 읽기'}
  </button>;
}

function applyWideMode(wide: boolean) {
  document.documentElement.dataset.serverWikiWide = wide ? 'true' : 'false';
}
