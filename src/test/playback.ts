import type { PlaybackAction, ActionType } from '@/domain/playback/actions';
import { PlaybackCoordinator, type CoordinatorEvent, type PlaybackSurface } from '@/domain/playback/coordinator';
import { PLAYBACK_POLICY } from '@/domain/playback/planning';

/** A player that exists only as data: no media, no clock, no timers. */
export class FakeSurface implements PlaybackSurface {
  timeMs = 0;
  durationMs: number | null = 60_000;
  paused = true;
  muted = false;
  /** The user's volume: the coordinator must never change it. */
  volume = 1;
  /** Every seek the coordinator requested. */
  seeks: number[] = [];
  /** Where a requested seek lands relative to the target (a player that seeks to the previous keyframe lands early). */
  landOffsetMs = 0;
  pendingLand: number | null = null;
  get currentTimeMs() { return this.timeMs; }
  seekToMs(ms: number) { this.seeks.push(ms); this.pendingLand = ms + this.landOffsetMs; }
}

export const act = (id: string, type: ActionType, startMs: number, endMs: number, over: Partial<PlaybackAction> = {}): PlaybackAction => ({
  id: `pa-${id}`, mediaId: 'm', findingId: id, type, startMs, endMs, status: 'enabled', category: 'flagged-terms', findingStatus: 'detected', term: 'darn',
  timing: { quality: 'word', startApproximate: true, endApproximate: true, marginBeforeMs: 0, marginAfterMs: 0, note: 'n' }, warnings: [], reason: `reason ${id}`, ...over,
});

/**
 * Drives a coordinator like a real player would: natural playback in steps (an update every `stepMs`), seeks that complete
 * BEFORE the next update, user seeks, user mute changes. Deterministic: no real time passes.
 */
export class Harness {
  readonly surface = new FakeSurface();
  readonly events: CoordinatorEvent[] = [];
  readonly coordinator: PlaybackCoordinator;
  /** Mute state after every update, to assert on the whole run. */
  readonly mutedTrace: Array<[number, boolean]> = [];

  constructor(actions: PlaybackAction[] = [], auto = true, durationMs: number | null = 60_000) {
    this.surface.durationMs = durationMs;
    this.coordinator = new PlaybackCoordinator(this.surface, (e) => this.events.push(e));
    this.coordinator.setActions(actions, auto);
  }

  setActions(actions: PlaybackAction[], auto = true) { this.coordinator.setActions(actions, auto); }
  at(ms: number) { this.surface.timeMs = ms; return this; }

  play() { this.surface.paused = false; this.coordinator.handle('play'); this.settle(); return this; }
  pause() { this.surface.paused = true; this.coordinator.handle('pause'); return this; }

  /** Natural playback from the current position to `toMs`. */
  playTo(toMs: number, stepMs = 250) {
    if (this.surface.paused) this.play();
    for (let guard = 0; guard < 100_000 && this.surface.timeMs < toMs; guard++) {
      const next = Math.min(toMs, this.surface.timeMs + stepMs);
      const duration = this.surface.durationMs;
      if (duration !== null && next >= duration) { this.surface.timeMs = duration; this.coordinator.handle('timeupdate'); this.ended(); return this; }
      this.surface.timeMs = next;
      this.coordinator.handle('timeupdate');
      this.settle();
      this.mutedTrace.push([this.surface.timeMs, this.surface.muted]);
    }
    return this;
  }

  /** Completes a seek the coordinator asked for, like a player would, then reports it. */
  settle() {
    for (let guard = 0; guard < 10 && this.surface.pendingLand !== null; guard++) {
      const land = this.surface.pendingLand;
      this.surface.pendingLand = null;
      this.surface.timeMs = Math.min(land, this.surface.durationMs ?? land);
      this.coordinator.handle('seeked');
    }
  }

  /** The USER moves the playhead. */
  userSeek(ms: number) { this.surface.timeMs = ms; this.coordinator.handle('seeked'); this.settle(); return this; }
  userSetMuted(muted: boolean) { this.surface.muted = muted; this.coordinator.handle('volumechange'); return this; }
  ended() { this.surface.paused = true; this.coordinator.handle('ended'); return this; }
  replay() { this.surface.timeMs = 0; this.coordinator.handle('seeked'); this.surface.paused = false; this.coordinator.handle('play'); this.settle(); return this; }
  types() { return this.events.map((e) => e.type); }
  skips() { return this.events.filter((e): e is Extract<CoordinatorEvent, { type: 'skipped' }> => e.type === 'skipped'); }
}

export const POLICY = PLAYBACK_POLICY;
