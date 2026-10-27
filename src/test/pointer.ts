import { fireEvent } from '@testing-library/react';

/**
 * Pointer events for jsdom, which may lack PointerEvent: a MouseEvent of the pointer type carrying the fields the app reads
 * (position, id, kind, button). React listens by event name, so this reaches the same handlers a real finger or mouse does.
 */
export function pointer(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y = 0, opts: { id?: number; kind?: 'touch' | 'mouse' | 'pen'; button?: number } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: opts.button ?? 0 });
  Object.defineProperties(e, { pointerId: { value: opts.id ?? 1 }, pointerType: { value: opts.kind ?? 'touch' } });
  fireEvent(el, e);
  return e;
}

/** A whole drag from (x0, y0) to (x1, y1) in a few moves, ending with a release (or a cancel). */
export function drag(el: Element, from: [number, number], to: [number, number], opts: { kind?: 'touch' | 'mouse' | 'pen'; id?: number; end?: 'up' | 'cancel'; steps?: number } = {}) {
  const steps = opts.steps ?? 4;
  pointer(el, 'pointerdown', from[0], from[1], opts);
  for (let i = 1; i <= steps; i++) pointer(el, 'pointermove', from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, opts);
  pointer(el, opts.end === 'cancel' ? 'pointercancel' : 'pointerup', to[0], to[1], opts);
}
