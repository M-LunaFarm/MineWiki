import type { AccountExportSection } from './account-export-stream';

export const EXPORT_PAGE_SIZE = 200;
export type FilterReadablePageIds = (pageIds: readonly bigint[]) => Promise<ReadonlySet<bigint>>;
export type FilterReadableThreadIds = (threadIds: readonly bigint[]) => Promise<ReadonlySet<bigint>>;
export type CursorRow = { readonly id: string | bigint };

export function pagedSection<Row extends CursorRow>(
  name: string,
  load: (after: string | null) => Promise<readonly Row[]>,
): AccountExportSection {
  return { name, load, cursor: (row) => String((row as Row).id) };
}

export function staticSection<Row extends CursorRow>(
  name: string,
  loadRows: () => Promise<readonly Row[]>,
): AccountExportSection {
  return {
    name,
    load: (after) => after === null ? loadRows() : Promise.resolve([]),
    cursor: (row) => String((row as Row).id),
  };
}

const FILTER_CURSOR = Symbol('account-export-filter-cursor');
type FilteredCursorRow = CursorRow & { [FILTER_CURSOR]?: string };

export function filteredPagedSection<Row extends CursorRow>(
  name: string,
  loadRaw: (after: string | null) => Promise<readonly Row[]>,
  filter: (rows: readonly Row[]) => Promise<readonly Row[]>,
): AccountExportSection {
  return {
    name,
    async load(after) {
      let scanAfter = after;
      while (true) {
        const rows = await loadRaw(scanAfter);
        if (rows.length === 0) return [];
        const rawCursor = String(rows[rows.length - 1]!.id);
        const visible = [...await filter(rows)] as FilteredCursorRow[];
        if (visible.length > 0) {
          Object.defineProperty(visible[visible.length - 1]!, FILTER_CURSOR, {
            value: rawCursor,
            enumerable: false,
          });
          return visible;
        }
        if (!rawCursor || rawCursor === scanAfter) {
          throw new Error(`Account export section ${name} did not advance its scan cursor.`);
        }
        scanAfter = rawCursor;
      }
    },
    cursor: (row) => (row as FilteredCursorRow)[FILTER_CURSOR] ?? String((row as Row).id),
  };
}

export function afterBigInt(after: string | null): bigint | undefined {
  return after === null ? undefined : BigInt(after);
}

export async function filterByPageId<Row extends { readonly pageId: bigint }>(
  rows: readonly Row[],
  filterReadablePageIds?: FilterReadablePageIds,
): Promise<readonly Row[]> {
  if (!filterReadablePageIds || rows.length === 0) return rows;
  const readable = await filterReadablePageIds(rows.map((row) => row.pageId));
  return rows.filter((row) => readable.has(row.pageId));
}
