import type { Ms } from '../context/time';
import { buildSpans, nextEdgeMs, spanAt, type ActionSpan, type PlaybackAction } from './actions';
import { PLAYBACK_POLICY } from './planning';

/**
 * The playback-action coordinator: decides, from the playhead position and a few player signals, when to mute and when to
 * skip. It knows nothing about video elements, React or the classifier: it talks to a tiny `PlaybackSurface` and reports
 * what it did through `onEvent`, so it is tested with a fake surface and no real playback. All times are integer
 * milliseconds; conversion to the player's seconds happens in the surface adapter.
 *
 * Rules (each one is pinned by a test):
 *  MUTE   the media is muted exactly while the playhead is inside an enabled mute span (half-open [start, end)), by the player's
 *         `muted` flag, so the user's volume is never touched. The user's own mute state is remembered and restored; if the user
 *         unmutes during a span, that is respected until the span is left. Overlapping or adjacent mute actions are one span, so
 *         sound is never restored early. Position decides, so seeking, pausing, replaying and rate changes need no special cases.
 *  SKIP   when PLAYBACK enters an enabled skip span (the playhead advances into it, or play starts inside it) the coordinator
 *         seeks to the span's end (never beyond the media duration). A jump that the USER makes into a span (a seek) is
 *         respected: that span is suppressed until the playhead leaves it, so the user is never trapped. A skip waits for its
 *         own seek to arrive (stale updates are ignored), always moves strictly forward, and is retried at most
 *         `maxSkipAttempts` times if the player lands early; after that the span is suppressed.
 *  SKIP wins over MUTE where they overlap (the playhead leaves the region).
 *  OFF    with automatic actions off, or no actions, normal audio is restored immediately and nothing is skipped.
 */
export interface PlaybackSurface {
  /** Playhead in integer milliseconds. */
  readonly currentTimeMs: number;
  /** Media duration in ms, or null while unknown. */
  readonly durationMs: number | null;
  readonly paused: boolean;
  /** Playback speed; 1 when the player does not say. */
  readonly playbackRate?: number;
  muted: boolean;
  /** Asks the player to seek. Completion is reported later with the `seeked` signal. */
  seekToMs(ms: Ms): void;
}

export type PlaybackSignal = 'timeupdate' | 'frame' | 'play' | 'pause' | 'seeked' | 'ended' | 'volumechange';

export type CoordinatorEvent =
  | { type: 'mute-started'; atMs: Ms; actionIds: string[]; findingIds: string[] }
  | { type: 'mute-ended'; atMs: Ms; actionIds: string[]; findingIds: string[] }
  | { type: 'mute-released-by-user'; atMs: Ms; actionIds: string[]; findingIds: string[] }
  | { type: 'skipped'; atMs: Ms; fromMs: Ms; toMs: Ms; actionIds: string[]; findingIds: string[] }
  | { type: 'skip-gave-up'; atMs: Ms; actionIds: string[]; findingIds: string[] };

/** After the media ended, a seek or play within this window of the start is a replay, not the user placing the playhead. */
const REPLAY_WINDOW_MS = 1000;

export class PlaybackCoordinator {
  private muteSpans: ActionSpan[] = [];
  private skipSpans: ActionSpan[] = [];
  private auto = true;
  private applied: { key: string; userMutedBefore: boolean; span: ActionSpan } | null = null;
  private userUnmutedKey: string | null = null;
  private lastSetMuted: boolean | null = null;
  private readonly suppressed = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private pendingSeek: Ms | null = null;
  private lastTime: Ms | null = null;
  private afterEnded = false;

  constructor(private readonly surface: PlaybackSurface, private readonly onEvent: (e: CoordinatorEvent) => void = () => undefined) {}

  /** Replaces the actions and the master switch. Takes effect immediately for muting; skipping acts on the next playback update. */
  setActions(actions: readonly PlaybackAction[], autoEnabled: boolean): void {
    this.auto = autoEnabled;
    this.muteSpans = autoEnabled ? buildSpans(actions, 'mute') : [];
    this.skipSpans = autoEnabled ? buildSpans(actions, 'skip') : [];
    const keys = new Set(this.skipSpans.map((s) => s.key));
    for (const k of [...this.suppressed]) if (!keys.has(k)) this.suppressed.delete(k);
    for (const k of [...this.attempts.keys()]) if (!keys.has(k)) this.attempts.delete(k);
    this.reconcileMute(this.surface.currentTimeMs);
  }

  /** Feed every player signal here. Cheap: a binary search and a few comparisons. */
  handle(signal: PlaybackSignal): void {
    const t = this.surface.currentTimeMs;
    if (!Number.isFinite(t)) return;
    switch (signal) {
      case 'volumechange': this.onVolumeChange(t); return;
      case 'ended':
        this.restoreMute(t);
        this.pendingSeek = null; this.lastTime = null; this.afterEnded = true; this.suppressed.clear(); this.attempts.clear();
        return;
      case 'pause': this.lastTime = t; return;
      case 'seeked': this.onSeeked(t); return;
      case 'play':
        // Playing again after the media ended near the start is a fresh run (nothing the user did earlier applies any more).
        if (this.afterEnded && t < REPLAY_WINDOW_MS) { this.suppressed.clear(); this.attempts.clear(); }
        this.trySkip(t, 'start'); this.reconcileMute(this.effectiveTime(t)); this.lastTime = t; return;
      case 'timeupdate':
      case 'frame': this.onTick(t); return;
    }
  }

  /**
   * How long, in real milliseconds at the current playback rate, until the playhead reaches the next moment that matters (a span
   * starting or ending), or null when nothing lies ahead (nothing to schedule). Lets the caller wake up at the boundary instead of
   * relying on animation frames, which browsers throttle for background or occluded tabs.
   */
  msUntilNextBoundary(): number | null {
    if (!this.auto || this.surface.paused) return null;
    const t = this.effectiveTime(this.surface.currentTimeMs);
    if (!Number.isFinite(t)) return null;
    const edges = [nextEdgeMs(this.muteSpans, t), nextEdgeMs(this.skipSpans, t)].filter((e): e is number => e !== null);
    if (edges.length === 0) return null;
    const rate = this.surface.playbackRate && this.surface.playbackRate > 0 ? this.surface.playbackRate : 1;
    return Math.min(...edges) / rate;
  }

  /** Releases everything the coordinator did to the player (the user's mute state is restored). Call when the source changes or the component goes away. */
  dispose(): void {
    this.restoreMute(this.surface.currentTimeMs);
    this.muteSpans = []; this.skipSpans = []; this.suppressed.clear(); this.attempts.clear();
    this.pendingSeek = null; this.lastTime = null; this.userUnmutedKey = null;
  }

  // ───────── internals ─────────

  private effectiveTime(t: Ms): Ms { return this.pendingSeek ?? t; }

  private onTick(t: Ms): void {
    if (this.pendingSeek !== null) {
      if (t < this.pendingSeek - 250) return; // stale update from before our own seek arrived
      this.pendingSeek = null;
    }
    if (t >= REPLAY_WINDOW_MS) this.afterEnded = false;
    const jumped = this.lastTime !== null && (t < this.lastTime - 50 || t - this.lastTime > PLAYBACK_POLICY.naturalAdvanceMs);
    if (jumped) this.userPlacedAt(t); else this.forgetLeftSpans(t);
    if (!jumped) this.trySkip(t, 'entered');
    this.reconcileMute(this.effectiveTime(t));
    this.lastTime = t;
  }

  private onSeeked(t: Ms): void {
    const ours = this.pendingSeek !== null;
    this.pendingSeek = null;
    if (ours) this.forgetLeftSpans(t);
    else if (this.afterEnded && t < REPLAY_WINDOW_MS) { this.suppressed.clear(); this.attempts.clear(); } // replay from the start: a fresh run
    else { this.afterEnded = false; this.userPlacedAt(t); }
    // Our own seek that landed before the end of the span (keyframe): try again, a bounded number of times.
    if (ours) this.trySkip(t, 'retry');
    this.reconcileMute(this.effectiveTime(t));
    this.lastTime = t;
  }

  /** The user (not playback) put the playhead at `t`: respect it where it is inside a skip span. */
  private userPlacedAt(t: Ms): void {
    this.suppressed.clear();
    const here = spanAt(this.skipSpans, t);
    if (here) this.suppressed.add(here.key);
  }

  /** Once the playhead is seen outside a skip span, that span is fresh again (its suppression and retry count are forgotten). */
  private forgetLeftSpans(t: Ms): void {
    if (this.suppressed.size === 0 && this.attempts.size === 0) return;
    const here = spanAt(this.skipSpans, t);
    for (const k of [...this.suppressed]) if (here?.key !== k) this.suppressed.delete(k);
    for (const k of [...this.attempts.keys()]) if (here?.key !== k) this.attempts.delete(k);
  }

  private trySkip(t: Ms, why: 'entered' | 'start' | 'retry'): void {
    if (!this.auto || this.pendingSeek !== null) return;
    const span = spanAt(this.skipSpans, t);
    if (!span || this.suppressed.has(span.key)) return;
    if (why !== 'start' && this.surface.paused) return; // a paused playhead is not "playing into" anything
    const duration = this.surface.durationMs;
    const target = duration !== null && Number.isFinite(duration) ? Math.min(span.endMs, Math.max(0, duration)) : span.endMs;
    if (!(target > t)) return; // strictly forward only: this is what makes a loop impossible
    const n = (this.attempts.get(span.key) ?? 0) + 1;
    if (n > PLAYBACK_POLICY.maxSkipAttempts) {
      this.suppressed.add(span.key);
      this.onEvent({ type: 'skip-gave-up', atMs: t, actionIds: span.actionIds, findingIds: span.findingIds });
      return;
    }
    this.attempts.set(span.key, n);
    this.pendingSeek = target;
    this.surface.seekToMs(target);
    this.onEvent({ type: 'skipped', atMs: t, fromMs: t, toMs: target, actionIds: span.actionIds, findingIds: span.findingIds });
  }

  private reconcileMute(t: Ms): void {
    const inside = this.auto ? spanAt(this.muteSpans, t) : null;
    if (!inside) {
      this.userUnmutedKey = null;
      this.restoreMute(t);
      return;
    }
    if (this.userUnmutedKey !== null && this.userUnmutedKey !== inside.key) this.userUnmutedKey = null;
    if (this.applied) { this.applied = { ...this.applied, key: inside.key, span: inside }; return; }
    if (this.userUnmutedKey === inside.key) return; // the user took control inside this span
    const userMutedBefore = this.surface.muted;
    this.surface.muted = true;
    this.lastSetMuted = true;
    this.applied = { key: inside.key, userMutedBefore, span: inside };
    this.onEvent({ type: 'mute-started', atMs: t, actionIds: inside.actionIds, findingIds: inside.findingIds });
  }

  private restoreMute(t: Ms): void {
    if (!this.applied) return;
    const { userMutedBefore, span } = this.applied;
    this.applied = null;
    this.surface.muted = userMutedBefore;
    this.lastSetMuted = userMutedBefore;
    this.onEvent({ type: 'mute-ended', atMs: t, actionIds: span.actionIds, findingIds: span.findingIds });
  }

  private onVolumeChange(t: Ms): void {
    if (!this.applied) return;
    const now = this.surface.muted;
    if (now === this.lastSetMuted) return; // the echo of our own change
    if (now === false) {
      // The user unmuted during a mute span: respect it until the span is left.
      const { key, span } = this.applied;
      this.applied = null;
      this.userUnmutedKey = key;
      this.lastSetMuted = false;
      this.onEvent({ type: 'mute-released-by-user', atMs: t, actionIds: span.actionIds, findingIds: span.findingIds });
    }
  }
}
