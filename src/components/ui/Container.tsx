import type { ElementType, HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface ContainerProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
}

export function Container({ as: Tag = 'div', className, ...rest }: ContainerProps) {
  return <Tag className={cn('sw-container', className)} {...rest} />;
}
