import Link from 'next/link';

interface ReviewFiltersProps {
  readonly serverId: string;
  readonly serverPath?: string;
  readonly sortOptions: Array<{ value: 'wilson' | 'newest'; label: string }>;
  readonly ratingOptions: Array<{ value: string; label: string }>;
  readonly availableTags: string[];
  readonly currentSort: 'wilson' | 'newest';
  readonly currentRating?: number;
  readonly currentTag?: string;
}

export function ServerReviewFilters({
  serverId,
  serverPath,
  sortOptions,
  ratingOptions,
  availableTags,
  currentSort,
  currentRating,
  currentTag
}: ReviewFiltersProps) {
  const actionPath = serverPath ?? `/servers/${serverId}`;

  return (
    <form
      className="mt-6 grid gap-4 rounded-xl border border-[#30343b] bg-[#101216] p-4 md:grid-cols-4"
      action={actionPath}
      method="get"
    >
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-[#9ca3af]">
        정렬
        <select
          className="rounded-lg border border-[#30343b] bg-[#151922] px-3 py-2 text-sm text-white"
          name="sort"
          defaultValue={currentSort}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-[#9ca3af]">
        별점
        <select
          className="rounded-lg border border-[#30343b] bg-[#151922] px-3 py-2 text-sm text-white"
          name="rating"
          defaultValue={currentRating ? String(currentRating) : ''}
        >
          {ratingOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-[#9ca3af] md:col-span-2">
        태그
        <select
          className="rounded-lg border border-[#30343b] bg-[#151922] px-3 py-2 text-sm text-white"
          name="tag"
          defaultValue={currentTag ?? ''}
        >
          <option value="">전체</option>
          {availableTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end justify-end gap-2 md:col-span-4">
        <Link
          className="rounded-lg border border-[#30343b] px-4 py-2 text-sm font-semibold text-[#d1d5db] hover:bg-[#151922]"
          href={actionPath}
        >
          초기화
        </Link>
        <button
          type="submit"
          className="rounded-lg bg-[#f5f7fb] px-4 py-2 text-sm font-semibold text-[#111827] hover:bg-white"
        >
          적용
        </button>
      </div>
    </form>
  );
}
