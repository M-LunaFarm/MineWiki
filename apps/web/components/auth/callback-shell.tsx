import type { ReactNode } from 'react';
import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';
import { AuthShellLayout } from './auth-shell-layout';

interface CallbackShellProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly status: 'pending' | 'success' | 'warning' | 'error';
  readonly children: ReactNode;
  readonly aside?: ReactNode;
}

interface CallbackCardProps {
  readonly status: CallbackShellProps['status'];
  readonly progressWidth: string;
  readonly children: ReactNode;
  readonly footerLabel: string;
}

interface CallbackCheckRowProps {
  readonly label: string;
  readonly value?: string;
  readonly complete: boolean;
  readonly pending?: boolean;
  readonly pendingIcon?: ReactNode;
}

const statusStyles = {
  pending: {
    dot: 'bg-blue-300',
    text: 'text-blue-200',
    progress: 'bg-blue-300',
  },
  success: {
    dot: 'bg-[#35e5b7]',
    text: 'text-[#35e5b7]',
    progress: 'bg-[#35e5b7]',
  },
  warning: {
    dot: 'bg-amber-300',
    text: 'text-amber-200',
    progress: 'bg-amber-300',
  },
  error: {
    dot: 'bg-rose-400',
    text: 'text-rose-300',
    progress: 'bg-rose-400',
  },
} as const;

export function CallbackShell({
  eyebrow,
  title,
  subtitle,
  status,
  children,
  aside,
}: CallbackShellProps) {
  const tone = statusStyles[status];

  return (
    <AuthShellLayout title={title} description={subtitle}>
      <div className={`mb-4 inline-flex items-center gap-2 text-xs font-semibold ${tone.text}`}>
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
        {eyebrow}
      </div>
      <aside className="grid grid-cols-3 gap-2">
        {aside ?? (
          <>
            <CallbackSideStat label="연결" value="암호화" />
            <CallbackSideStat label="처리" value="자동" />
            <CallbackSideStat label="보호" value="동일 출처" />
          </>
        )}
      </aside>
      <div className="mt-4">{children}</div>
    </AuthShellLayout>
  );
}

export function CallbackCard({ status, progressWidth, children, footerLabel }: CallbackCardProps) {
  const tone = statusStyles[status];

  return (
    <div className="dark-fixed-surface overflow-hidden rounded-xl border border-white/10 bg-[#0d1416]">
      <div className="h-1 w-full bg-white/[0.06]">
        <div className={`h-full animate-pulse ${tone.progress}`} style={{ width: progressWidth }} />
      </div>
      <div className="p-5 sm:p-7">{children}</div>
      <div className="flex flex-col gap-2 border-t border-white/10 bg-black/15 px-5 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-[#35e5b7]" />
          안전한 연결
        </span>
        <span>{footerLabel}</span>
      </div>
    </div>
  );
}

export function CallbackCheckRow({
  label,
  value,
  complete,
  pending,
  pendingIcon,
}: CallbackCheckRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/15 px-3 py-2.5 text-xs">
      <span className="min-w-0 text-slate-400">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-right font-medium text-slate-200">
        {value ? <span className="truncate">{value}</span> : null}
        {complete ? (
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[#35e5b7]" />
        ) : pending && pendingIcon ? (
          pendingIcon
        ) : (
          <XCircle className="h-4 w-4 flex-shrink-0 text-[#6b7280]" />
        )}
      </span>
    </div>
  );
}

export function CallbackSideStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.04] p-3">
      <p className="truncate text-[10px] font-semibold text-slate-500">{label}</p>
      <p className="mt-1 truncate text-xs font-bold text-white sm:text-sm">{value}</p>
    </div>
  );
}
