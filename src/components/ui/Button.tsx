import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'lg';

interface BaseProps {
  variant?: Variant;
  size?: Size;
}

function classes(variant: Variant, size: Size, extra?: string, loading?: boolean) {
  return cn('sw-btn', `sw-btn--${variant}`, `sw-btn--${size}`, loading && 'is-loading', extra);
}

export interface ButtonProps extends BaseProps, ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={classes(variant, size, className, loading)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="sw-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends BaseProps, AnchorHTMLAttributes<HTMLAnchorElement> {}

export function ButtonLink({ variant = 'primary', size = 'md', className, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={classes(variant, size, className)} {...rest}>
      {children}
    </a>
  );
}
