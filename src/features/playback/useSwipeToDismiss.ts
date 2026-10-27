import { useCallback, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { shouldDismiss, swipePhase, type SwipePhase } from './swipe';

interface Options {
  onDismiss: () => void;
  /** A horizontal drag began: the owner can pause anything that would expire under the finger. */
  onStart?: () => void;
  /** The drag ended without dismissing. */
  onCancel?: () => void;
}

interface Gesture { id: number; x: number; y: number; phase: SwipePhase; width: number; type: string }

/**
 * Swipe-to-dismiss for one element, from pointer events (touch, pen and mouse alike). It is an ADDITIONAL way to dismiss: the
 * dismiss button and the Escape key stay, so nothing depends on the gesture. A tap or click is untouched (the pointer is captured
 * only once the movement is clearly a horizontal drag, so buttons inside keep working); a vertical movement is left to the page
 * (pair it with `touch-action: pan-y`); a drag that is released early springs back. The click that follows a drag is swallowed.
 */
export function useSwipeToDismiss({ onDismiss, onStart, onCancel }: Options) {
  const gesture = useRef<Gesture | null>(null);
  const swallowClick = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);

  const end = useCallback(() => { gesture.current = null; setDragging(false); }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swallowClick.current = false;
    setSettling(false);
    gesture.current = { id: e.pointerId ?? 0, x: e.clientX, y: e.clientY, phase: 'idle', width: e.currentTarget.getBoundingClientRect().width, type: e.pointerType };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || (e.pointerId ?? 0) !== g.id) return;
    const dx = e.clientX - g.x; const dy = e.clientY - g.y;
    if (g.phase === 'ignored') return;
    const phase = g.phase === 'dragging' ? 'dragging' : swipePhase(dx, dy);
    if (phase === 'idle') return;
    if (phase === 'ignored') { g.phase = 'ignored'; return; }
    if (g.phase !== 'dragging') {
      g.phase = 'dragging';
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* the gesture still works through the events that arrive */ }
      swallowClick.current = true;
      setDragging(true);
      onStart?.();
    }
    setOffset(dx);
  }, [onStart]);

  const finish = useCallback((e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || (e.pointerId ?? 0) !== g.id) return;
    const wasDragging = g.phase === 'dragging';
    const dx = e.clientX - g.x; const dy = e.clientY - g.y;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    end();
    if (wasDragging) {
      // The click that ends a drag must not press a button under the finger.
      setTimeout(() => { swallowClick.current = false; }, 0);
      if (!cancelled && shouldDismiss(dx, dy, g.width)) { setOffset(0); onDismiss(); return; }
      setSettling(true);
      setOffset(0);
      onCancel?.();
    }
  }, [end, onDismiss, onCancel]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => finish(e, false), [finish]);
  const onPointerCancel = useCallback((e: ReactPointerEvent<HTMLElement>) => finish(e, true), [finish]);
  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (swallowClick.current) { e.preventDefault(); e.stopPropagation(); swallowClick.current = false; }
  }, []);

  const style: CSSProperties | undefined = offset === 0 && !dragging ? undefined : { transform: `translateX(${offset}px)`, opacity: Math.max(0.4, 1 - Math.abs(offset) / 400) };
  return { handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture }, style, dragging, settling };
}
