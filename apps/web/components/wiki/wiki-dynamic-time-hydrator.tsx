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
    const sortButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-wiki-sort-column]'));
    if (timeNodes.length === 0 && statNodes.length === 0 && sortButtons.length === 0) return;
    const abortController = new AbortController();
    const sortCleanups = sortButtons.map((button) => installWikiTableSorter(button));

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
      for (const cleanup of sortCleanups) cleanup();
    };
  }, [revisionId, targetId]);

  return null;
}

function installWikiTableSorter(button: HTMLButtonElement): () => void {
  const table = button.closest('table');
  const headerCell = button.closest('th');
  const body = table?.tBodies.item(0);
  const column = Number(button.dataset.wikiSortColumn);
  if (!table || !headerCell || !body || !Number.isSafeInteger(column) || column < 0) return () => undefined;
  const initialRows = Array.from(body.rows);
  const sortableCells = initialRows.map((row) => cellAtVisualColumn(row, column));
  if (initialRows.length < 2 || sortableCells.some((cell) => !cell)) {
    button.disabled = true;
    return () => undefined;
  }
  const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
  let direction: 'ascending' | 'descending' = 'ascending';
  const activate = () => {
    const rows = initialRows.map((row, index) => ({ row, index, value: sortableCells[index]!.textContent?.trim() ?? '' }));
    rows.sort((left, right) => {
      const compared = collator.compare(left.value, right.value);
      return (direction === 'ascending' ? compared : -compared) || left.index - right.index;
    });
    body.replaceChildren(...rows.map(({ row }) => row));
    for (const row of Array.from(table.tHead?.rows ?? [])) {
      for (const cell of Array.from(row.cells)) cell.removeAttribute('aria-sort');
    }
    headerCell.setAttribute('aria-sort', direction);
    const indicator = button.querySelector<HTMLElement>('.wiki-table-sort-indicator');
    if (indicator) indicator.textContent = direction === 'ascending' ? '↑' : '↓';
    direction = direction === 'ascending' ? 'descending' : 'ascending';
  };
  button.addEventListener('click', activate);
  return () => button.removeEventListener('click', activate);
}

function cellAtVisualColumn(row: HTMLTableRowElement, targetColumn: number): HTMLTableCellElement | null {
  let visualColumn = 0;
  for (const cell of Array.from(row.cells)) {
    if (visualColumn === targetColumn && cell.colSpan === 1) return cell;
    if (targetColumn < visualColumn + cell.colSpan) return null;
    visualColumn += cell.colSpan;
  }
  return null;
}
