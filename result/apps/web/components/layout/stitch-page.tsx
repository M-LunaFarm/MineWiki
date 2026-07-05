import Link from 'next/link';
import type { ReactNode } from 'react';

export interface StitchAction {
  readonly href: string;
  readonly label: string;
  readonly tone?: 'primary' | 'secondary';
}

export interface StitchStat {
  readonly label: string;
  readonly value: string;
}

interface StitchPageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly actions?: readonly StitchAction[];
  readonly stats?: readonly StitchStat[];
}

export function StitchPageHeader({
  eyebrow,
  title,
  description,
  actions = [],
  stats = [],
}: StitchPageHeaderProps) {
  return (
    <header className="stitch-hero">
      <p className="stitch-eyebrow">{eyebrow}</p>
      <h1 className="stitch-title">{title}</h1>
      <p className="stitch-description">{description}</p>
      {actions.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {actions.map((action) => (
            <Link
              key={`${action.href}-${action.label}`}
              href={action.href}
              className={
                action.tone === 'secondary'
                  ? 'stitch-action stitch-action-secondary'
                  : 'stitch-action stitch-action-primary'
              }
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
      {stats.length > 0 ? (
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="stitch-stat">
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </header>
  );
}

interface StitchSectionProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}

export function StitchSectionHeader({ title, description, actions }: StitchSectionProps) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h2 className="stitch-section-title">{title}</h2>
        {description ? <p className="stitch-section-description">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
