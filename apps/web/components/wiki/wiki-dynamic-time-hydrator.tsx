'use client';

import { useEffect } from 'react';
import { formatWikiDynamicTime } from '../../lib/wiki-dynamic-time.mjs';

interface WikiDynamicTimeHydratorProps {
  readonly targetId: string;
  readonly revisionId: string;
}

export function WikiDynamicTimeHydrator({ targetId, revisionId }: WikiDynamicTimeHydratorProps) {
  useEffect(() => {
    const root = document.getElementById(targetId);
    if (!root) return;
    const timeNodes = Array.from(root.querySelectorAll<HTMLTimeElement>('time[data-wiki-time]'));
    if (timeNodes.length === 0) return;

    const update = () => {
      const now = new Date();
      for (const node of timeNodes) {
        const result = formatWikiDynamicTime(node.dataset.wikiTime, node.dataset.wikiDate, now);
        if (!result) continue;
        node.textContent = result.text;
        node.dateTime = result.dateTime;
      }
    };

    update();
    const refreshEvery = timeNodes.some((node) => node.dataset.wikiTime === 'datetime') ? 1_000 : 60_000;
    const interval = window.setInterval(update, refreshEvery);
    return () => window.clearInterval(interval);
  }, [revisionId, targetId]);

  return null;
}
