import { cloneElement, useId, type ReactElement } from 'react';

interface TooltipProps {
  text: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

/** CSS-driven tooltip; shows on hover and keyboard focus of the wrapped control. */
export function Tooltip({ text, children }: TooltipProps) {
  const id = useId();
  return (
    <span className="sw-tooltip">
      {cloneElement(children, { 'aria-describedby': id })}
      <span role="tooltip" id={id} className="sw-tooltip__content">{text}</span>
    </span>
  );
}
