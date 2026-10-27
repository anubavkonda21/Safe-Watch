import { act, fireEvent, render, screen } from '@testing-library/react';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import { drag } from '@/test/pointer';
import { installFakeVideo, type FakeVideo } from '@/test/media';
import { analysisWith, finding } from '@/test/safetyFindings';
import { PlaybackPanel } from './PlaybackPanel';

beforeEach(() => {
  window.localStorage.clear(); preferencesStore.reload();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:skip-${n++}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const FILE = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
const cue = (id: string, startMs: number, endMs: number, term = 'Darn') => finding({
  id, startMs, endMs, warnings: ['coarse-timing'], attributes: { term, matchMode: 'word-boundary', matchedText: term.toLowerCase() },
  evidence: [{ evidenceId: `e-${id}`, modality: 'subtitle', kind: 'subtitle', startMs, endMs, sourceId: 'sub-0', contextEventId: null, sourceConfidence: null }],
});
const ready = async (...f: ReturnType<typeof cue>[]): Promise<SafetyLoad> => ({ state: 'ready', analysis: await analysisWith(f) });
const btn = () => screen.getByRole('button', { name: 'Skip forward 10 seconds' });
const warnCard = () => screen.queryByRole('group', { name: 'Upcoming flagged phrase' });

async function mount(safety: SafetyLoad, file: File | null = FILE, duration = 120) {
  const utils = render(<PlaybackPanel file={file} mediaId="m" safety={safety} />);
  const video = file ? (screen.getByLabelText('Uploaded video preview') as HTMLVideoElement) : null;
  const fake: FakeVideo | null = video ? installFakeVideo(video, duration) : null;
  if (fake) await act(async () => { fake.loaded(); });
  return { ...utils, fake: fake! };
}
const click = async () => { await act(async () => { fireEvent.click(btn()); await vi.advanceTimersByTimeAsync(0); }); };
const watch = async (fake: FakeVideo, to: number, stepMs = 250) => {
  await act(async () => {
    if (fake.el.paused) fake.play();
    while (fake.time() < to - 1e-9) { const next = Math.min(to, fake.time() + stepMs / 1000); await fake.advanceTo(next, stepMs); await vi.advanceTimersByTimeAsync(stepMs); }
  });
};

describe('the +10 s button on a local video', () => {
  it('is a real, named button right under the player, 10 seconds ahead, and says what it does', async () => {
    const { container } = await mount(await ready());
    expect(btn()).toHaveTextContent('+10 s');
    expect(btn()).toBeEnabled();
    expect(btn().closest('.sw-pseek')!.previousElementSibling).toBe(screen.getByLabelText('Uploaded video preview'));
    expect(container.querySelector('.sw-pseek')).toBeInTheDocument();
  });

  it('moves the playhead exactly ten seconds forward, from wherever it is, and announces the new position', async () => {
    const { fake } = await mount(await ready());
    fake.tick(5);
    await click();
    expect(fake.seeks).toEqual([15]);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Skipped forward 10 seconds, to 0:15.');
    fake.tick(15.5);
    await click();
    expect(fake.seeks).toEqual([15, 25.5]);
  });

  it('works while paused (it stays paused) and while playing (it keeps playing)', async () => {
    const { fake } = await mount(await ready());
    fake.tick(3); await click();
    expect(fake.el.paused).toBe(true);
    await watch(fake, 14);
    await click();
    expect(fake.el.paused).toBe(false);
    expect(fake.time()).toBeCloseTo(24, 1);
  });

  it('repeated presses add up without drift', async () => {
    const { fake } = await mount(await ready());
    for (let i = 0; i < 3; i++) await click();
    expect(fake.seeks).toEqual([10, 20, 30]);
  });

  it('never goes past the end, and at the end it says so and does not seek', async () => {
    const { fake } = await mount(await ready(), FILE, 120);
    fake.tick(115); await click();
    expect(fake.seeks).toEqual([120]);
    fake.tick(120); await click();
    expect(fake.seeks).toEqual([120]);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Already at the end of the video.');
  });

  it('never moves backward', async () => {
    const { fake } = await mount(await ready(), FILE, 120);
    fake.tick(130); await click();
    expect(fake.seeks).toEqual([]);
  });

  it('is disabled, with the reason, when there is no player (the file is no longer available)', async () => {
    await mount(await ready(), null);
    expect(btn()).toBeDisabled();
    expect(screen.getByText('Available once the player is ready.')).toBeInTheDocument();
  });

  it('is disabled when the browser cannot play the file', async () => {
    const { fake } = await mount(await ready());
    await act(async () => { fake.fail(); });
    expect(btn()).toBeDisabled();
  });

  it('is the viewer’s own seek: landing inside a skip span is respected, nothing skips the viewer out of it, nothing loops', async () => {
    const { fake } = await mount(await ready(cue('sf-flagged-terms-0000', 30_000, 40_000)));
    fireEvent.change(screen.getByRole('combobox', { name: /Action for the finding at 0:30/ }), { target: { value: 'skip' } });
    fake.tick(25); await click(); // lands at 35, inside the span
    expect(fake.seeks).toEqual([35]);
    await watch(fake, 38);
    expect(fake.seeks).toEqual([35]); // no automatic skip to 40: the viewer placed themselves there
  });

  it('jumping over a finding with +10 s means the finding is passed: no automatic skip and no stale warning', async () => {
    const { fake } = await mount(await ready(cue('sf-flagged-terms-0000', 30_000, 32_000)));
    fireEvent.change(screen.getByRole('combobox', { name: /Action for the finding at 0:30/ }), { target: { value: 'skip' } });
    await watch(fake, 12);
    expect(warnCard()).toBeInTheDocument();
    fake.tick(26); await click(); // 36: past the finding
    await watch(fake, 36.5);
    expect(warnCard()).not.toBeInTheDocument();
    expect(fake.seeks).toEqual([36]);
  });

  it('while a warning is showing, +10 s does not dismiss it, answer it, or choose an action for the finding', async () => {
    const { fake } = await mount(await ready(cue('sf-flagged-terms-0000', 60_000, 62_000)));
    await watch(fake, 41);
    expect(warnCard()).toBeInTheDocument();
    await click();
    expect(warnCard()).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Action for the finding at 1:00/ })).toHaveValue('none');
  });

  it('it does not change mute: a muted span the viewer jumps out of restores the sound', async () => {
    const { fake } = await mount(await ready(cue('sf-flagged-terms-0000', 30_000, 40_000)));
    fireEvent.change(screen.getByRole('combobox', { name: /Action for the finding at 0:30/ }), { target: { value: 'mute' } });
    await watch(fake, 31);
    expect(fake.muted()).toBe(true);
    await click(); // 41, past the span
    await watch(fake, 41.5);
    expect(fake.muted()).toBe(false);
  });
});

describe('swipe-to-dismiss inside the playback panel', () => {
  async function withWarning() {
    const m = await mount(await ready(cue('sf-flagged-terms-0000', 30_000, 32_000)));
    await watch(m.fake, 11);
    const card = warnCard()!;
    card.getBoundingClientRect = () => ({ width: 288, height: 120, top: 0, left: 0, right: 288, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
    return { ...m, card };
  }

  it('swiping the warning away removes it; playback, the finding’s choice and the sound are untouched', async () => {
    const { fake, card } = await withWarning();
    const before = fake.time();
    await act(async () => { drag(card, [220, 60], [60, 62]); });
    expect(warnCard()).not.toBeInTheDocument();
    expect(fake.el.paused).toBe(false);
    expect(fake.time()).toBe(before);
    expect(fake.seeks).toEqual([]);
    expect(fake.muted()).toBe(false);
    expect(screen.getByRole('combobox', { name: /Action for the finding at 0:30/ })).toHaveValue('none');
  });

  it('a dismissed warning does not come back for the same finding while playback continues', async () => {
    const { fake, card } = await withWarning();
    await act(async () => { drag(card, [60, 60], [230, 60]); });
    await watch(fake, 20);
    expect(warnCard()).not.toBeInTheDocument();
  });

  it('a swipe that is too short leaves the warning in place', async () => {
    const { card } = await withWarning();
    await act(async () => { drag(card, [200, 60], [170, 60]); });
    expect(warnCard()).toBeInTheDocument();
  });
});
