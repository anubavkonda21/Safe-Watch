import { renderHook, act as rtlAct } from '@testing-library/react';
import { act as pa } from '@/test/playback';
import { grp, SETTINGS } from '@/test/warnings';
import { FakeYTPlayer } from '@/test/youtube';
import { usePlaybackCoordinator } from '@/features/playback/usePlaybackCoordinator';
import type { PlaybackSignal } from '@/domain/playback/coordinator';
import type { WarningEvent } from '@/domain/warnings/scheduler';
import { playerErrorKind, POLL_MS, YouTubeDriver } from './youtubeDriver';

beforeEach(() => { vi.useFakeTimers(); FakeYTPlayer.reset(); });
afterEach(() => { vi.useRealTimers(); });

const make = () => {
  const player = new FakeYTPlayer(document.createElement('div'), { videoId: 'dQw4w9WgXcQ' });
  const driver = new YouTubeDriver(player);
  return { player, driver };
};
/** Ready, and wired the way the player component wires it: the player's own events reach the driver. */
const ready = () => {
  const r = make();
  r.player.options.events = { onStateChange: (e) => r.driver.onStateChange(e.data), onPlaybackRateChange: () => r.driver.onPlaybackRateChange() };
  r.driver.onReady();
  return r;
};

describe('YouTubeDriver readings', () => {
  it('is neutral before the player is ready: position 0, paused, no duration, and commands are ignored', () => {
    const { player, driver } = make();
    player.time = 42; player.state = 1; player.duration = 100;
    expect(driver.surface.currentTimeMs).toBe(0);
    expect(driver.surface.paused).toBe(true);
    expect(driver.surface.durationMs).toBeNull();
    expect(driver.surface.playbackRate).toBe(1);
    expect(driver.surface.muted).toBe(false);
    driver.surface.muted = true; driver.surface.seekToMs(5000);
    expect(player.muteCalls).toEqual([]); expect(player.seeks).toEqual([]);
  });

  it('reads position in whole milliseconds, duration, rate and mute from the player', () => {
    const { player, driver } = ready();
    player.time = 12.3456; player.duration = 600.5; player.rate = 1.5; player.muted = true;
    expect(driver.surface.currentTimeMs).toBe(12346);
    expect(driver.surface.durationMs).toBe(600_500);
    expect(driver.surface.playbackRate).toBe(1.5);
    expect(driver.surface.muted).toBe(true);
  });

  it.each([[-1, true], [0, true], [1, false], [2, true], [3, true], [5, true]])('state %i → paused=%s (only PLAYING advances the playhead)', (state, paused) => {
    const { driver } = ready();
    driver.onStateChange(state);
    expect(driver.surface.paused).toBe(paused);
    expect(driver.isPlaying()).toBe(!paused);
  });

  it('treats nonsense readings as "unknown", never as a position', () => {
    const { player, driver } = ready();
    for (const bad of [NaN, -5, Infinity]) { player.time = bad; expect(driver.surface.currentTimeMs).toBe(0); }
    player.duration = 0; expect(driver.surface.durationMs).toBeNull(); // a live stream or unknown length
    player.duration = NaN; expect(driver.surface.durationMs).toBeNull();
    player.rate = 0; expect(driver.surface.playbackRate).toBe(1);
  });

  it('a player that throws (torn down) gives neutral readings and never an exception', () => {
    const { player, driver } = ready();
    player.throwOnRead = true;
    expect(driver.surface.currentTimeMs).toBe(0);
    expect(driver.surface.durationMs).toBeNull();
    expect(driver.surface.muted).toBe(false);
    expect(() => { driver.surface.muted = true; driver.surface.seekToMs(1000); }).not.toThrow();
  });
});

describe('YouTubeDriver commands (the only two it can send)', () => {
  it('mute() and unMute() through the documented methods; the volume is never touched', () => {
    const { player, driver } = ready();
    driver.surface.muted = true; driver.surface.muted = false;
    expect(player.muteCalls).toEqual(['mute', 'unMute']);
  });

  it('seekTo(seconds, true), clamped to [0, duration]', () => {
    const { player, driver } = ready();
    player.duration = 100;
    driver.surface.seekToMs(30_250); driver.surface.seekToMs(-5); driver.surface.seekToMs(500_000); driver.surface.seekToMs(NaN);
    expect(player.seeks).toEqual([[30.25, true], [0, true], [100, true]]);
  });

  it('after destroy nothing is sent and nothing is read', () => {
    const { player, driver } = ready();
    driver.destroy();
    driver.surface.muted = true; driver.surface.seekToMs(1000);
    expect(player.muteCalls).toEqual([]); expect(player.seeks).toEqual([]);
    expect(driver.surface.currentTimeMs).toBe(0);
  });
});

describe('YouTubeDriver signals', () => {
  const collect = (driver: YouTubeDriver) => { const got: PlaybackSignal[] = []; const off = driver.listen((s) => got.push(s)); return { got, off }; };

  it('maps player states to the signals the coordinator and scheduler already understand', () => {
    const { driver } = ready();
    const { got } = collect(driver);
    driver.onStateChange(1); driver.onStateChange(2); driver.onStateChange(3); driver.onStateChange(1); driver.onStateChange(0); driver.onStateChange(5); driver.onStateChange(-1);
    expect(got).toEqual(['play', 'pause', 'pause', 'play', 'ended', 'pause', 'pause']);
  });

  it('ignores a state that is not a number', () => {
    const { driver } = ready();
    const { got } = collect(driver);
    driver.onStateChange(undefined); driver.onStateChange('1' as never);
    expect(got).toEqual([]);
  });

  it('polls the position every 250 ms while someone listens, and stops when the last listener leaves', () => {
    const { driver } = ready();
    const { got, off } = collect(driver);
    vi.advanceTimersByTime(POLL_MS * 4);
    expect(got.filter((s) => s === 'timeupdate')).toHaveLength(4);
    off();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(POLL_MS * 4);
    expect(got.filter((s) => s === 'timeupdate')).toHaveLength(4);
  });

  it('does not poll before the player is ready', () => {
    const { driver } = make();
    const { got } = collect(driver);
    vi.advanceTimersByTime(POLL_MS * 4);
    expect(got).toEqual([]);
  });

  it('two listeners share one timer', () => {
    const { driver } = ready();
    const a = collect(driver); const b = collect(driver);
    expect(vi.getTimerCount()).toBe(1);
    a.off(); expect(vi.getTimerCount()).toBe(1);
    b.off(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a seek it was asked for as "seeked" once the playhead lands (the API has no such event)', () => {
    const { driver } = ready();
    const { got } = collect(driver);
    driver.surface.seekToMs(20_000);
    vi.advanceTimersByTime(POLL_MS);
    expect(got.filter((s) => s === 'seeked')).toHaveLength(1);
    vi.advanceTimersByTime(POLL_MS * 4);
    expect(got.filter((s) => s === 'seeked')).toHaveLength(1);
  });

  it('gives up waiting for a seek that never lands, and says "seeked" anyway so the coordinator can retry', () => {
    const { player, driver } = ready();
    const { got } = collect(driver);
    player.seekTo = () => undefined; // a player that ignores the seek
    driver.surface.seekToMs(20_000);
    vi.advanceTimersByTime(1000);
    expect(got).not.toContain('seeked');
    vi.advanceTimersByTime(1500);
    expect(got).toContain('seeked');
  });

  it('notices a mute change made by the user (through the player controls) and reports it', () => {
    const { player, driver } = ready();
    const { got } = collect(driver);
    player.muted = true; // the user pressed the speaker icon inside the player
    vi.advanceTimersByTime(POLL_MS);
    expect(got).toContain('volumechange');
    const before = got.length;
    vi.advanceTimersByTime(POLL_MS);
    expect(got.slice(before)).not.toContain('volumechange'); // reported once
  });

  it('a rate change triggers a re-evaluation', () => {
    const { driver } = ready();
    const { got } = collect(driver);
    driver.onPlaybackRateChange();
    expect(got).toEqual(['timeupdate']);
  });

  it('destroy removes every timer and listener', () => {
    const { driver } = ready();
    const { got } = collect(driver);
    driver.destroy();
    expect(vi.getTimerCount()).toBe(0);
    driver.onStateChange(1);
    expect(got).toEqual([]);
  });
});

describe('playerErrorKind (documented error codes)', () => {
  it.each([
    [2, 'invalid-parameter'], [5, 'html5-error'], [100, 'not-found-or-private'], [101, 'embedding-disabled'], [150, 'embedding-disabled'],
    [153, 'client-identification'], [0, 'unknown'], [999, 'unknown'], [undefined, 'unknown'],
  ] as const)('%s → %s', (code, kind) => { expect(playerErrorKind(code)).toBe(kind); });
});

describe('the existing coordinator and warning scheduler, driven by the YouTube driver', () => {
  /** The fake player advances by real (fake) time while PLAYING, at its playback rate, like the real one. */
  const sim = (player: FakeYTPlayer) => setInterval(() => { if (player.state === 1) player.time += 0.05 * player.rate; }, 50);
  const mount = (opts: { actions?: ReturnType<typeof pa>[]; groups?: ReturnType<typeof grp>[]; auto?: boolean; onWarning?: (e: WarningEvent) => void }) => {
    const { player, driver } = ready();
    const timer = sim(player);
    const events: string[] = [];
    const hook = renderHook(() => usePlaybackCoordinator({
      driver, sourceKey: 'a', actions: opts.actions ?? [], autoEnabled: opts.auto ?? true,
      onEvent: (e) => events.push(e.type), onFailure: () => events.push('FAILED'),
      warning: opts.groups ? { groups: opts.groups, settings: SETTINGS, onEvent: opts.onWarning ?? (() => undefined) } : undefined,
    }));
    const play = () => rtlAct(() => { player.fireState(1); });
    const advance = (ms: number) => rtlAct(() => { vi.advanceTimersByTime(ms); });
    return { player, driver, hook, events, play, advance, stop: () => clearInterval(timer) };
  };

  it('skip: playing into a skip span seeks once to its end', () => {
    const t = mount({ actions: [pa('a', 'skip', 10_000, 12_000)] });
    t.player.time = 8; t.play();
    t.advance(2500);
    expect(t.player.seeks).toEqual([[12, true]]);
    expect(t.events.filter((e) => e === 'skipped')).toHaveLength(1);
    t.advance(3000);
    expect(t.player.seeks).toHaveLength(1); // no loop
    t.hook.unmount(); t.stop();
  });

  it('mute: sound is muted from the start of the span to its end, and the user’s own mute state is restored', () => {
    const t = mount({ actions: [pa('m', 'mute', 5_000, 7_000)] });
    t.player.time = 3; t.play();
    t.advance(1900); expect(t.player.muted).toBe(false);
    t.advance(500); expect(t.player.muted).toBe(true); // inside [5 s, 7 s)
    t.advance(2000); expect(t.player.muted).toBe(false);
    expect(t.player.muteCalls).toEqual(['mute', 'unMute']);
    t.hook.unmount(); t.stop();
  });

  it('mute respects a user who had already muted the player (still muted afterwards)', () => {
    const t = mount({ actions: [pa('m', 'mute', 5_000, 7_000)] });
    t.player.muted = true; t.player.time = 3; t.play();
    t.advance(6000);
    expect(t.player.muted).toBe(true);
    t.hook.unmount(); t.stop();
  });

  it('unmounting while muted restores the sound', () => {
    const t = mount({ actions: [pa('m', 'mute', 5_000, 9_000)] });
    t.player.time = 5.5; t.play();
    t.advance(300);
    expect(t.player.muted).toBe(true);
    t.hook.unmount();
    expect(t.player.muted).toBe(false);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1); // only the test's own simulator remains
    t.stop();
  });

  it('warning: appears when the playhead is 20 s before the finding, and expires after 3 s without touching playback', () => {
    const events: WarningEvent[] = [];
    const t = mount({ groups: [grp('g', 30_000, 32_000)], onWarning: (e) => events.push(e) });
    t.player.time = 8; t.play();
    t.advance(1500); expect(events).toEqual([]); // 9.5 s: window opens at 10 s
    t.advance(1000);
    expect(events.map((e) => e.type)).toEqual(['show']);
    const shown = events[0] as Extract<WarningEvent, { type: 'show' }>;
    expect(shown.warning.startsInMs).toBeGreaterThan(19_000);
    expect(shown.warning.late).toBe(false);
    t.advance(3200);
    expect(events.map((e) => e.type)).toEqual(['show', 'hide']);
    expect((events[1] as Extract<WarningEvent, { type: 'hide' }>).reason).toBe('expired');
    expect(t.player.seeks).toEqual([]); expect(t.player.muteCalls).toEqual([]); expect(t.player.state).toBe(1);
    t.hook.unmount(); t.stop();
  });

  it('warning: not scheduled while the player is buffering or paused (the playhead is not advancing)', () => {
    const events: WarningEvent[] = [];
    const t = mount({ groups: [grp('g', 30_000)], onWarning: (e) => events.push(e) });
    t.player.time = 9.9; t.play();
    rtlAct(() => { t.player.fireState(3); }); // buffering
    t.advance(5000); expect(events).toEqual([]);
    rtlAct(() => { t.player.fireState(2); }); // paused
    t.advance(5000); expect(events).toEqual([]);
    t.hook.unmount(); t.stop();
  });

  it('warning: a seek into the window warns at once with the real time left, and a seek past the finding warns about nothing', () => {
    const events: WarningEvent[] = [];
    const t = mount({ groups: [grp('g', 30_000, 32_000)], onWarning: (e) => events.push(e) });
    t.player.time = 1; t.play(); t.advance(500);
    t.player.time = 22; t.advance(400); // the user jumped to 22 s: 8 s before the finding
    const first = events[0] as Extract<WarningEvent, { type: 'show' }>;
    expect(first.type).toBe('show');
    expect(first.warning.startsInMs).toBeLessThan(9000);
    t.player.time = 50; t.advance(600);
    expect(events.map((e) => e.type === 'hide' ? e.reason : e.type)).toEqual(['show', 'started']); // the finding began (we jumped past it): nothing stale is shown
    t.hook.unmount(); t.stop();
  });

  it('playback rate 2: the warning window opens twice as fast in real time', () => {
    const events: WarningEvent[] = [];
    const t = mount({ groups: [grp('g', 30_000)], onWarning: (e) => events.push(e) });
    t.player.time = 5; t.player.rate = 2; t.play();
    rtlAct(() => { t.player.fireRate(2); });
    t.advance(2600); // 5 s of media at 2x: playhead ~10.2 s
    expect(events.map((e) => e.type)).toEqual(['show']);
    t.hook.unmount(); t.stop();
  });

  it('a user seek into a skip span is respected (no trap), exactly as for a local file', () => {
    const t = mount({ actions: [pa('s', 'skip', 10_000, 20_000)] });
    t.player.time = 1; t.play(); t.advance(300);
    t.player.time = 12; // the user clicked inside the span
    t.advance(1500);
    expect(t.player.seeks).toEqual([]);
    expect(t.player.time).toBeGreaterThan(12);
    t.hook.unmount(); t.stop();
  });

  it('a new source key rebuilds everything: the old warning is disposed and the sound restored', () => {
    const events: WarningEvent[] = [];
    const { player, driver } = ready();
    const timer = sim(player);
    const hook = renderHook(({ key, actions }) => usePlaybackCoordinator({
      driver, sourceKey: key, actions, autoEnabled: true, onEvent: () => undefined, onFailure: () => undefined,
      warning: { groups: [grp('g', 12_000)], settings: SETTINGS, onEvent: (e) => events.push(e) },
    }), { initialProps: { key: 'a', actions: [pa('m', 'mute', 9_000, 40_000)] } });
    player.time = 10; rtlAct(() => { player.fireState(1); }); rtlAct(() => { vi.advanceTimersByTime(500); });
    expect(player.muted).toBe(true);
    hook.rerender({ key: 'b', actions: [] }); // a different video: nothing from the first one applies
    expect(player.muted).toBe(false);
    expect(events.some((e) => e.type === 'hide' && e.reason === 'disposed')).toBe(true);
    hook.unmount(); clearInterval(timer);
  });
});
