'use client';

import { useEffect } from 'react';
import { formatWikiDynamicTime } from '../../lib/wiki-dynamic-time.mjs';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

interface WikiDynamicTimeHydratorProps {
  readonly targetId: string;
  readonly revisionId: string;
}

export function WikiDynamicTimeHydrator({ targetId, revisionId }: WikiDynamicTimeHydratorProps) {
  useEffect(() => {
    const root = document.getElementById(targetId);
    if (!root) return;
    const timeNodes = Array.from(root.querySelectorAll<HTMLTimeElement>('time[data-wiki-time]'));
    const statNodes = Array.from(root.querySelectorAll<HTMLOutputElement>('output[data-wiki-stat="pagecount"]'));
    if (timeNodes.length === 0 && statNodes.length === 0) return;
    const abortController = new AbortController();

    const update = () => {
      const now = new Date();
      for (const node of timeNodes) {
        const result = formatWikiDynamicTime(node.dataset.wikiTime, node.dataset.wikiDate, now);
        if (!result) continue;
        node.textContent = result.text;
        node.dateTime = result.dateTime;
      }
    };

    let interval: number | null = null;
    if (timeNodes.length > 0) {
      update();
      const refreshEvery = timeNodes.some((node) => node.dataset.wikiTime === 'datetime') ? 1_000 : 60_000;
      interval = window.setInterval(update, refreshEvery);
    }

    const nodesByNamespace = new Map<string, HTMLOutputElement[]>();
    for (const node of statNodes) {
      const namespace = node.dataset.wikiNamespace?.trim() ?? '';
      nodesByNamespace.set(namespace, [...(nodesByNamespace.get(namespace) ?? []), node]);
    }
    for (const [namespace, nodes] of nodesByNamespace) {
      const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
      void fetch(`${normalizeApiBaseUrl()}/v1/wiki/stats${query}`, {
        signal: abortController.signal,
        headers: { Accept: 'application/json' }
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Wiki stats request failed (${response.status})`);
          return response.json() as Promise<{ readonly pageCount?: unknown }>;
        })
        .then((payload) => {
          if (!Number.isSafeInteger(payload.pageCount) || Number(payload.pageCount) < 0) throw new Error('Invalid wiki stats response');
          const text = Number(payload.pageCount).toLocaleString('ko-KR');
          for (const node of nodes) node.textContent = text;
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          for (const node of nodes) node.textContent = '—';
        });
    }

    return () => {
      abortController.abort();
      if (interval !== null) window.clearInterval(interval);
    };
  }, [revisionId, targetId]);

  return null;
}
