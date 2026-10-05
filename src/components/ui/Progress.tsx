interface ProgressProps {
  label: string;
  /** 0–100. Omit for an indeterminate bar. */
  value?: number;
}

export function Progress({ label, value }: ProgressProps) {
  const determinate = typeof value === 'number';
  return (
    <div
      className={determinate ? 'sw-progress' : 'sw-progress sw-progress--indeterminate'}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value) : undefined}
    >
      <div className="sw-progress__bar" style={determinate ? { width: `${Math.min(100, Math.max(0, value))}%` } : undefined} />
    </div>
  );
}
