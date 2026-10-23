import type { FindingActionView } from '@/domain/playback/actions';
import type { ActionCandidate } from '@/domain/playback/planning';
import { WarningScheduler, type WarningEvent, type WarningSettings } from '@/domain/warnings/scheduler';
import type { WarningGroup } from '@/domain/warnings/groups';

export const SETTINGS: WarningSettings = { enabled: true, leadMs: 20_000, durationMs: 3_000 };

export const grp = (id: string, startMs: number, endMs = startMs + 1000, over: Partial<WarningGroup> = {}): WarningGroup => ({
  id, startMs, endMs, members: [{ findingId: `f-${id}`, overrideKey: id, term: `term ${id}`, uncertain: false, choice: 'none' }], ...over,
});

/** A scheduler on a fake player and a fake monotonic clock: no real time passes, so every outcome is deterministic. */
export class WarnHarness {
  timeMs = 0; paused = true; durationMs: number | null = 120_000; playbackRate = 1; now = 1_000_000;
  readonly events: WarningEvent[] = [];
  readonly scheduler: WarningScheduler;
  constructor(groups: WarningGroup[] = [], settings: WarningSettings = SETTINGS, auto = true) {
    const surface = {};
    Object.defineProperties(surface, {
      currentTimeMs: { get: () => this.timeMs }, durationMs: { get: () => this.durationMs }, paused: { get: () => this.paused }, playbackRate: { get: () => this.playbackRate },
    });
    this.scheduler = new WarningScheduler(surface as ConstructorParameters<typeof WarningScheduler>[0], () => this.now, (e) => this.events.push(e));
    this.scheduler.setInputs(groups, settings, auto);
  }
  play() { this.paused = false; this.scheduler.handle('play'); return this; }
  pause() { this.paused = true; this.scheduler.handle('pause'); return this; }
  at(ms: number) { this.timeMs = ms; return this; }
  /** Natural playback in steps; the fake clock advances by the same amount of real time. */
  playTo(ms: number, stepMs = 250) {
    if (this.paused) this.play();
    while (this.timeMs < ms) {
      const step = Math.min(stepMs, ms - this.timeMs);
      this.timeMs += step; this.now += step;
      this.scheduler.handle('timeupdate');
    }
    return this;
  }
  /** Time passes with no playback (paused) or with throttled timers: the clock moves, nothing is evaluated until `tick`. */
  wait(realMs: number) { this.now += realMs; return this; }
  tick() { this.scheduler.handle('frame'); return this; }
  seek(ms: number) { this.timeMs = ms; this.scheduler.handle('seeked'); return this; }
  end() { this.paused = true; this.scheduler.handle('ended'); return this; }
  shows() { return this.events.filter((e): e is Extract<WarningEvent, { type: 'show' }> => e.type === 'show'); }
  hides() { return this.events.filter((e): e is Extract<WarningEvent, { type: 'hide' }> => e.type === 'hide'); }
  reasons() { return this.hides().map((h) => h.reason); }
}

export const view = (over: Partial<ActionCandidate> = {}, choice: FindingActionView['choice'] = 'none', state: FindingActionView['state'] = 'none'): FindingActionView => ({
  candidate: {
    id: 'pa-f', mediaId: 'm', findingId: 'f', overrideKey: 'k', category: 'flagged-terms', findingStatus: 'detected', term: 'darn', findingStartMs: 30_000, findingEndMs: 31_000, startMs: 30_000, endMs: 31_000,
    timing: { quality: 'cue', startApproximate: false, endApproximate: false, marginBeforeMs: 0, marginAfterMs: 0, note: 'n' }, availability: 'available', unavailableReason: null, warnings: [], ...over,
  },
  choice, isDefault: true, state, action: null,
});
