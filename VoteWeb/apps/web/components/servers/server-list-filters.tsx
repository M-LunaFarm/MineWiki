import Link from 'next/link';

interface ServerListFiltersProps {
  readonly defaultEdition?: 'java' | 'bedrock';
  readonly defaultTag?: string;
  readonly defaultSearch?: string;
  readonly defaultSort: string;
  readonly sortOptions: ReadonlyArray<{ value: string; label: string }>;
  readonly availableTags: string[];
}

export function ServerListFilters({
  defaultEdition,
  defaultTag,
  defaultSearch,
  defaultSort,
  sortOptions,
  availableTags
}: ServerListFiltersProps) {
  return (
    <form
      className="grid gap-4 rounded-2xl border border-outline-soft bg-surface-200/80 p-4 md:grid-cols-4"
      action="/servers"
      method="get"
    >
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        에디션
        <select
          className="rounded-xl border border-outline-soft bg-surface-300/70 px-3 py-2 text-sm text-slate-100"
          name="edition"
          defaultValue={defaultEdition ?? ''}
        >
          <option value="">전체</option>
          <option value="java">Java</option>
          <option value="bedrock">Bedrock</option>
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        태그
        <select
          className="rounded-xl border border-outline-soft bg-surface-300/70 px-3 py-2 text-sm text-slate-100"
          name="tag"
          defaultValue={defaultTag ?? ''}
        >
          <option value="">전체</option>
          {availableTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        정렬
        <select
          className="rounded-xl border border-outline-soft bg-surface-300/70 px-3 py-2 text-sm text-slate-100"
          name="sort"
          defaultValue={defaultSort}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        검색
        <input
          className="rounded-xl border border-outline-soft bg-surface-300/70 px-3 py-2 text-sm text-slate-100"
          type="search"
          name="search"
          defaultValue={defaultSearch ?? ''}
          placeholder="서버 이름 또는 호스트"
        />
      </label>
      <div className="flex items-end justify-end gap-2 md:col-span-4">
        <Link
          className="rounded-xl border border-outline-soft px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-surface-300/60"
          href="/servers"
        >
          초기화
        </Link>
        <button
          type="submit"
          className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
        >
          적용
        </button>
      </div>
    </form>
  );
}
