import Link from 'next/link';
import type { ReactNode } from 'react';
import { CheckCircle2, Home, ShieldCheck, XCircle } from 'lucide-react';

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
    dot: 'bg-[#13ec80]',
    text: 'text-[#13ec80]',
    progress: 'bg-[#13ec80]',
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
    <div className="min-h-screen bg-[#0b0d10] text-white">
      <nav className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
        <Link className="group flex items-center gap-2" href="/">
          <CallbackBrandMark />
          <span className="text-xl font-bold tracking-tight text-white">
            MineWiki<span className="text-[#13ec80]">.kr</span>
          </span>
        </Link>
        <Link
          href="/"
          className="inline-flex h-10 items-center gap-2 rounded-md border border-[#30363d] bg-[#15191f] px-3 text-sm font-medium text-[#d1d5db] transition hover:border-[#13ec80]/50 hover:text-white"
        >
          <Home className="h-4 w-4" />홈
        </Link>
      </nav>

      <main className="border-y border-[#272c33] bg-[#101419]">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-8 lg:py-14">
          <section className="min-w-0">
            <p className={`inline-flex items-center gap-2 text-sm font-medium ${tone.text}`}>
              <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
              {eyebrow}
            </p>
            <h1 className="mt-3 max-w-3xl text-3xl font-bold leading-tight text-white sm:text-5xl">
              {title}
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[#a9b0ba] sm:text-base">
              {subtitle}
            </p>
          </section>

          <aside className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {aside ?? (
              <>
                <CallbackSideStat label="연결" value="암호화" />
                <CallbackSideStat label="처리" value="자동" />
                <CallbackSideStat label="보호" value="동일 출처" />
              </>
            )}
          </aside>
        </div>
      </main>

      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">{children}</section>
    </div>
  );
}

export function CallbackCard({ status, progressWidth, children, footerLabel }: CallbackCardProps) {
  const tone = statusStyles[status];

  return (
    <div className="overflow-hidden rounded-lg border border-[#30363d] bg-[#101419] shadow-xl shadow-black/20">
      <div className="h-1 w-full bg-[#1f252d]">
        <div className={`h-full animate-pulse ${tone.progress}`} style={{ width: progressWidth }} />
      </div>
      <div className="p-5 sm:p-7">{children}</div>
      <div className="flex flex-col gap-2 border-t border-[#30363d] bg-[#0b0d10] px-5 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[#6b7280] sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-[#13ec80]" />
          Secure Connection
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
    <div className="flex items-center justify-between gap-3 rounded-md border border-[#30363d] bg-[#0b0d10] px-3 py-2.5 text-xs">
      <span className="min-w-0 text-[#a9b0ba]">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-right font-medium text-[#d1d5db]">
        {value ? <span className="truncate">{value}</span> : null}
        {complete ? (
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-[#13ec80]" />
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
    <div className="rounded-lg border border-[#30363d] bg-[#0b0d10] p-4">
      <p className="text-sm text-[#a9b0ba]">{label}</p>
      <p className="mt-3 text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

export function CallbackBrandMark() {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-8 w-8 items-center justify-center rounded-full border border-[#30363d] bg-[#11151a]"
    >
      <span className="absolute h-[18px] w-[18px] rounded-full bg-[#13ec80]" />
      <span className="absolute left-[13px] top-[6px] h-[18px] w-[18px] rounded-full bg-[#11151a]" />
    </span>
  );
}
