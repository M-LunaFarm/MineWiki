import type { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
};

const baseClass =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-60';

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600',
  secondary: 'border border-slate-700 text-slate-100 hover:bg-slate-800'
};

export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  return <button className={clsx(baseClass, variantClasses[variant], className)} {...props} />;
}
