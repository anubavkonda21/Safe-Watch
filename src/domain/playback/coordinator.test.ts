import { Harness, act, POLICY } from '@/test/playback';

describe('mute', () => {
  it('mutes exactly while the playhead is inside the span (half-open) and restores afterwards', () => {
    const h = new Harness([act('a', 'mute', 10_000, 11_000)]);
    h.playTo(9_750);
    expect(h.surface.muted).toBe(false);
    h.playTo(10_000);
    expect(h.surface.muted).toBe(true); // the start is inside
    h.playTo(10_750);
    expect(h.surface.muted).toBe(true);
    h.playTo(11_000);
    expect(h.surface.muted).toBe(false); // the end is outside
    expect(h.types()).toEqual(['mute-started', 'mute-ended']);
  });
  it('starts inside a span when playback begins there (position decides)', () => {
    const h = new Harness([act('a', 'mute', 0, 500)]);
    h.at(100).play();
    expect(h.surface.muted).toBe(true);
    h.playTo(600);
    expect(h.surface.muted).toBe(false);
  });
  it('never touches the volume: only the muted flag changes', () => {
    const h = new Harness([act('a', 'mute', 1000, 2000)]);
    h.surface.volume = 0.7;
    h.playTo(3000);
    expect(h.surface.volume).toBe(0.7);
    expect(h.types()).toEqual(['mute-started', 'mute-ended']);
  });
  it("restores the user's own mute: a user who was already muted stays muted afterwards", () => {
    const h = new Harness([act('a', 'mute', 1000, 2000)]);
    h.userSetMuted(true);
    h.playTo(1500);
    expect(h.surface.muted).toBe(true);
    h.playTo(2500);
    expect(h.surface.muted).toBe(true);
  });
  it('respects a user who unmutes during the span, and does not fight them until the span is left', () => {
    const h = new Harness([act('a', 'mute', 1000, 3000)]);
    h.playTo(1500);
    h.userSetMuted(false);
    expect(h.types()).toEqual(['mute-started', 'mute-released-by-user']);
    h.playTo(2500);
    expect(h.surface.muted).toBe(false);
    h.playTo(3500);
    expect(h.surface.muted).toBe(false);
    expect(h.types()).toEqual(['mute-started', 'mute-released-by-user']); // nothing to restore: no stray mute-ended
  });
  it('mutes again at the NEXT span after the user unmuted inside the previous one', () => {
    const h = new Harness([act('a', 'mute', 1000, 2000), act('b', 'mute', 5000, 6000)]);
    h.playTo(1500); h.userSetMuted(false); h.playTo(5500);
    expect(h.surface.muted).toBe(true);
  });
  it('ignores the echo of its own change (the volumechange event fired by setting muted)', () => {
    const h = new Harness([act('a', 'mute', 1000, 3000)]);
    h.playTo(1500);
    h.coordinator.handle('volumechange'); // echo: muted is still what we set
    h.coordinator.handle('volumechange');
    expect(h.surface.muted).toBe(true);
    expect(h.types()).toEqual(['mute-started']);
  });
  it('volume changes by the user never matter: the user may change volume freely during a span', () => {
    const h = new Harness([act('a', 'mute', 1000, 3000)]);
    h.playTo(1500);
    h.surface.volume = 0.3;
    h.coordinator.handle('volumechange');
    h.playTo(3500);
    expect(h.surface.volume).toBe(0.3);
    expect(h.surface.muted).toBe(false);
  });
  it('overlapping mute actions are one span: sound is never restored early', () => {
    const h = new Harness([act('a', 'mute', 1000, 3000), act('b', 'mute', 2000, 4000)]);
    h.playTo(3500);
    expect(h.surface.muted).toBe(true); // between the first end and the second end
    h.playTo(4000);
    expect(h.surface.muted).toBe(false);
    expect(h.types()).toEqual(['mute-started', 'mute-ended']);
    expect(h.events[0]).toMatchObject({ findingIds: ['a', 'b'] });
  });
  it('adjacent mute actions are one span: no unmuted instant at the boundary', () => {
    const h = new Harness([act('a', 'mute', 1000, 2000), act('b', 'mute', 2000, 3000)]);
    h.playTo(3500, 100);
    expect(h.mutedTrace.filter(([t]) => t >= 1000 && t < 3000).every(([, m]) => m)).toBe(true);
    expect(h.types()).toEqual(['mute-started', 'mute-ended']);
  });
  it('separate spans each mute and restore', () => {
    const h = new Harness([act('a', 'mute', 1000, 2000), act('b', 'mute', 5000, 6000)]);
    h.playTo(7000);
    expect(h.types()).toEqual(['mute-started', 'mute-ended', 'mute-started', 'mute-ended']);
  });
  it('multiple findings at the same timestamp are one span with every source kept', () => {
    const h = new Harness([act('a', 'mute', 1000, 2000), act('b', 'mute', 1000, 2000), act('c', 'mute', 1000, 1500)]);
    h.playTo(1500);
    expect(h.events).toHaveLength(1);
    expect([...(h.events[0] as { findingIds: string[] }).findingIds].sort()).toEqual(['a', 'b', 'c']);
    expect(h.events[0]!.type).toBe('mute-started');
  });
  it('seeking into a span mutes, seeking out restores, seeking across spans leaves the right state', () => {
    const h = new Harness([act('a', 'mute', 10_000, 11_000), act('b', 'mute', 20_000, 21_000)]);
    h.userSeek(10_500);
    expect(h.surface.muted).toBe(true);
    h.userSeek(30_000); // out, across the second span without playing it
    expect(h.surface.muted).toBe(false);
    h.userSeek(20_500);
    expect(h.surface.muted).toBe(true);
    h.userSeek(10_500); // from one span straight into another place inside the first
    expect(h.surface.muted).toBe(true);
    h.userSeek(0);
    expect(h.surface.muted).toBe(false);
  });
  it('pausing inside a span keeps it muted; resuming continues; replay restores and mutes again', () => {
    const h = new Harness([act('a', 'mute', 1000, 3000)]);
    h.playTo(1500).pause();
    expect(h.surface.muted).toBe(true);
    h.play().playTo(3500);
    expect(h.surface.muted).toBe(false);
    h.ended().replay().playTo(1500);
    expect(h.surface.muted).toBe(true);
  });
  it('does not depend on the playback rate: only position counts (fast steps cross a span)', () => {
    const h = new Harness([act('a', 'mute', 1200, 1300)]);
    h.playTo(5000, 1000); // updates at 1000 and 2000: never inside the span
    expect(h.types()).toEqual([]);
    const g = new Harness([act('a', 'mute', 1000, 1100)]);
    g.playTo(5000, 20);
    expect(g.types()).toEqual(['mute-started', 'mute-ended']);
  });
  it('turning automatic actions off restores normal audio at once, even mid-span; turning on mutes again', () => {
    const acts = [act('a', 'mute', 1000, 5000)];
    const h = new Harness(acts);
    h.playTo(2000);
    expect(h.surface.muted).toBe(true);
    h.setActions(acts, false);
    expect(h.surface.muted).toBe(false);
    h.playTo(3000);
    expect(h.surface.muted).toBe(false);
    h.setActions(acts, true);
    expect(h.surface.muted).toBe(true);
  });
  it('removing or ignoring the action mid-span restores audio immediately', () => {
    const h = new Harness([act('a', 'mute', 1000, 5000)]);
    h.playTo(2000);
    h.setActions([]);
    expect(h.surface.muted).toBe(false);
  });
  it('switching an action from mute to skip mid-span unmutes and skips on the next update', () => {
    const h = new Harness([act('a', 'mute', 1000, 5000)]);
    h.playTo(2000);
    h.setActions([act('a', 'skip', 1000, 5000)]);
    expect(h.surface.muted).toBe(false);
    h.playTo(2250);
    expect(h.skips()).toHaveLength(1);
  });
  it('dispose restores the audio the user had and forgets everything', () => {
    const h = new Harness([act('a', 'mute', 1000, 5000)]);
    h.userSetMuted(false);
    h.playTo(2000);
    expect(h.surface.muted).toBe(true);
    h.coordinator.dispose();
    expect(h.surface.muted).toBe(false);
    h.playTo(3000);
    expect(h.surface.muted).toBe(false);
  });
  it('ends the media inside a span: audio is restored', () => {
    const h = new Harness([act('a', 'mute', 59_000, 60_000)], true, 60_000);
    h.playTo(59_500);
    expect(h.surface.muted).toBe(true);
    h.playTo(70_000);
    expect(h.surface.muted).toBe(false);
  });
});

describe('skip', () => {
  it('skips to the end of the span when playback enters it, and only once', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.playTo(20_000);
    expect(h.skips()).toEqual([{ type: 'skipped', atMs: 10_000, fromMs: 10_000, toMs: 12_000, actionIds: ['pa-a'], findingIds: ['a'] }]);
    expect(h.surface.seeks).toEqual([12_000]);
  });
  it('begins before, inside and after the interval', () => {
    const before = new Harness([act('a', 'skip', 10_000, 12_000)]).at(5000).playTo(11_000);
    expect(before.surface.seeks).toEqual([12_000]);
    const inside = new Harness([act('a', 'skip', 10_000, 12_000)]).at(10_500).play();
    expect(inside.surface.seeks).toEqual([12_000]); // playback starts inside: it skips
    const after = new Harness([act('a', 'skip', 10_000, 12_000)]).at(13_000).playTo(20_000);
    expect(after.surface.seeks).toEqual([]);
  });
  it('does not repeat when the player keeps emitting updates around the seek (stale updates are ignored)', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.playTo(10_000);
    for (const t of [10_100, 10_200, 10_300]) { h.surface.timeMs = t; h.coordinator.handle('timeupdate'); } // before the seek arrives
    expect(h.surface.seeks).toEqual([12_000]);
    h.settle();
    h.playTo(13_000);
    expect(h.surface.seeks).toEqual([12_000]);
  });
  it('handles a player that lands before the end (keyframe): retries a bounded number of times, then gives up and suppresses', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.surface.landOffsetMs = -1500; // always lands 1.5 s early, still inside the span
    h.playTo(10_000);
    expect(h.surface.seeks.length).toBe(POLICY.maxSkipAttempts);
    expect(h.types().at(-1)).toBe('skip-gave-up');
    h.playTo(12_500);
    expect(h.surface.seeks.length).toBe(POLICY.maxSkipAttempts); // no loop
  });
  it('a player that lands slightly early but outside the span needs no retry', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.surface.landOffsetMs = 30;
    h.playTo(11_000);
    expect(h.surface.seeks).toEqual([12_000]);
  });
  it('overlapping skip actions become one span: one seek to the end of the union, every finding kept', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000), act('b', 'skip', 11_000, 14_000), act('c', 'skip', 12_500, 13_000)]);
    h.playTo(20_000);
    expect(h.surface.seeks).toEqual([14_000]);
    expect([...h.skips()[0]!.findingIds].sort()).toEqual(['a', 'b', 'c']);
  });
  it('adjacent skip actions are one span: one seek, not a stop at the boundary', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000), act('b', 'skip', 12_000, 13_000)]);
    h.playTo(20_000);
    expect(h.surface.seeks).toEqual([13_000]);
  });
  it('separate skip spans each skip once', () => {
    const h = new Harness([act('a', 'skip', 10_000, 11_000), act('b', 'skip', 20_000, 21_000)]);
    h.playTo(30_000);
    expect(h.surface.seeks).toEqual([11_000, 21_000]);
  });
  it('never seeks beyond the media duration: the last span skips to the end', () => {
    const h = new Harness([act('a', 'skip', 58_000, 70_000)], true, 60_000);
    h.playTo(58_000);
    expect(h.surface.seeks).toEqual([60_000]);
  });
  it('does not skip while the duration is unknown beyond the span end it was given', () => {
    const h = new Harness([act('a', 'skip', 1000, 2000)], true, null);
    h.playTo(1000);
    expect(h.surface.seeks).toEqual([2000]);
  });
  it('a user seek INTO a skip span is respected: no skip, no trap, until the playhead leaves it', () => {
    const h = new Harness([act('a', 'skip', 10_000, 20_000)]);
    h.at(0).play();
    h.userSeek(15_000);
    h.playTo(18_000);
    expect(h.surface.seeks).toEqual([]);
    h.playTo(21_000);
    expect(h.surface.seeks).toEqual([]);
  });
  it('after the user leaves the span, entering it again by playback skips again', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.userSeek(11_000);
    h.playTo(13_000);
    h.userSeek(8_000);
    h.playTo(11_000);
    expect(h.surface.seeks).toEqual([12_000]);
  });
  it('a user seek across several skip spans lands outside them: nothing is skipped or trapped', () => {
    const h = new Harness([act('a', 'skip', 10_000, 11_000), act('b', 'skip', 20_000, 21_000)]);
    h.at(0).play();
    h.userSeek(30_000);
    h.playTo(31_000);
    expect(h.surface.seeks).toEqual([]);
  });
  it('seeking while paused inside a span, then playing, does not skip (the user chose the place)', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.userSeek(11_000);
    h.play();
    expect(h.surface.seeks).toEqual([]);
  });
  it('a paused playhead is not skipped when updates arrive', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.at(5000);
    h.surface.paused = true;
    h.surface.timeMs = 10_500;
    h.coordinator.handle('timeupdate');
    expect(h.surface.seeks).toEqual([]);
  });
  it('a large jump with no seeked event counts as a user jump', () => {
    const h = new Harness([act('a', 'skip', 10_000, 12_000)]);
    h.at(1000).play();
    h.surface.timeMs = 11_000; // 10 s jump
    h.coordinator.handle('timeupdate');
    expect(h.surface.seeks).toEqual([]);
  });
  it('replay after the end: the span at the start is skipped again, and earlier choices are forgotten', () => {
    const h = new Harness([act('a', 'skip', 0, 1000), act('b', 'skip', 5000, 6000)], true, 10_000);
    h.at(0).play();
    h.playTo(20_000);
    expect(h.surface.seeks).toEqual([1000, 6000]);
    h.replay();
    h.playTo(20_000);
    expect(h.surface.seeks).toEqual([1000, 6000, 1000, 6000]);
  });
  it('repeated replays keep skipping (the retry counter does not run out across replays)', () => {
    const h = new Harness([act('a', 'skip', 5000, 6000)], true, 10_000);
    for (let i = 0; i < 6; i++) { h.at(i === 0 ? 0 : 0).playTo(20_000); if (i < 5) h.replay(); }
    expect(h.surface.seeks).toEqual([6000, 6000, 6000, 6000, 6000, 6000]);
  });
  it('seeking backwards before a span and playing through skips every time', () => {
    const h = new Harness([act('a', 'skip', 5000, 6000)]);
    for (let i = 0; i < 5; i++) { h.userSeek(2000); h.playTo(7000); }
    expect(h.surface.seeks).toHaveLength(5);
  });
  it('always moves forward: no sequence of updates can produce a backward or repeated seek to the same place', () => {
    const h = new Harness([act('a', 'skip', 1000, 3000), act('b', 'skip', 2000, 5000), act('c', 'skip', 8000, 9000)]);
    for (let t = 0; t < 12_000; t += 40) { h.surface.timeMs = t; h.surface.paused = false; h.coordinator.handle('frame'); h.settle(); }
    expect(h.surface.seeks).toEqual([5000, 9000]);
  });
});

describe('master switch, ignoring, unavailable', () => {
  it('automatic actions off: nothing is skipped, nothing is muted, the user watches normally', () => {
    const h = new Harness([act('a', 'skip', 1000, 2000), act('b', 'mute', 5000, 6000)], false);
    h.playTo(8000);
    expect(h.surface.seeks).toEqual([]);
    expect(h.types()).toEqual([]);
    expect(h.surface.muted).toBe(false);
  });
  it('disabled actions (master switch off in the resolved action list) are inert even if passed in', () => {
    const h = new Harness([act('a', 'skip', 1000, 2000, { status: 'disabled' })], true);
    h.playTo(3000);
    expect(h.surface.seeks).toEqual([]);
  });
  it('turning actions off while a skip is pending lets the user go on from where the player is', () => {
    const acts = [act('a', 'skip', 1000, 5000)];
    const h = new Harness(acts);
    h.playTo(1000);
    h.setActions(acts, false);
    h.settle();
    h.playTo(6000);
    expect(h.surface.seeks).toEqual([5000]); // the skip already requested completes; nothing new is requested
  });
  it('no actions: the coordinator does nothing at all', () => {
    const h = new Harness([]);
    h.playTo(10_000);
    expect(h.events).toEqual([]);
  });
});

describe('switching media', () => {
  it('dispose then a new coordinator: stale actions never apply to the new media', () => {
    const first = new Harness([act('a', 'mute', 1000, 5000)]);
    first.playTo(2000);
    first.coordinator.dispose();
    const second = new Harness([]); // the new media has no actions
    second.playTo(3000);
    expect(second.surface.muted).toBe(false);
    expect(first.surface.muted).toBe(false);
  });
  it('after dispose, late events from the old player are harmless', () => {
    const h = new Harness([act('a', 'skip', 1000, 5000)]);
    h.playTo(500);
    h.coordinator.dispose();
    h.surface.timeMs = 1500;
    h.coordinator.handle('timeupdate');
    h.coordinator.handle('seeked');
    h.coordinator.handle('volumechange');
    expect(h.surface.seeks).toEqual([]);
  });
});

describe('robustness', () => {
  it('ignores a non-finite playhead', () => {
    const h = new Harness([act('a', 'skip', 1000, 2000)]);
    h.surface.timeMs = Number.NaN;
    expect(() => h.coordinator.handle('timeupdate')).not.toThrow();
    expect(h.surface.seeks).toEqual([]);
  });
  it('ignores zero-length actions', () => {
    const h = new Harness([act('a', 'mute', 1000, 1000), act('b', 'skip', 2000, 2000)]);
    h.playTo(3000, 10);
    expect(h.events).toEqual([]);
  });
  it('handles a skip span that already ended before the playhead (nothing to do, no seek)', () => {
    const h = new Harness([act('a', 'skip', 1000, 2000)]);
    h.at(5000).play();
    expect(h.surface.seeks).toEqual([]);
  });
  it('is deterministic: the same signals give the same events', () => {
    const run = () => { const h = new Harness([act('a', 'mute', 1000, 2000), act('b', 'skip', 5000, 7000)]); h.playTo(4000).userSeek(1500).playTo(9000); return JSON.stringify([h.events, h.surface.seeks]); };
    expect(run()).toBe(run());
  });
});

describe('msUntilNextBoundary (lets the player wake up at a boundary instead of waiting for the next update)', () => {
  it('is the time to the next span start, then to its end, in real time at the current rate', () => {
    const h = new Harness([act('a', 'mute', 10_000, 12_000), act('b', 'skip', 20_000, 21_000)]);
    h.at(8_000);
    h.surface.paused = false;
    expect(h.coordinator.msUntilNextBoundary()).toBe(2_000);
    h.at(10_500).coordinator.handle('timeupdate');
    expect(h.coordinator.msUntilNextBoundary()).toBe(1_500); // inside the mute span: its end
    h.at(15_000);
    expect(h.coordinator.msUntilNextBoundary()).toBe(5_000); // the skip start
    (h.surface as unknown as { playbackRate: number }).playbackRate = 2;
    expect(h.coordinator.msUntilNextBoundary()).toBe(2_500); // twice as fast: half the real time
  });
  it('is null when nothing lies ahead, when paused, when automatic actions are off, and with no actions', () => {
    const acts = [act('a', 'mute', 10_000, 12_000)];
    const h = new Harness(acts);
    h.surface.paused = false;
    h.at(13_000);
    expect(h.coordinator.msUntilNextBoundary()).toBeNull();
    h.at(5_000);
    h.surface.paused = true;
    expect(h.coordinator.msUntilNextBoundary()).toBeNull();
    h.surface.paused = false;
    expect(h.coordinator.msUntilNextBoundary()).toBe(5_000);
    h.setActions(acts, false);
    expect(h.coordinator.msUntilNextBoundary()).toBeNull();
    expect(new Harness([]).coordinator.msUntilNextBoundary()).toBeNull();
  });
  it('is not confused by a pending skip (it measures from where the skip will land)', () => {
    const h = new Harness([act('a', 'skip', 1000, 5000), act('b', 'mute', 6000, 7000)]);
    h.at(0).play();
    h.surface.timeMs = 1000;
    h.coordinator.handle('timeupdate'); // requests the skip to 5000, not yet landed
    expect(h.surface.seeks).toEqual([5000]);
    expect(h.coordinator.msUntilNextBoundary()).toBe(1000); // 6000 - 5000
  });
});
