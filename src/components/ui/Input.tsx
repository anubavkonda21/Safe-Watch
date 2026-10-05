import { useId, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...rest }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const describedBy = [hint && `${inputId}-hint`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('sw-field', className)}>
      <label htmlFor={inputId} className="sw-field__label">{label}</label>
      <input
        id={inputId}
        className="sw-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && !error && <p id={`${inputId}-hint`} className="sw-field__hint">{hint}</p>}
      {error && <p id={`${inputId}-error`} className="sw-field__error">{error}</p>}
    </div>
  );
}
