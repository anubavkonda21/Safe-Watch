import type { Ms } from '../context/time';
import type { PlaybackSignal } from '../playback/coordinator';
import type { WarningGroup } from './groups';

/** What the scheduler needs from the player. Same shape as the CP8 `PlaybackSurface`, read-only. */
export interface WarningSurface {
  readonly currentTimeMs: number;
  readonly durationMs: number | null;
  readonly paused: boolean;
  readonly playbackRate?: number;
}

export interface WarningSettings {
  enabled: boolean;
  /** How long before the finding's start the warning appears. */
  leadMs: Ms;
  /** How long it stays when the user does nothing. */
  durationMs: Ms;
}

export interface ActiveWarning {
  id: string;
  group: WarningGroup;
  /** Playhead when it appeared. */
  shownAtMs: Ms;
  /** How long until the finding begins, when it appeared (never negative). */
  startsInMs: Ms;
  /** Whether this warning was reached late: the finding began closer than the lead time. */
  late: boolean;
}

export type HideReason = 'expired' | 'dismissed' | 'handled' | 'started' | 'left' | 'ended' | 'disabled' | 'removed' | 'disposed';

export type WarningEvent =
  | { type: 'show'; warning: ActiveWarning }
  | { type: 'hide'; id: string; reason: HideReason };

type GroupState = 'armed' | 'done';

/** Real time between one warning going away and the next appearing, so consecutive warnings read as separate events. */
export const WARNING_GAP_MS = 500;

/**
 * Decides WHEN to show a heads-up about an upcoming finding, and when to take it away. Deterministic: it reads the playhead,
 * an injected monotonic clock and its inputs, and reports through `onEvent`. It never plays, mutes, skips or seeks: the user's
 * choices go through the CP8 settings and coordinator, so a warning that disappears can never count as consent.
 *
 * Policy (each rule is pinned by a test):
 *  - A group is warned about once each time the playhead ENTERS its window [start - lead, start). A warning is never shown
 *    for a finding that has already begun, and never for a playhead that is paused (a seek made while paused warns on play).
 *  - Seeking into a window warns at once and says it is late; seeking forward past the finding, or out of the window, takes the
 *    warning away; a window that is left (either direction) is armed again, so replay and seeking back warn again, but a warning
 *    already shown is not repeated while the playhead stays inside the window.
 *  - One warning at a time. Groups wait in start order; one whose finding begins before its turn is skipped (never stale).
 *    Findings that overlap or touch are one group (see buildWarningGroups).
 *  - A warning disappears after `durationMs` of real time, unless it is held (pointer or keyboard focus on it): then the
 *    remaining time is kept and resumes on release. Time comes from the injected clock, so a throttled timer only delays the
 *    check, never the outcome: the next evaluation sees the true time.
 *  - The master switch off, or warnings disabled, shows nothing and hides what is showing.
 */
export class WarningScheduler {
  private groups: WarningGroup[] = [];
  private settings: WarningSettings = { enabled: false, leadMs: 20_000, durationMs: 3_000 };
  private auto = true;
  private readonly state = new Map<string, GroupState>();
  private active: { warning: ActiveWarning; deadline: number; heldRemaining: number | null } | null = null;
  private lastHideAt: number | null = null;

  constructor(private readonly surface: WarningSurface, private readonly clock: () => number, private readonly onEvent: (e: WarningEvent) => void = () => undefined) {}

  setInputs(groups: readonly WarningGroup[], settings: WarningSettings, autoEnabled: boolean): void {
    this.groups = [...groups].sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.settings = settings;
    this.auto = autoEnabled;
    const ids = new Set(this.groups.map((g) => g.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
    if (this.active && !ids.has(this.active.warning.id)) this.hide('removed');
    this.evaluate();
  }

  /** Feed every player signal (the same ones the CP8 coordinator receives) and every timer wake-up (`frame`). */
  handle(signal: PlaybackSignal): void {
    if (signal === 'ended') { this.hide('ended'); this.state.clear(); return; }
    this.evaluate();
  }

  /** The user pressed Skip or Ignore (the caller has already applied it through the CP8 settings). */
  resolve(): void { this.hide('handled'); }
  dismiss(): void { this.hide('dismissed'); }

  /** Pointer or keyboard focus is on the warning: keep it visible. */
  hold(): void {
    if (this.active && this.active.heldRemaining === null) this.active.heldRemaining = Math.max(0, this.active.deadline - this.clock());
  }

  release(): void {
    if (this.active && this.active.heldRemaining !== null) {
      this.active.deadline = this.clock() + this.active.heldRemaining;
      this.active.heldRemaining = null;
    }
    this.evaluate();
  }

  /** Real milliseconds until the next moment that needs an evaluation, or null. Lets the caller sleep until then. */
  msUntilNext(): number | null {
    const t = this.surface.currentTimeMs;
    if (!Number.isFinite(t)) return null;
    const rate = this.surface.playbackRate && this.surface.playbackRate > 0 ? this.surface.playbackRate : 1;
    const waits: number[] = [];
    if (this.active) {
      if (this.active.heldRemaining === null) waits.push(Math.max(0, this.active.deadline - this.clock()));
      if (!this.surface.paused) waits.push(Math.max(0, (this.active.warning.group.startMs - t) / rate));
    } else if (this.auto && this.settings.enabled && !this.surface.paused) {
      const gap = this.gapLeft();
      for (const g of this.groups) {
        if (this.state.get(g.id) === 'done') continue;
        const open = this.windowStart(g);
        if (open > t) waits.push((open - t) / rate);
        else if (t < g.startMs) waits.push(gap);
      }
    }
    return waits.length === 0 ? null : Math.min(...waits);
  }

  dispose(): void {
    this.hide('disposed');
    this.groups = []; this.state.clear();
  }

  // ───────── internals ─────────

  private gapLeft(): number { return this.lastHideAt === null ? 0 : Math.max(0, this.lastHideAt + WARNING_GAP_MS - this.clock()); }
  private windowStart(g: WarningGroup): Ms { return Math.max(0, g.startMs - this.settings.leadMs); }
  private inWindow(g: WarningGroup, t: Ms): boolean { return t >= this.windowStart(g) && t < g.startMs; }

  private hide(reason: HideReason): void {
    if (!this.active) return;
    const { warning } = this.active;
    this.active = null;
    this.lastHideAt = this.clock();
    this.state.set(warning.id, 'done');
    this.onEvent({ type: 'hide', id: warning.id, reason });
  }

  private evaluate(): void {
    const t = this.surface.currentTimeMs;
    if (!Number.isFinite(t)) return;
    if (!this.auto || !this.settings.enabled) { this.hide('disabled'); return; }

    // A window that has been left is armed again: that is what makes replay and seeking back warn again.
    for (const g of this.groups) if (this.state.get(g.id) === 'done' && !this.inWindow(g, t) && !(this.active?.warning.id === g.id)) this.state.set(g.id, 'armed');

    if (this.active) {
      const g = this.active.warning.group;
      if (t >= g.startMs) this.hide('started');
      else if (t < this.windowStart(g)) { this.hide('left'); this.state.set(g.id, 'armed'); }
      else if (this.active.heldRemaining === null && this.clock() >= this.active.deadline) this.hide('expired');
    }
    if (this.active || this.surface.paused || this.gapLeft() > 0) return;

    const next = this.groups.find((g) => (this.state.get(g.id) ?? 'armed') === 'armed' && this.inWindow(g, t));
    if (!next) return;
    const startsInMs = Math.max(0, next.startMs - t);
    const warning: ActiveWarning = { id: next.id, group: next, shownAtMs: t, startsInMs, late: startsInMs < this.settings.leadMs - 1000 };
    this.active = { warning, deadline: this.clock() + this.settings.durationMs, heldRemaining: null };
    this.state.set(next.id, 'done');
    this.onEvent({ type: 'show', warning });
  }
}
