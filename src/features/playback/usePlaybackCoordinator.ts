import { useEffect, useRef } from 'react';
import type { PlaybackAction } from '@/domain/playback/actions';
import { PlaybackCoordinator, type CoordinatorEvent, type PlaybackSignal } from '@/domain/playback/coordinator';
import { VideoSurface } from './videoSurface';

/** The boundary timer fires this long BEFORE the boundary (covers timer jitter), never more often than every MIN_WAIT_MS, never later than MAX_WAIT_MS. */
const LEAD_MS = 40;
const MIN_WAIT_MS = 20;
const MAX_WAIT_MS = 500;

const SIGNALS: Array<[string, PlaybackSignal]> = [
  ['timeupdate', 'timeupdate'], ['play', 'play'], ['playing', 'play'], ['pause', 'pause'], ['seeked', 'seeked'], ['ended', 'ended'], ['volumechange', 'volumechange'],
];

interface Options {
  /** The element, or null before it exists. */
  video: HTMLVideoElement | null;
  /** Changes when the source changes: the coordinator (and everything it applied) is rebuilt. */
  sourceKey: string;
  actions: readonly PlaybackAction[];
  autoEnabled: boolean;
  onEvent: (e: CoordinatorEvent) => void;
  /** Called once if the action subsystem failed. Audio has already been restored and automatic actions are stopped. */
  onFailure: () => void;
}

/**
 * Binds a coordinator to a video element. Player events and (while playing) every animation frame are fed to it; the frame
 * loop gives much finer boundaries than the roughly four `timeupdate` events per second. Nothing expensive happens per
 * event: no classification, no I/O, no sorting (spans are built when actions change).
 *
 * Failure isolation: any exception in the coordinator disposes it (restoring the user's audio), stops automatic actions
 * and reports once. Ordinary playback and the player's own controls are never affected.
 */
export function usePlaybackCoordinator({ video, sourceKey, actions, autoEnabled, onEvent, onFailure }: Options): void {
  const coordinator = useRef<PlaybackCoordinator | null>(null);
  const latest = useRef({ actions, autoEnabled, onEvent, onFailure });
  const scheduler = useRef<(() => void) | null>(null);
  useEffect(() => { latest.current = { actions, autoEnabled, onEvent, onFailure }; });

  useEffect(() => {
    if (!video) return;
    let failed = false;
    const surface = new VideoSurface(video);
    const c = new PlaybackCoordinator(surface, (e) => latest.current.onEvent(e));
    coordinator.current = c;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const guard = (fn: () => void) => {
      if (failed) return;
      try { fn(); } catch {
        failed = true;
        stopLoop();
        try { c.dispose(); } catch { /* nothing more to do */ }
        latest.current.onFailure();
      }
    };
    // Wake up shortly before the next boundary (a span starting or ending). Animation frames are throttled in background or
    // occluded tabs (this was measured at about 2 per second in the embedded browser), timers are not. Never faster than every MIN_WAIT_MS.
    const schedule = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (failed) return;
      const until = c.msUntilNextBoundary();
      if (until === null) return;
      timer = setTimeout(() => { timer = null; guard(() => c.handle('frame')); schedule(); }, Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, until - LEAD_MS)));
    };
    const loop = () => { guard(() => c.handle('frame')); if (!failed && !video.paused) raf = requestAnimationFrame(loop); };
    const startLoop = () => { if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(loop); };
    function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (timer) { clearTimeout(timer); timer = null; } }

    const listeners = SIGNALS.map(([name, signal]): [string, () => void] => [name, () => {
      guard(() => c.handle(signal));
      schedule();
      if (name === 'play' || name === 'playing') startLoop();
      if (name === 'pause' || name === 'ended') stopLoop();
    }]);
    scheduler.current = schedule;
    for (const [name, fn] of listeners) video.addEventListener(name, fn);
    guard(() => c.setActions(latest.current.actions, latest.current.autoEnabled));
    if (!video.paused) { startLoop(); schedule(); }

    return () => {
      for (const [name, fn] of listeners) video.removeEventListener(name, fn);
      stopLoop();
      try { c.dispose(); } catch { /* the element may already be gone */ }
      if (coordinator.current === c) coordinator.current = null;
      scheduler.current = null;
    };
  }, [video, sourceKey]);

  useEffect(() => {
    try { coordinator.current?.setActions(actions, autoEnabled); scheduler.current?.(); } catch { latest.current.onFailure(); }
  }, [actions, autoEnabled]);
}
