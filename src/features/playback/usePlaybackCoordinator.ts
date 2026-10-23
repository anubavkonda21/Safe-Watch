import { useEffect, useMemo, useRef } from 'react';
import type { PlaybackAction } from '@/domain/playback/actions';
import { PlaybackCoordinator, type CoordinatorEvent, type PlaybackSignal } from '@/domain/playback/coordinator';
import type { WarningGroup } from '@/domain/warnings/groups';
import { WarningScheduler, type WarningEvent, type WarningSettings } from '@/domain/warnings/scheduler';
import { VideoSurface } from './videoSurface';

const SIGNALS: Array<[string, PlaybackSignal]> = [
  ['timeupdate', 'timeupdate'], ['play', 'play'], ['playing', 'play'], ['pause', 'pause'], ['seeked', 'seeked'], ['ended', 'ended'], ['volumechange', 'volumechange'],
];

/** The boundary timer fires this long BEFORE the boundary (covers timer jitter), never more often than every MIN_WAIT_MS, never later than MAX_WAIT_MS. */
const LEAD_MS = 40;
const MIN_WAIT_MS = 20;
const MAX_WAIT_MS = 500;

export interface WarningInputs {
  groups: readonly WarningGroup[];
  settings: WarningSettings;
  onEvent: (e: WarningEvent) => void;
}

/** What the interface can do to the warning that is showing. None of it plays, mutes or skips: choices go through the CP8 settings. */
export interface WarningControls {
  /** Skip or Ignore was pressed (already applied through the CP8 settings): remove the warning. */
  resolve(): void;
  dismiss(): void;
  /** Pointer or focus is on the warning: keep it visible. */
  hold(): void;
  release(): void;
}

interface Options {
  /** The element, or null before it exists. */
  video: HTMLVideoElement | null;
  /** Changes when the source changes: the coordinator, the warning scheduler (and everything they applied) are rebuilt. */
  sourceKey: string;
  actions: readonly PlaybackAction[];
  autoEnabled: boolean;
  onEvent: (e: CoordinatorEvent) => void;
  /** Called once if the action subsystem failed. Audio has already been restored and automatic actions are stopped. */
  onFailure: () => void;
  warning?: WarningInputs;
}

/**
 * Binds the CP8 coordinator and the heads-up scheduler to ONE video element, with one set of listeners and one timer: the same
 * player events and (while playing) every animation frame feed both, and the timer wakes at whichever boundary comes first
 * (a mute or skip boundary, a warning window opening, a warning expiring). Nothing expensive happens per event.
 *
 * Failure isolation: any exception disposes both (restoring the user's audio and removing any warning), stops automatic actions
 * and reports once. Ordinary playback and the player's own controls are never affected.
 */
export function usePlaybackCoordinator({ video, sourceKey, actions, autoEnabled, onEvent, onFailure, warning }: Options): WarningControls {
  const coordinator = useRef<PlaybackCoordinator | null>(null);
  const warner = useRef<WarningScheduler | null>(null);
  const latest = useRef({ actions, autoEnabled, onEvent, onFailure, warning });
  const scheduler = useRef<(() => void) | null>(null);
  useEffect(() => { latest.current = { actions, autoEnabled, onEvent, onFailure, warning }; });

  useEffect(() => {
    if (!video) return;
    let failed = false;
    const surface = new VideoSurface(video);
    const c = new PlaybackCoordinator(surface, (e) => latest.current.onEvent(e));
    const w = new WarningScheduler(surface, () => performance.now(), (e) => latest.current.warning?.onEvent(e));
    coordinator.current = c;
    warner.current = w;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const guard = (fn: () => void) => {
      if (failed) return;
      try { fn(); } catch {
        failed = true;
        stopLoop();
        try { c.dispose(); } catch { /* nothing more to do */ }
        try { w.dispose(); } catch { /* nothing more to do */ }
        latest.current.onFailure();
      }
    };
    const signal = (s: PlaybackSignal) => guard(() => { c.handle(s); w.handle(s); });

    // Wake up shortly before the next boundary. Animation frames are throttled in background or occluded tabs (measured at about
    // 2 per second in the embedded browser), timers are not. The warning scheduler uses a monotonic clock, so a late wake-up only
    // delays the check: the next one sees the true time.
    const schedule = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (failed) return;
      const waits = [c.msUntilNextBoundary(), w.msUntilNext()].filter((x): x is number => x !== null);
      if (waits.length === 0) return;
      timer = setTimeout(() => { timer = null; signal('frame'); schedule(); }, Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, Math.min(...waits) - LEAD_MS)));
    };
    const loop = () => { signal('frame'); if (!failed && !video.paused) raf = requestAnimationFrame(loop); };
    const startLoop = () => { if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(loop); };
    function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } if (timer) { clearTimeout(timer); timer = null; } }

    const listeners = SIGNALS.map(([name, s]): [string, () => void] => [name, () => {
      signal(s);
      schedule();
      if (name === 'play' || name === 'playing') startLoop();
      if (name === 'ended') stopLoop();
      if (name === 'pause') { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
    }]);
    // A tab that was in the background wakes up with an outdated state: evaluate at once on return.
    const onVisible = () => { if (document.visibilityState === 'visible') { signal('frame'); schedule(); } };
    scheduler.current = schedule;
    for (const [name, fn] of listeners) video.addEventListener(name, fn);
    document.addEventListener('visibilitychange', onVisible);
    guard(() => {
      c.setActions(latest.current.actions, latest.current.autoEnabled);
      const inputs = latest.current.warning;
      if (inputs) w.setInputs(inputs.groups, inputs.settings, latest.current.autoEnabled);
    });
    if (!video.paused) { startLoop(); schedule(); }

    return () => {
      for (const [name, fn] of listeners) video.removeEventListener(name, fn);
      document.removeEventListener('visibilitychange', onVisible);
      stopLoop();
      try { c.dispose(); } catch { /* the element may already be gone */ }
      try { w.dispose(); } catch { /* the element may already be gone */ }
      if (coordinator.current === c) coordinator.current = null;
      if (warner.current === w) warner.current = null;
      scheduler.current = null;
    };
  }, [video, sourceKey]);

  useEffect(() => {
    try { coordinator.current?.setActions(actions, autoEnabled); scheduler.current?.(); } catch { latest.current.onFailure(); }
  }, [actions, autoEnabled]);

  const groups = warning?.groups;
  const settings = warning?.settings;
  useEffect(() => {
    try { if (groups && settings) warner.current?.setInputs(groups, settings, autoEnabled); scheduler.current?.(); } catch { latest.current.onFailure(); }
  }, [groups, settings, autoEnabled]);

  return useMemo<WarningControls>(() => ({
    resolve: () => { warner.current?.resolve(); scheduler.current?.(); },
    dismiss: () => { warner.current?.dismiss(); scheduler.current?.(); },
    hold: () => { warner.current?.hold(); },
    release: () => { warner.current?.release(); scheduler.current?.(); },
  }), []);
}
