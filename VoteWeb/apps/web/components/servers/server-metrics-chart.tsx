'use client';

interface MetricPoint {
  readonly label: string;
  readonly players: number;
  readonly latency: number;
  readonly online?: boolean;
}

interface ServerMetricsChartProps {
  readonly history: MetricPoint[];
}

export function ServerMetricsChart({ history }: ServerMetricsChartProps) {
  if (!history.length) {
    return null;
  }

  const playersMax = Math.max(...history.map((point) => Math.max(0, point.players)), 1);
  const latencyMax = Math.max(...history.map((point) => Math.max(0, point.latency)), 1);
  const hasLatencyData = history.some((point) => point.latency > 0);
  const offlineCount = history.filter((point) => point.online === false).length;

  return (
    <section className="rounded-xl border border-[#30343b] bg-[#151922] p-5 text-sm text-[#d1d5db] shadow-lg shadow-black/20 md:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9ca3af]">
            실시간 기록
          </p>
          <h3 className="mt-1 text-xl font-semibold text-white">접속자와 지연시간</h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md border border-[#30343b] bg-[#101216] px-2.5 py-1 text-[#9ca3af]">
            최근 {history.length.toLocaleString('ko-KR')}개 샘플
          </span>
          {offlineCount > 0 ? (
            <span className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1 text-rose-200">
              오프라인 {offlineCount.toLocaleString('ko-KR')}회 포함
            </span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MetricSection
          title="최근 접속자 추이"
          subTitle="최근 수집 샘플 기준"
          points={history}
          valueKey="players"
          maxValue={playersMax}
          tone="emerald"
          formatter={(value) => `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}명`}
        />
        {hasLatencyData ? (
          <MetricSection
            title="최근 지연시간 추이"
            subTitle="최근 수집 샘플 기준"
            points={history}
            valueKey="latency"
            maxValue={latencyMax}
            tone="sky"
            formatter={(value) =>
              `${value.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}ms`
            }
          />
        ) : null}
      </div>
    </section>
  );
}

interface MetricSectionProps {
  readonly title: string;
  readonly subTitle: string;
  readonly points: MetricPoint[];
  readonly valueKey: 'players' | 'latency';
  readonly maxValue: number;
  readonly tone: 'emerald' | 'sky';
  readonly formatter: (value: number) => string;
}

function MetricSection({
  title,
  subTitle,
  points,
  valueKey,
  maxValue,
  tone,
  formatter,
}: MetricSectionProps) {
  const latestPoint = points[points.length - 1] ?? null;
  const valuePoints =
    valueKey === 'latency'
      ? points.filter((point) => point.online !== false && point.latency > 0)
      : points;
  const firstValuePoint = valuePoints[0] ?? points[0];
  const latestValuePoint = valuePoints[valuePoints.length - 1] ?? latestPoint ?? points[0];
  const latest = latestValuePoint?.[valueKey] ?? 0;
  const first = firstValuePoint?.[valueKey] ?? 0;
  const delta = latest - first;
  const values = valuePoints.map((point) => Math.max(0, point[valueKey]));
  const minValue = values.length > 0 ? Math.min(...values) : 0;
  const peakValue = values.length > 0 ? Math.max(...values) : 0;
  const averageValue =
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const primarySummary =
    valueKey === 'latency'
      ? { label: '최저', value: minValue }
      : { label: '최대', value: peakValue };
  const secondarySummary =
    valueKey === 'latency'
      ? { label: '최고', value: peakValue }
      : { label: '최저', value: minValue };
  const firstLabel = points[0]?.label ?? '';
  const latestLabel = points[points.length - 1]?.label ?? '';
  const isLatestOffline = valueKey === 'latency' && latestPoint?.online === false;
  const latestDisplay = isLatestOffline ? '오프라인' : formatter(latest);
  const deltaLabel = isLatestOffline
    ? '최근 오프라인'
    : delta === 0
      ? '변화 없음'
      : `${delta > 0 ? '+' : ''}${delta.toLocaleString('ko-KR', {
          maximumFractionDigits: valueKey === 'players' ? 1 : 0,
        })}${valueKey === 'players' ? '명' : 'ms'}`;
  const deltaTone =
    isLatestOffline || delta === 0
      ? 'text-slate-400'
      : valueKey === 'latency'
        ? delta < 0
          ? 'text-emerald-300'
          : 'text-amber-200'
        : delta > 0
          ? 'text-emerald-300'
          : 'text-rose-300';
  const toneClasses =
    tone === 'emerald'
      ? {
          stroke: 'stroke-emerald-400',
          fill: 'fill-emerald-500/15',
          text: 'text-emerald-200',
          dot: 'fill-emerald-300',
        }
      : {
          stroke: 'stroke-sky-400',
          fill: 'fill-sky-500/15',
          text: 'text-sky-200',
          dot: 'fill-sky-300',
        };

  const path = buildPath(points, valueKey, maxValue);
  const area = buildArea(points, valueKey, maxValue);

  return (
    <div className="flex min-h-[320px] flex-col gap-4 rounded-xl border border-[#30343b] bg-[#101216] p-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#9ca3af]">
            {subTitle}
          </p>
          <h5 className="text-lg font-semibold text-white">{title}</h5>
        </div>
        <div className="text-right">
          <p className={`text-xl font-semibold ${toneClasses.text}`}>{latestDisplay}</p>
          <p className={`text-[11px] ${deltaTone}`}>{deltaLabel}</p>
        </div>
      </header>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <MetricSummary label="평균" value={formatter(averageValue)} />
        <MetricSummary label={primarySummary.label} value={formatter(primarySummary.value)} />
        <MetricSummary label={secondarySummary.label} value={formatter(secondarySummary.value)} />
      </dl>

      <svg
        viewBox="0 0 112 68"
        className="h-40 w-full md:h-44"
        role="img"
        aria-label={`${title} 차트. 첫 유효 샘플 ${formatter(first)}, 최근 유효 샘플 ${latestDisplay}.`}
      >
        {[8, 20, 32, 44, 56].map((gridY) => (
          <line
            key={`${title}-grid-${gridY}`}
            x1={8}
            y1={gridY}
            x2={106}
            y2={gridY}
            stroke="rgba(148,163,184,0.12)"
            strokeWidth={0.5}
          />
        ))}
        <text x="0" y="10" className="fill-slate-500 text-[5px] font-medium">
          {formatter(maxValue)}
        </text>
        <text x="0" y="58" className="fill-slate-500 text-[5px] font-medium">
          0
        </text>
        <path d={area} className={toneClasses.fill} style={{ pointerEvents: 'none' }} />
        <path
          d={path}
          className={`${toneClasses.stroke} fill-none stroke-2`}
          style={{ pointerEvents: 'none' }}
        />
        {points.map((point, index) => {
          const x = points.length > 1 ? 8 + (index / (points.length - 1)) * 98 : 57;
          const clampedY = getChartY(point[valueKey], maxValue);
          const isOffline = point.online === false;
          return (
            <g key={`${valueKey}-group-${index}`}>
              {isOffline ? (
                <line
                  x1={x}
                  y1={8}
                  x2={x}
                  y2={58}
                  stroke="rgba(251,113,133,0.22)"
                  strokeWidth={0.6}
                  strokeDasharray="1.5 1.5"
                />
              ) : null}
              <circle
                cx={x}
                cy={clampedY}
                r={index === points.length - 1 ? 2.4 : 1.6}
                className={isOffline ? 'fill-rose-300 stroke-rose-300' : toneClasses.dot}
              />
              <title>{`${point.label} • ${formatter(point[valueKey])}${
                isOffline ? ' • 오프라인 기록' : ''
              }`}</title>
            </g>
          );
        })}
        <text x="8" y="66" className="fill-slate-500 text-[5px] font-medium">
          {firstLabel}
        </text>
        <text x="106" y="66" textAnchor="end" className="fill-slate-500 text-[5px] font-medium">
          {latestLabel}
        </text>
      </svg>
    </div>
  );
}

function MetricSummary({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-[#30343b] bg-[#151922] px-3 py-2">
      <dt className="text-[11px] text-[#9ca3af]">{label}</dt>
      <dd className="mt-0.5 truncate font-semibold text-white">{value}</dd>
    </div>
  );
}

function buildPath(points: MetricPoint[], key: 'players' | 'latency', maxValue: number): string {
  if (points.length === 1) {
    const y = getChartY(points[0][key], maxValue);
    return `M8 ${y} L106 ${y}`;
  }
  return points
    .map((point, index) => {
      const x = 8 + (index / (points.length - 1)) * 98;
      return `${index === 0 ? 'M' : 'L'}${x} ${getChartY(point[key], maxValue)}`;
    })
    .join(' ');
}

function buildArea(points: MetricPoint[], key: 'players' | 'latency', maxValue: number): string {
  if (!points.length) {
    return '';
  }
  if (points.length === 1) {
    const y = getChartY(points[0][key], maxValue);
    return `M8 ${y} L106 ${y} L106 58 L8 58 Z`;
  }
  const topPath = points
    .map((point, index) => {
      const x = 8 + (index / (points.length - 1)) * 98;
      return `${index === 0 ? 'M' : 'L'}${x} ${getChartY(point[key], maxValue)}`;
    })
    .join(' ');
  return `${topPath} L106 58 L8 58 Z`;
}

function getChartY(value: number, maxValue: number): number {
  const safeMax = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 1;
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Math.max(8, Math.min(58, 58 - (safeValue / safeMax) * 50));
}
