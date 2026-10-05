import { useId, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export function Select({ label, hint, error, options, className, id, ...rest }: SelectProps) {
  const auto = useId();
  const selectId = id ?? auto;
  const describedBy = [hint && `${selectId}-hint`, error && `${selectId}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('sw-field', className)}>
      <label htmlFor={selectId} className="sw-field__label">{label}</label>
      <select
        id={selectId}
        className="sw-input sw-select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
      {hint && !error && <p id={`${selectId}-hint`} className="sw-field__hint">{hint}</p>}
      {error && <p id={`${selectId}-error`} className="sw-field__error">{error}</p>}
    </div>
  );
}
