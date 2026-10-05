import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { AlertIcon, CheckIcon, InfoIcon } from './icons';

type AlertTone = 'info' | 'success' | 'warning' | 'danger';

interface AlertProps {
  tone?: AlertTone;
  title: string;
  children?: ReactNode;
}

export function Alert({ tone = 'info', title, children }: AlertProps) {
  const Icon = tone === 'success' ? CheckIcon : tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div className={cn('sw-alert', `sw-alert--${tone}`)} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <Icon size={18} className="sw-alert__icon" />
      <div>
        <p className="sw-alert__title">{title}</p>
        {children && <p className="sw-alert__body">{children}</p>}
      </div>
    </div>
  );
}
