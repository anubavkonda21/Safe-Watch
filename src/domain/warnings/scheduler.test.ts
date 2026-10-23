import { WARNING_GAP_MS } from './scheduler';
import { WarnHarness, grp, SETTINGS } from '@/test/warnings';

describe('lead time', () => {
  it('shows exactly when the playhead reaches 20 s before the finding (inclusive), and not a moment earlier', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.at(0).playTo(9_750);
    expect(h.shows()).toHaveLength(0);
    h.playTo(10_000); // 30 000 - 20 000
    expect(h.shows()).toHaveLength(1);
    expect(h.shows()[0]!.warning).toMatchObject({ id: 'a', shownAtMs: 10_000, startsInMs: 20_000, late: false });
  });
  it('a finding more than 20 s away produces nothing until the window opens', () => {
    const h = new WarnHarness([grp('a', 90_000)]);
    h.playTo(69_000);
    expect(h.shows()).toHaveLength(0);
    h.playTo(70_000);
    expect(h.shows()).toHaveLength(1);
  });
  it('a finding less than 20 s away (seek into the window) warns at once, says it is late, and gives the real time left', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.at(0).play();
    h.seek(24_000);
    expect(h.shows()).toHaveLength(1);
    expect(h.shows()[0]!.warning).toMatchObject({ startsInMs: 6_000, late: true });
  });
  it('a finding at the start of the media has a window that starts at 0 (never a negative time)', () => {
    const h = new WarnHarness([grp('a', 5_000)]);
    h.at(0).play();
    expect(h.shows()).toHaveLength(1);
    expect(h.shows()[0]!.warning.startsInMs).toBe(5_000);
    expect(h.scheduler.msUntilNext()).toBeGreaterThanOrEqual(0);
  });
  it('never warns for a finding that has already begun (playhead at or after its start)', () => {
    const at = new WarnHarness([grp('a', 30_000)]);
    at.at(30_000).play();
    expect(at.shows()).toHaveLength(0);
    const after = new WarnHarness([grp('a', 30_000)]);
    after.at(45_000).play();
    expect(after.shows()).toHaveLength(0);
  });
  it('honours a different lead time from the settings', () => {
    const h = new WarnHarness([grp('a', 60_000)], { ...SETTINGS, leadMs: 10_000 });
    h.playTo(49_750);
    expect(h.shows()).toHaveLength(0);
    h.playTo(50_000);
    expect(h.shows()).toHaveLength(1);
  });
});

describe('lifetime', () => {
  it('disappears after three seconds if untouched, and says it expired (it is not consent)', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_000);
    h.playTo(12_750);
    expect(h.hides()).toHaveLength(0);
    h.playTo(13_000);
    expect(h.reasons()).toEqual(['expired']);
  });
  it('expiry only ever hides: the scheduler has no way to act on playback', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(20_000);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(h.scheduler)).filter((n) => /skip|mute|seek|play|choose|ignore/i.test(n))).toEqual([]);
    expect(h.events.map((e) => e.type)).toEqual(['show', 'hide']);
  });
  it('a configured duration is respected', () => {
    const h = new WarnHarness([grp('a', 60_000)], { ...SETTINGS, durationMs: 8_000 });
    h.playTo(40_000).playTo(47_750);
    expect(h.hides()).toHaveLength(0);
    h.playTo(48_000);
    expect(h.reasons()).toEqual(['expired']);
  });
  it('the user can dismiss it, and it is not shown again while the playhead stays in the window', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.scheduler.dismiss();
    expect(h.reasons()).toEqual(['dismissed']);
    h.playTo(25_000);
    expect(h.shows()).toHaveLength(1);
  });
  it('resolving (Skip or Ignore was pressed) hides it as handled, once', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.scheduler.resolve();
    h.scheduler.resolve();
    expect(h.reasons()).toEqual(['handled']);
  });
  it('hovering or focusing it holds the timer, and the remaining time resumes on release', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_000).playTo(11_000); // 1 s visible
    h.scheduler.hold();
    h.wait(60_000).tick();
    expect(h.hides()).toHaveLength(0); // held: still here a minute later
    expect(h.scheduler.msUntilNext()).toBeGreaterThanOrEqual(0);
    h.scheduler.release();
    h.wait(1_900).tick();
    expect(h.hides()).toHaveLength(0); // 2 s were left
    h.wait(200).tick();
    expect(h.reasons()).toEqual(['expired']);
  });
  it('disappears when the finding begins (it is about what is upcoming)', () => {
    const h = new WarnHarness([grp('a', 30_000)], { ...SETTINGS, durationMs: 8_000 });
    h.at(0).play();
    h.seek(27_000); // 3 s before the finding, 8 s lifetime
    h.playTo(30_000);
    expect(h.reasons()).toEqual(['started']);
  });
});

describe('pause, seek, replay, end', () => {
  it('a paused playhead gets no new warning; playing shows it', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.at(15_000);
    h.scheduler.handle('seeked');
    expect(h.shows()).toHaveLength(0);
    h.play();
    expect(h.shows()).toHaveLength(1);
  });
  it('a visible warning stays through a pause and expires on real time', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_000);
    h.pause();
    expect(h.hides()).toHaveLength(0);
    h.wait(3_100).tick();
    expect(h.reasons()).toEqual(['expired']);
  });
  it('seeking forward past the finding takes the warning away and shows nothing stale', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_000);
    h.seek(60_000);
    expect(h.reasons()).toEqual(['started']);
    expect(h.shows()).toHaveLength(1);
  });
  it('seeking forward past a finding that has not been warned about yet never warns', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.at(0).play();
    h.seek(60_000);
    h.playTo(70_000);
    expect(h.shows()).toHaveLength(0);
  });
  it('seeking out of the window (backward) takes the warning away and arms it again', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_000);
    h.seek(2_000);
    expect(h.reasons()).toEqual(['left']);
    h.playTo(10_000);
    expect(h.shows()).toHaveLength(2); // warned again when the window is entered again
  });
  it('seeking back to before the window after the warning ran its course warns again; seeking within the window does not', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(14_000); // shown at 10 000, expired at 13 000
    expect(h.shows()).toHaveLength(1);
    h.seek(12_000); // still inside the window
    h.playTo(16_000);
    expect(h.shows()).toHaveLength(1);
    h.seek(0); // left the window
    h.playTo(10_500);
    expect(h.shows()).toHaveLength(2);
  });
  it('replay after the end warns again, and the end removes a visible warning', () => {
    const h = new WarnHarness([grp('a', 30_000)], SETTINGS);
    h.durationMs = 40_000;
    h.playTo(10_500);
    h.end();
    expect(h.reasons()).toEqual(['ended']);
    h.seek(0);
    h.play();
    h.playTo(10_500);
    expect(h.shows()).toHaveLength(2);
  });
  it('no warning loop: a long uninterrupted watch shows each finding exactly once', () => {
    const h = new WarnHarness([grp('a', 30_000), grp('b', 90_000), grp('c', 200_000)]);
    h.durationMs = 300_000;
    h.playTo(250_000, 100);
    expect(h.shows().map((s) => s.warning.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('overlap, queue and duplicates', () => {
  it('shows one warning at a time; the next one waits, then appears after a short gap', () => {
    const h = new WarnHarness([grp('a', 30_000), grp('b', 33_000)]);
    h.playTo(13_000);
    expect(h.shows().map((s) => s.warning.id)).toEqual(['a']);
    expect(h.reasons()).toEqual(['expired']);
    h.playTo(13_250);
    expect(h.shows().map((s) => s.warning.id)).toEqual(['a']); // still inside the settle gap
    h.playTo(13_500);
    expect(h.shows().map((s) => s.warning.id)).toEqual(['a', 'b']);
  });
  it('a queued warning whose finding begins before its turn is dropped, never shown stale', () => {
    const h = new WarnHarness([grp('a', 30_000), grp('b', 30_300)]);
    h.at(0).play();
    h.seek(27_000); // a shows, 3 s before it begins
    h.playTo(31_000);
    expect(h.shows().map((s) => s.warning.id)).toEqual(['a']);
    expect(h.reasons()).toEqual(['started']);
  });
  it('a queued warning whose finding is still ahead after the gap is shown, and says how little time is left', () => {
    const h = new WarnHarness([grp('a', 30_000), grp('b', 36_000)]);
    h.at(0).play();
    h.seek(27_000);
    h.playTo(31_000);
    expect(h.shows().map((s) => s.warning.id)).toEqual(['a', 'b']);
    expect(h.shows()[1]!.warning.startsInMs).toBeLessThanOrEqual(6_000);
  });
  it('the same inputs again and again never produce a second warning (render churn)', () => {
    const groups = [grp('a', 30_000)];
    const h = new WarnHarness(groups);
    h.playTo(10_500);
    for (let i = 0; i < 20; i++) { h.scheduler.setInputs([grp('a', 30_000)], SETTINGS, true); h.scheduler.handle('timeupdate'); h.scheduler.handle('frame'); }
    expect(h.shows()).toHaveLength(1);
    expect(h.hides()).toHaveLength(0);
  });
  it('new analysis results keep the state of groups that are still there and drop those that are gone', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.scheduler.setInputs([grp('a', 30_000), grp('c', 80_000)], SETTINGS, true);
    expect(h.shows()).toHaveLength(1);
    h.scheduler.setInputs([grp('c', 80_000)], SETTINGS, true);
    expect(h.reasons()).toEqual(['removed']);
  });
});

describe('settings and master switch', () => {
  it('warnings disabled: nothing is shown, and a visible one is hidden when they are turned off', () => {
    const off = new WarnHarness([grp('a', 30_000)], { ...SETTINGS, enabled: false });
    off.playTo(25_000);
    expect(off.shows()).toHaveLength(0);
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.scheduler.setInputs([grp('a', 30_000)], { ...SETTINGS, enabled: false }, true);
    expect(h.reasons()).toEqual(['disabled']);
  });
  it('automatic actions off (the master switch) shows no warnings', () => {
    const h = new WarnHarness([grp('a', 30_000)], SETTINGS, false);
    h.playTo(25_000);
    expect(h.shows()).toHaveLength(0);
  });
  it('turning the master switch off while a warning is showing hides it', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.scheduler.setInputs([grp('a', 30_000)], SETTINGS, false);
    expect(h.reasons()).toEqual(['disabled']);
  });
});

describe('delayed or throttled timers', () => {
  it('a timer that fires late still expires the warning on the true clock, with one evaluation', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.wait(10_000).tick(); // a throttled background tab woke up 10 s later
    expect(h.reasons()).toEqual(['expired']);
  });
  it('a late wake-up after the playhead moved far ahead shows no stale warning', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.at(0).play();
    h.at(95_000).wait(60_000).tick();
    expect(h.shows()).toHaveLength(0);
  });
  it('a late wake-up inside the window shows it once, late, with the true time left', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.at(0).play();
    h.at(22_000).tick();
    expect(h.shows()).toHaveLength(1);
    expect(h.shows()[0]!.warning).toMatchObject({ startsInMs: 8_000, late: true });
  });
});

describe('msUntilNext (when to wake up)', () => {
  it('is the real time until the window opens, scaled by the playback rate', () => {
    const h = new WarnHarness([grp('a', 60_000)]);
    h.at(10_000);
    h.paused = false;
    expect(h.scheduler.msUntilNext()).toBe(30_000); // window opens at 40 000
    h.playbackRate = 2;
    expect(h.scheduler.msUntilNext()).toBe(15_000);
  });
  it('is the remaining lifetime while a warning shows, the nearer of expiry and the finding beginning', () => {
    const h = new WarnHarness([grp('a', 30_000)], { ...SETTINGS, durationMs: 8_000 });
    h.at(0).play();
    h.seek(27_000); // shown, 3 s before the finding, 8 s lifetime
    expect(h.scheduler.msUntilNext()).toBe(3_000);
  });
  it('is null when nothing is pending, when paused with nothing showing, and with warnings off', () => {
    expect(new WarnHarness([]).play().scheduler.msUntilNext()).toBeNull();
    const p = new WarnHarness([grp('a', 60_000)]).at(0);
    expect(p.scheduler.msUntilNext()).toBeNull();
    const off = new WarnHarness([grp('a', 60_000)], { ...SETTINGS, enabled: false }).at(0).play();
    expect(off.scheduler.msUntilNext()).toBeNull();
  });
});

describe('media replacement and cleanup', () => {
  it('dispose hides what is showing and later signals do nothing (a replaced video cannot be warned about)', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.playTo(10_500);
    h.scheduler.dispose();
    expect(h.reasons()).toEqual(['disposed']);
    h.playTo(25_000);
    h.scheduler.handle('seeked');
    expect(h.shows()).toHaveLength(1);
    expect(h.scheduler.msUntilNext()).toBeNull();
  });
  it('a non-finite playhead is ignored', () => {
    const h = new WarnHarness([grp('a', 30_000)]);
    h.timeMs = Number.NaN;
    expect(() => h.play()).not.toThrow();
    expect(h.shows()).toHaveLength(0);
  });
});

describe('settle gap', () => {
  it('is a fixed half second of real time and is part of when to wake up', () => {
    expect(WARNING_GAP_MS).toBe(500);
    const h = new WarnHarness([grp('a', 30_000), grp('b', 33_000)]);
    h.playTo(13_000);
    expect(h.scheduler.msUntilNext()).toBe(500);
  });
});
