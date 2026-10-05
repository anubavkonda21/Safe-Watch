import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds hover feedback. Only use when the card is not itself a control. */
  hoverable?: boolean;
}

export function Card({ hoverable, className, ...rest }: CardProps) {
  return <div className={cn('sw-card', hoverable && 'sw-card--hoverable', className)} {...rest} />;
}
