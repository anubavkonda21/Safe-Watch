import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { grp } from '@/test/warnings';
import { drag, pointer } from '@/test/pointer';
import { UpcomingWarning } from './UpcomingWarning';
import type { ActiveWarning } from '@/domain/warnings/scheduler';

const warning: ActiveWarning = { id: 'w1', group: grp('g', 30_000, 32_000), shownAtMs: 10_000, startsInMs: 20_000, late: false };

function setup() {
  const fns = { onSkip: vi.fn(), onIgnore: vi.fn(), onDismiss: vi.fn(), onHold: vi.fn(), onRelease: vi.fn() };
  render(<UpcomingWarning warning={warning} durationMs={3000} {...fns} />);
  const card = screen.getByRole('group', { name: 'Upcoming flagged phrase' });
  card.getBoundingClientRect = () => ({ width: 288, height: 120, top: 0, left: 0, right: 288, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
  return { card, ...fns };
}

describe('swipe to dismiss', () => {
  it.each([['left', [200, 50], [60, 52]], ['right', [40, 50], [200, 48]]] as const)('a long horizontal swipe %s dismisses, exactly like the X button', (_n, from, to) => {
    const { card, onDismiss, onSkip, onIgnore } = setup();
    drag(card, [...from], [...to]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled(); expect(onIgnore).not.toHaveBeenCalled(); // dismissing never chooses an action
  });

  it('works with touch, pen and mouse', () => {
    for (const kind of ['touch', 'pen', 'mouse'] as const) {
      const { card, onDismiss } = setup();
      drag(card, [200, 50], [60, 50], { kind });
      expect(onDismiss, kind).toHaveBeenCalledTimes(1);
      document.body.innerHTML = '';
    }
  });

  it('a short swipe springs back and does not dismiss; the countdown is held while dragging and resumed after', () => {
    const { card, onDismiss, onHold, onRelease } = setup();
    drag(card, [200, 50], [160, 50]);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(card.className).toContain('is-settling');
    expect(card.style.transform).toBe(''); // back in place
  });

  it('the card follows the finger while dragging and fades a little', () => {
    const { card } = setup();
    pointer(card, 'pointerdown', 200, 50);
    pointer(card, 'pointermove', 170, 50);
    pointer(card, 'pointermove', 140, 52);
    expect(card.className).toContain('is-dragging');
    expect(card.style.transform).toBe('translateX(-60px)');
    expect(Number(card.style.opacity)).toBeLessThan(1);
    pointer(card, 'pointerup', 140, 52);
  });

  it('a mostly vertical movement is a page scroll, never a swipe', () => {
    const { card, onDismiss, onHold } = setup();
    drag(card, [150, 20], [210, 160]);
    drag(card, [150, 20], [150, 200]);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
    expect(card.style.transform).toBe('');
  });

  it('a tap or click without movement does nothing, and buttons inside keep working', () => {
    const { card, onDismiss, onSkip, onIgnore } = setup();
    const skip = screen.getByRole('button', { name: 'Skip' });
    pointer(skip, 'pointerdown', 100, 100); pointer(skip, 'pointerup', 100, 100);
    fireEvent.click(skip);
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onIgnore).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(card.className).not.toContain('is-dragging');
  });

  it('a swipe that starts ON a button dismisses, and the click that ends it does not press the button', () => {
    const { onDismiss, onSkip } = setup();
    const skip = screen.getByRole('button', { name: 'Skip' });
    pointer(skip, 'pointerdown', 200, 80);
    for (const x of [180, 150, 120, 90]) pointer(skip, 'pointermove', x, 82);
    pointer(skip, 'pointerup', 90, 82);
    fireEvent.click(skip); // the click a browser would send after the pointer is released
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('a cancelled gesture (the system took the touch) never dismisses', () => {
    const { card, onDismiss, onRelease } = setup();
    drag(card, [200, 50], [60, 50], { end: 'cancel' });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalled();
  });

  it('a second finger or a different pointer is ignored while one gesture is under way', () => {
    const { card, onDismiss } = setup();
    pointer(card, 'pointerdown', 200, 50, { id: 1 });
    pointer(card, 'pointermove', 150, 50, { id: 1 });
    pointer(card, 'pointermove', 20, 50, { id: 2 });
    pointer(card, 'pointerup', 20, 50, { id: 2 });
    expect(onDismiss).not.toHaveBeenCalled();
    pointer(card, 'pointerup', 90, 50, { id: 1 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('the right mouse button never starts a gesture', () => {
    const { card, onDismiss } = setup();
    pointer(card, 'pointerdown', 200, 50, { kind: 'mouse', button: 2 });
    pointer(card, 'pointermove', 100, 50, { kind: 'mouse', button: 2 });
    pointer(card, 'pointerup', 60, 50, { kind: 'mouse', button: 2 });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('the other ways to dismiss are untouched: the X button and Escape', () => {
    const { onDismiss } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss warning' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Skip' }), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('the stylesheet lets the page scroll vertically and does not animate for people who asked for reduced motion', () => {
    const css = readFileSync(join(process.cwd(), 'src/features/upload/upload.css'), 'utf8');
    expect(css).toMatch(/\.sw-warn \{[^}]*touch-action: pan-y/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.sw-warn\.is-settling \{ transition: none; \}/);
    expect(css).toMatch(/\.sw-warn\.is-dragging \{ transition: none; user-select: none/);
  });
});
