import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import { installFakeVideo, type FakeVideo } from '@/test/media';
import { analysisWith, finding } from '@/test/safetyFindings';
import { PlaybackPanel } from './PlaybackPanel';

beforeEach(() => {
  window.localStorage.clear(); preferencesStore.reload();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:warn-${n++}`); // every file gets its own URL, as in a real browser
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const FILE = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
const cue = (id: string, startMs: number, endMs: number, term: string, over = {}) => finding({
  id, startMs, endMs, warnings: ['coarse-timing'], attributes: { term, matchMode: 'word-boundary', matchedText: term.toLowerCase() },
  evidence: [{ evidenceId: `e-${id}`, modality: 'subtitle', kind: 'subtitle', startMs, endMs, sourceId: 'sub-0', contextEventId: null, sourceConfidence: null }], ...over,
});
const FIRST = cue('sf-flagged-terms-0000', 30_000, 32_000, 'Darn');
const ready = async (findings = [FIRST]): Promise<SafetyLoad> => ({ state: 'ready', analysis: await analysisWith(findings) });
const warnCard = () => screen.queryByRole('group', { name: 'Upcoming flagged phrase' });
const status = () => screen.getByRole('status', { name: '' });
const select = (re: RegExp) => screen.getByRole('combobox', { name: re });

async function mount(safety: SafetyLoad, file: File | null = FILE) {
  const utils = render(<PlaybackPanel file={file} mediaId="m" safety={safety} />);
  const video = screen.getByLabelText('Uploaded video preview') as HTMLVideoElement;
  const fake: FakeVideo = installFakeVideo(video, 120);
  await act(async () => { fake.loaded(); });
  return { ...utils, fake };
}
/** Natural playback: the playhead moves and the same amount of real (fake) time passes, as it does for a viewer. */
const watch = async (fake: FakeVideo, to: number, stepMs = 250) => {
  await act(async () => {
    if (fake.el.paused) fake.play();
    while (fake.time() < to - 1e-9) {
      const next = Math.min(to, fake.time() + stepMs / 1000);
      await fake.advanceTo(next, stepMs);
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  });
};
/** Real time passing (a timer firing) while the playhead stays where it is. */
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('the heads-up appears 20 seconds ahead, once, with honest wording', () => {
  it('stays quiet before the window and appears when the playhead is 20 s from the finding, saying what is coming and when', async () => {
    const { fake } = await mount(await ready());
    expect(warnCard()).not.toBeInTheDocument();
    await watch(fake, 9.5);
    expect(warnCard()).not.toBeInTheDocument();
    await watch(fake, 10);
    const card = warnCard()!;
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('A flagged phrase is coming up.');
    expect(card).toHaveTextContent('“Darn”');
    expect(card).toHaveTextContent('Starts in about 20 seconds.');
    expect(within(card).getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Ignore' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Dismiss warning' })).toBeInTheDocument();
  });
  it('is information, not a verdict: no confidence, no score, no safety judgement', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    const text = warnCard()!.textContent!;
    expect(text).not.toMatch(/\d+%|confidence|score|unsafe|dangerous|verdict|\brisk\b/i);
  });
  it('an uncertain finding is described as possible', async () => {
    const { fake } = await mount(await ready([cue('sf-flagged-terms-0000', 30_000, 32_000, 'Darn', { status: 'uncertain', warnings: ['coarse-timing', 'low-source-confidence'] })]));
    await watch(fake, 10);
    expect(warnCard()).toHaveTextContent('A possible flagged phrase is coming up.');
  });
  it('findings that overlap or touch are one warning that says how many', async () => {
    const { fake } = await mount(await ready([cue('sf-flagged-terms-0000', 30_000, 32_000, 'Darn'), cue('sf-flagged-terms-0001', 31_000, 33_000, 'Heck'), cue('sf-flagged-terms-0002', 33_000, 34_000, 'Gosh')]));
    await watch(fake, 10);
    expect(warnCard()).toHaveTextContent('3 flagged phrases are coming up.');
    expect(warnCard()).toHaveTextContent('“Darn”, “Heck” and 1 more');
    expect(screen.getAllByRole('group', { name: 'Upcoming flagged phrase' })).toHaveLength(1);
  });
  it('a finding closer than 20 s (a seek into the window) is shown at once with the real time left', async () => {
    const { fake } = await mount(await ready());
    fake.play();
    await act(async () => { await fake.userSeek(24); });
    expect(warnCard()).toHaveTextContent('Starts in about 6 seconds.');
  });
  it('is announced once in the status line, not on every update', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    const first = status().textContent;
    expect(first).toBe('A flagged phrase is coming up. “Darn” Starts in about 20 seconds.');
    await watch(fake, 11);
    expect(status().textContent).toBe(first);
  });
});

describe('nothing is warned about that cannot be acted on', () => {
  it('no warning and no reserved space for unavailable, zero-length, out-of-range and unsupported findings', async () => {
    const { fake, container } = await mount(await ready([cue('sf-flagged-terms-0000', 5_000, 5_000, 'Zero'), cue('sf-flagged-terms-0001', 200_000, 201_000, 'Outside'), finding({ id: 'sf-flagged-terms-0002', category: 'violence' as never, startMs: 30_000, endMs: 31_000 })]));
    await watch(fake, 30);
    expect(warnCard()).not.toBeInTheDocument();
    expect(container.querySelector('.sw-warnslot')).toBeNull();
  });
  it('no warning for a finding the user ignored, and none for a finding that has begun', async () => {
    const first = await mount(await ready());
    const { fake } = first;
    const unmountFirst = () => first.unmount();
    fireEvent.change(select(/Action for the finding at 0:30\.00/), { target: { value: 'ignore' } });
    await watch(fake, 12);
    expect(warnCard()).not.toBeInTheDocument();
    unmountFirst();
    const other = await mount(await ready());
    other.fake.play();
    await act(async () => { await other.fake.userSeek(31); });
    expect(screen.queryAllByRole('group', { name: 'Upcoming flagged phrase' })).toHaveLength(0);
  });
  it('no warning while the analysis is pending or unavailable', async () => {
    const { rerender } = render(<PlaybackPanel file={FILE} mediaId="m" safety={{ state: 'loading' }} />);
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).not.toBeInTheDocument();
    rerender(<PlaybackPanel file={FILE} mediaId="m" safety={{ state: 'unavailable' }} />);
    expect(document.querySelector('.sw-warnslot')).toBeNull();
  });
});

describe('the three-second lifetime', () => {
  it('goes away by itself after 3 seconds and does NOT act: no skip, no mute, the choice stays unset', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    expect(warnCard()).toBeInTheDocument();
    await pass(2_500);
    expect(warnCard()).toBeInTheDocument();
    await pass(600);
    expect(warnCard()).not.toBeInTheDocument();
    expect(fake.seeks).toEqual([]);
    expect(fake.muted()).toBe(false);
    expect(select(/Action for the finding at 0:30\.00/)).toHaveValue('none');
    await watch(fake, 40); // playback continues normally, even through the finding itself
    expect(fake.seeks).toEqual([]);
    expect(fake.muted()).toBe(false);
  });
  it('the lifetime follows the preference', async () => {
    preferencesStore.update({ durationSeconds: 8 });
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    await pass(7_000);
    expect(warnCard()).toBeInTheDocument();
    await pass(1_200);
    expect(warnCard()).not.toBeInTheDocument();
  });
  it('shows a lifetime indicator sized to that duration, hidden from assistive technology', async () => {
    const { fake, container } = await mount(await ready());
    await watch(fake, 10);
    const bar = container.querySelector('.sw-warn__bar') as HTMLElement;
    expect(bar.style.animationDuration).toBe('3000ms');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
  });
  it('is held while the pointer or focus is on it, and resumes with the remaining time', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    await pass(1_000);
    fireEvent.mouseEnter(warnCard()!);
    await pass(30_000);
    expect(warnCard()).toBeInTheDocument();
    fireEvent.mouseLeave(warnCard()!);
    await pass(1_500);
    expect(warnCard()).toBeInTheDocument();
    await pass(800);
    expect(warnCard()).not.toBeInTheDocument();
  });
  it('keyboard focus on a button holds it too, and leaving the card lets it go', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    const skip = within(warnCard()!).getByRole('button', { name: 'Skip' });
    fireEvent.focus(skip);
    await pass(30_000);
    expect(warnCard()).toBeInTheDocument();
    fireEvent.blur(skip, { relatedTarget: document.body });
    await pass(3_100);
    expect(warnCard()).not.toBeInTheDocument();
  });
  it('a throttled background tab that wakes up late still takes it away on the true clock', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    // The tab was throttled: ten real seconds pass with no timer firing, then it becomes visible again.
    vi.setSystemTime(Date.now() + 10_000);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(warnCard()).not.toBeInTheDocument();
  });
});

describe('Skip and Ignore are the CP8 choices, applied once', () => {
  it('Skip sets the existing skip choice for that finding, removes the warning, and the CP8 skip then jumps to the interval end exactly once', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    fireEvent.click(within(warnCard()!).getByRole('button', { name: 'Skip' }));
    expect(warnCard()).not.toBeInTheDocument();
    expect(select(/Action for the finding at 0:30\.00/)).toHaveValue('skip');
    expect(status().textContent).toContain('Set to skip');
    expect(fake.seeks).toEqual([]); // choosing is not skipping: nothing jumps yet
    await watch(fake, 31);
    expect(fake.seeks).toEqual([32]); // the interval end, once
    await watch(fake, 40);
    expect(fake.seeks).toEqual([32]);
  });
  it('Ignore sets the existing ignore choice, removes the warning and never re-prompts, not even after seeking back', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    fireEvent.click(within(warnCard()!).getByRole('button', { name: 'Ignore' }));
    expect(select(/Action for the finding at 0:30\.00/)).toHaveValue('ignore');
    expect(warnCard()).not.toBeInTheDocument();
    await act(async () => { await fake.userSeek(2); });
    await watch(fake, 20);
    expect(warnCard()).not.toBeInTheDocument();
    await watch(fake, 40);
    expect(fake.seeks).toEqual([]);
    expect(fake.muted()).toBe(false);
  });
  it('Undo ignore in the list brings the warning back for the next pass', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    fireEvent.click(within(warnCard()!).getByRole('button', { name: 'Ignore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo ignore' }));
    await act(async () => { await fake.userSeek(2); });
    await watch(fake, 11);
    expect(warnCard()).toBeInTheDocument();
  });
  it('shows the current choice when the user already set one (mute), and Skip replaces it', async () => {
    const { fake } = await mount(await ready());
    fireEvent.change(select(/Action for the finding at 0:30\.00/), { target: { value: 'mute' } });
    await watch(fake, 10);
    expect(warnCard()).toHaveTextContent('Currently set to mute.');
    fireEvent.click(within(warnCard()!).getByRole('button', { name: 'Skip' }));
    expect(select(/Action for the finding at 0:30\.00/)).toHaveValue('skip');
  });
  it('Skip on a group of findings sets skip for every finding in it', async () => {
    const { fake } = await mount(await ready([cue('sf-flagged-terms-0000', 30_000, 32_000, 'Darn'), cue('sf-flagged-terms-0001', 31_000, 33_000, 'Heck')]));
    await watch(fake, 10);
    fireEvent.click(within(warnCard()!).getByRole('button', { name: 'Skip' }));
    expect(screen.getAllByRole('combobox', { name: /Action for the finding/ }).map((s) => (s as HTMLSelectElement).value)).toEqual(['skip', 'skip']);
  });
  it('Dismiss and Escape only close it: nothing is chosen', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    fireEvent.click(within(warnCard()!).getByRole('button', { name: 'Dismiss warning' }));
    expect(warnCard()).not.toBeInTheDocument();
    expect(select(/Action for the finding at 0:30\.00/)).toHaveValue('none');
    await act(async () => { await fake.userSeek(2); });
    await watch(fake, 11);
    expect(warnCard()).toBeInTheDocument();
    fireEvent.keyDown(within(warnCard()!).getByRole('button', { name: 'Skip' }), { key: 'Escape' });
    expect(warnCard()).not.toBeInTheDocument();
    expect(select(/Action for the finding at 0:30\.00/)).toHaveValue('none');
  });
  it('never takes keyboard focus from the player or the page when it appears', async () => {
    const { fake } = await mount(await ready());
    const before = document.activeElement;
    await watch(fake, 10);
    expect(document.activeElement).toBe(before);
  });
});

describe('seek, pause, replay, end, media replacement', () => {
  it('pausing keeps a visible warning until its time is up; a paused seek warns once playing resumes', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    fake.pause();
    expect(warnCard()).toBeInTheDocument();
    await pass(3_200);
    expect(warnCard()).not.toBeInTheDocument();
    await act(async () => { await fake.userSeek(2); });
    fake.tick(15);
    expect(warnCard()).not.toBeInTheDocument();
    await act(async () => { fake.play(); });
    await pass(600); // the half-second gap since the previous warning went away
    expect(warnCard()).toBeInTheDocument();
  });
  it('seeking forward past the finding removes the warning; seeking backward re-arms it', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    await act(async () => { await fake.userSeek(60); });
    expect(warnCard()).not.toBeInTheDocument();
    await act(async () => { await fake.userSeek(2); });
    await watch(fake, 10);
    expect(warnCard()).toBeInTheDocument();
  });
  it('the end of the video removes a warning, and a replay warns again exactly once', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    await act(async () => { fake.end(); });
    expect(warnCard()).not.toBeInTheDocument();
    await act(async () => { await fake.userSeek(0); });
    await watch(fake, 12);
    expect(screen.getAllByRole('group', { name: 'Upcoming flagged phrase' })).toHaveLength(1);
    await watch(fake, 25);
    expect(screen.queryAllByRole('group', { name: 'Upcoming flagged phrase' }).length).toBeLessThanOrEqual(1);
  });
  it('queued findings come one at a time, with a short gap, never stacked', async () => {
    const { fake } = await mount(await ready([cue('sf-flagged-terms-0000', 30_000, 30_500, 'Darn'), cue('sf-flagged-terms-0001', 31_000, 32_000, 'Heck')]));
    const seen: Array<string | null> = [];
    for (let t = 9.5; t <= 17; t += 0.25) {
      await watch(fake, t);
      expect(screen.queryAllByRole('group', { name: 'Upcoming flagged phrase' }).length).toBeLessThanOrEqual(1); // never stacked
      const card = warnCard();
      seen.push(card ? (card.textContent!.includes('“Darn”') ? 'darn' : 'heck') : null);
    }
    const sequence = seen.filter((v, i) => i === 0 || v !== seen[i - 1]);
    expect(sequence).toEqual([null, 'darn', null, 'heck', null]); // each shown alone, a visible pause between them, both lifetimes respected
  });
  it('replacing the video removes any warning, and the new video is warned about from its own start', async () => {
    const { fake, rerender } = await mount(await ready());
    await watch(fake, 10);
    expect(warnCard()).toBeInTheDocument();
    fake.pause();
    fake.tick(0); // a new file starts at 0 and paused
    rerender(<PlaybackPanel file={new File(['y'], 'other.mp4')} mediaId="m" safety={await ready()} />);
    expect(warnCard()).not.toBeInTheDocument();
    await watch(fake, 9.5);
    expect(warnCard()).not.toBeInTheDocument();
    await watch(fake, 10);
    expect(screen.getAllByRole('group', { name: 'Upcoming flagged phrase' })).toHaveLength(1);
  });
  it('unmounting leaves no timer behind', async () => {
    const { fake, unmount } = await mount(await ready());
    await watch(fake, 10);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('settings and the master switch', () => {
  it('warnings switched off in the preferences: no warning and no reserved space', async () => {
    preferencesStore.update({ warningsEnabled: false });
    const { fake, container } = await mount(await ready());
    await watch(fake, 15);
    expect(warnCard()).not.toBeInTheDocument();
    expect(container.querySelector('.sw-warnslot')).toBeNull();
  });
  it('turning warnings off while one is showing removes it', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    await act(async () => { preferencesStore.update({ warningsEnabled: false }); });
    expect(warnCard()).not.toBeInTheDocument();
  });
  it('automatic actions off (the master switch): no warning', async () => {
    const { fake } = await mount(await ready());
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic actions' }));
    await watch(fake, 15);
    expect(warnCard()).not.toBeInTheDocument();
  });
  it('a different lead time from the preferences is honoured', async () => {
    preferencesStore.update({ leadSeconds: 10 });
    const { fake } = await mount(await ready());
    await watch(fake, 19.5);
    expect(warnCard()).not.toBeInTheDocument();
    await watch(fake, 20);
    expect(warnCard()).toHaveTextContent('Starts in about 10 seconds.');
  });
  it('the space for the heads-up is reserved: the same slot holds the hint and the warning, so nothing jumps', async () => {
    const { fake, container } = await mount(await ready());
    const slot = container.querySelector('.sw-warnslot')!;
    expect(slot).toHaveTextContent('A heads-up appears here 20 seconds before a flagged phrase.');
    await watch(fake, 10);
    expect(container.querySelector('.sw-warnslot')).toBe(slot);
    expect(slot).toContainElement(warnCard()!);
    expect(slot.previousElementSibling).toBe(screen.getByLabelText('Uploaded video preview')); // directly under the player, so keyboard order follows the video controls
  });
  it('a failure inside the scheduler removes warnings and stops automatic actions without touching playback', async () => {
    const { fake } = await mount(await ready());
    await watch(fake, 10);
    const { WarningScheduler } = await import('@/domain/warnings/scheduler');
    vi.spyOn(WarningScheduler.prototype, 'handle').mockImplementation(() => { throw new Error('boom'); });
    await watch(fake, 11);
    expect(warnCard()).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Automatic actions' })).toBeDisabled();
    expect(status().textContent).toBe('Automatic actions stopped because of an error. Playback and your sound are not affected.');
  });
});
