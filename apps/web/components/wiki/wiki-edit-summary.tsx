export const HIDDEN_EDIT_SUMMARY_LABEL = '편집 요약이 숨겨졌습니다.';

export function WikiEditSummary({
  summary,
  hidden,
  emptyLabel = '요약 없음',
  className
}: {
  readonly summary: string | null;
  readonly hidden: boolean;
  readonly emptyLabel?: string;
  readonly className?: string;
}) {
  if (hidden) {
    return (
      <span className={className ? `${className} text-slate-500` : 'text-slate-500'}>
        {HIDDEN_EDIT_SUMMARY_LABEL}
      </span>
    );
  }
  return <span className={className}>{summary ?? emptyLabel}</span>;
}
