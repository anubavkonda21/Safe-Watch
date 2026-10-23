import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { PlaybackCoordinator } from '@/domain/playback/coordinator';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import { installFakeVideo, type FakeVideo } from '@/test/media';
import { analysisWith, finding } from '@/test/safetyFindings';
import { PlaybackPanel } from './PlaybackPanel';

const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  // The default action and the warning settings are remembered in this browser: every test starts from a clean store.
  window.localStorage.clear(); preferencesStore.reload();
  created.length = 0; revoked.length = 0;
  URL.createObjectURL = vi.fn(() => { const u = `blob:test-${created.length}`; created.push(u); return u; });
  URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); }); // fake timers never leak into the next test, even if a test fails

const FILE = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
const two = [finding({ id: 'sf-flagged-terms-0000', startMs: 10_000, endMs: 11_000, warnings: ['coarse-timing'], evidence: [{ evidenceId: 'e', modality: 'subtitle', kind: 'subtitle', startMs: 10_000, endMs: 11_000, sourceId: 'sub-0', contextEventId: null, sourceConfidence: null }] }), finding({ id: 'sf-flagged-terms-0001', startMs: 20_000, endMs: 21_000, warnings: ['coarse-timing'], evidence: [{ evidenceId: 'e2', modality: 'subtitle', kind: 'subtitle', startMs: 20_000, endMs: 21_000, sourceId: 'sub-0', contextEventId: null, sourceConfidence: null }], attributes: { term: 'Heck', matchMode: 'word-boundary', matchedText: 'heck' } })];
const ready = async (findings = two, status: 'ready' | 'partial' | 'not-evaluated' = 'ready'): Promise<SafetyLoad> => ({ state: 'ready', analysis: await analysisWith(findings, status) });
const panel = () => screen.getByRole('region', { name: 'Playback' });

async function mount(safety: SafetyLoad, file: File | null = FILE) {
  const utils = render(<PlaybackPanel file={file} mediaId="m" safety={safety} />);
  let fake: FakeVideo | null = null;
  const video = screen.queryByLabelText('Uploaded video preview') as HTMLVideoElement | null;
  if (video) { fake = installFakeVideo(video, 60); await act(async () => { fake!.loaded(); }); }
  return { ...utils, fake: fake as FakeVideo };
}
const select = (name: RegExp) => screen.getByRole('combobox', { name });
const play = async (fake: FakeVideo, to: number) => { await act(async () => { await fake.advanceTo(to); }); };

describe('PlaybackPanel: the real player', () => {
  it('plays the user’s own file through an object URL (no server, no path) and releases the URL afterwards', async () => {
    const { unmount } = await mount(await ready());
    const video = screen.getByLabelText('Uploaded video preview') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(video.getAttribute('src')).toBe('blob:test-0');
    expect(URL.createObjectURL).toHaveBeenCalledWith(FILE);
    unmount();
    expect(revoked).toContain('blob:test-0');
  });
  it('without the file it says so honestly and shows no player', async () => {
    await mount(await ready(), null);
    expect(screen.queryByLabelText('Uploaded video preview')).not.toBeInTheDocument();
    expect(panel()).toHaveTextContent('The video cannot be played here');
  });
  it('a file the browser cannot play is reported, and nothing pretends to play', async () => {
    const { fake } = await mount(await ready());
    await act(async () => { fake.fail(); });
    expect(screen.getByRole('alert')).toHaveTextContent('This browser could not play this file');
    expect(screen.getAllByRole('button', { name: 'Play from just before' })[0]).toBeDisabled();
  });
});

describe('PlaybackPanel: what the user sees before choosing', () => {
  it('lists the real findings with time, term, status, timing precision, and does nothing until the user chooses', async () => {
    const { fake } = await mount(await ready());
    const rows = within(screen.getByRole('list', { name: 'Findings and actions' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('0:10.00 to 0:11.00');
    expect(rows[0]).toHaveTextContent('“Darn”');
    expect(rows[0]).toHaveTextContent('Detected');
    expect(rows[0]).toHaveTextContent('Subtitle cue, exact line');
    expect(within(rows[0]!).getByTestId('action-state')).toHaveTextContent('No action');
    await play(fake, 25);
    expect(fake.muted()).toBe(false);
    expect(fake.seeks).toEqual([]);
  });
  it('explains the interval: the finding’s own times, the action interval and how it was set', async () => {
    await mount(await ready([finding({ startMs: 10_000, endMs: 10_500 })]));
    await userEvent.click(screen.getByText('Why and how the interval was set'));
    const details = panel();
    expect(details).toHaveTextContent('Finding interval 0:10.00 to 0:10.50. Action interval 0:09.85 to 0:10.75.');
    expect(details).toHaveTextContent('Speech word timing: the start is aligned (about 0.1 s), the end is approximate. A margin is added. Not sample accurate.');
  });
  it('says what is going on when there is nothing to act on: pending, unavailable, nothing evaluated, no findings, partial', async () => {
    const { unmount } = await mount({ state: 'loading' });
    expect(panel()).toHaveTextContent('Waiting for the safety analysis. Nothing is acted on until it arrives.');
    unmount();
    const u2 = await mount({ state: 'unavailable' });
    expect(panel()).toHaveTextContent('Safety findings are not available, so there is nothing to act on. Playback is not affected.');
    u2.unmount();
    const u3 = await mount(await ready([], 'not-evaluated'));
    expect(panel()).toHaveTextContent('Nothing was evaluated, so there are no findings to act on.');
    u3.unmount();
    const u4 = await mount(await ready([]));
    expect(panel()).toHaveTextContent('No findings, so there are no automatic actions.');
    u4.unmount();
    await mount(await ready(two, 'partial'));
    expect(panel()).toHaveTextContent('The analysis is partial');
  });
  it('findings with unusable timing are listed as unavailable with the reason, and cannot be given an action', async () => {
    await mount(await ready([finding({ startMs: 5000, endMs: 5000 }), finding({ id: 'sf-flagged-terms-0001', startMs: 80_000, endMs: 81_000 })]));
    const rows = within(screen.getByRole('list', { name: 'Findings and actions' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('the finding has no duration');
    expect(rows[1]).toHaveTextContent('the finding lies outside this video');
    expect(screen.queryAllByRole('combobox', { name: /Action for the finding/ })).toHaveLength(0);
    expect(panel()).toHaveTextContent('No finding can be acted on automatically.');
  });
  it('an uncertain finding is never acted on unless the user chooses', async () => {
    const { fake } = await mount(await ready([finding({ status: 'uncertain', warnings: ['low-source-confidence'], startMs: 10_000, endMs: 11_000 })]));
    expect(panel()).toHaveTextContent('This finding is uncertain, so it is never acted on unless you choose an action for it.');
    await play(fake, 12);
    expect(fake.muted()).toBe(false);
  });
});

describe('PlaybackPanel: mute', () => {
  it('mutes only inside the interval, restores the sound after it, and announces both', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    expect(within(screen.getAllByRole('listitem')[0]!).getByTestId('action-state')).toHaveTextContent('Will mute this part');
    await play(fake, 9.5);
    expect(fake.muted()).toBe(false);
    await play(fake, 10.5);
    expect(fake.muted()).toBe(true);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Muted at 0:10.00: flagged term “Darn”.');
    await play(fake, 11.5);
    expect(fake.muted()).toBe(false);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Sound restored at');
    expect(fake.seeks).toEqual([]);
  });
  it('does not mute anything else in the video (the second finding stays untouched)', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    await play(fake, 20.5);
    expect(fake.muted()).toBe(false);
  });
  it('a user who unmutes during a muted part is respected', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    await play(fake, 10.5);
    expect(fake.muted()).toBe(true);
    await act(async () => { fake.userMute(false); });
    expect(fake.muted()).toBe(false);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('You turned the sound back on');
    await play(fake, 10.9);
    expect(fake.muted()).toBe(false);
  });
});

describe('PlaybackPanel: boundaries do not depend on player events or animation frames', () => {
  it('mutes at the boundary and restores after it from a timer alone (no timeupdate, no frame), so throttled tabs stay accurate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { fake } = await mount(await ready());
      fireEvent.change(select(/0:10\.00 to 0:11\.00/), { target: { value: 'mute' } });
      fake.play();
      fake.tick(9.8); // between two timeupdate events: no event fires
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(fake.muted()).toBe(false); // the action interval starts at 9.85 (the finding's 10.00 minus the margin): not reached yet
      fake.tick(10.3); // still no event
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(fake.muted()).toBe(true);
      fake.tick(11.2);
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(fake.muted()).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('stops waking up when paused, and does not leak timers after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      preferencesStore.update({ warningsEnabled: false }); // heads-up timers have their own tests; this one is about mute and skip boundaries
      const { fake, unmount } = await mount(await ready());
      fireEvent.change(select(/0:10\.00 to 0:11\.00/), { target: { value: 'mute' } });
      fake.play();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      fake.pause();
      expect(vi.getTimerCount()).toBe(0);
      fake.play();
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('PlaybackPanel: skip', () => {
  it('skips to the end of the interval and announces which finding and action', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'skip');
    await play(fake, 12);
    expect(fake.seeks).toEqual([11]);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Skipped 0:10.00 to 0:11.00: flagged term “Darn”.');
    expect(fake.time()).toBeGreaterThanOrEqual(12 - 1e-9);
  });
  it('seeking into the interval by hand is respected: no skip, no loop', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'skip');
    fake.play();
    await act(async () => { await fake.userSeek(10.5); });
    await play(fake, 10.9);
    expect(fake.seeks).toEqual([]);
  });
});

describe('PlaybackPanel: overrides take effect immediately', () => {
  it('the master switch off restores the sound at once and stops skipping; on again resumes', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    await play(fake, 10.5);
    expect(fake.muted()).toBe(true);
    await userEvent.click(screen.getByRole('switch', { name: 'Automatic actions' }));
    expect(fake.muted()).toBe(false);
    expect(panel()).toHaveTextContent('Automatic actions are off: the video plays normally and your sound is untouched.');
    expect(within(screen.getAllByRole('listitem')[0]!).getByTestId('action-state')).toHaveTextContent('Mute chosen, but automatic actions are off');
    await userEvent.click(screen.getByRole('switch', { name: 'Automatic actions' }));
    expect(fake.muted()).toBe(true);
  });
  it('ignoring a finding mid-interval restores the sound immediately, and Undo ignore brings the action back', async () => {
    const { fake } = await mount(await ready());
    const choose = select(/0:10\.00 to 0:11\.00/);
    await userEvent.selectOptions(choose, 'mute');
    await play(fake, 10.5);
    expect(fake.muted()).toBe(true);
    await userEvent.selectOptions(choose, 'ignore');
    expect(fake.muted()).toBe(false);
    const row = screen.getAllByRole('listitem')[0]!;
    expect(within(row).getByTestId('action-state')).toHaveTextContent('Ignored');
    await userEvent.click(within(row).getByRole('button', { name: 'Undo ignore' }));
    expect(within(row).getByTestId('action-state')).toHaveTextContent('No action'); // back to the default
    await userEvent.selectOptions(choose, 'mute');
    expect(fake.muted()).toBe(true);
  });
  it('the default action applies to findings without their own choice; a personal choice wins', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(screen.getByLabelText('Default for flagged terms'), 'mute');
    await userEvent.selectOptions(select(/0:20\.00 to 0:21\.00/), 'ignore');
    await play(fake, 10.5);
    expect(fake.muted()).toBe(true);
    await play(fake, 20.5);
    expect(fake.muted()).toBe(false); // the second finding was ignored by the user
  });
  it('changing a choice from mute to skip mid-interval unmutes and skips on the next update', async () => {
    const { fake } = await mount(await ready());
    const choose = select(/0:10\.00 to 0:11\.00/);
    await userEvent.selectOptions(choose, 'mute');
    await play(fake, 10.5);
    await userEvent.selectOptions(choose, 'skip');
    expect(fake.muted()).toBe(false);
    await play(fake, 10.75);
    expect(fake.seeks).toEqual([11]);
  });
});

describe('PlaybackPanel: media changes and failures', () => {
  it('a different video starts fresh: old choices and old actions do not carry over', async () => {
    const first = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    await play(first.fake, 10.5);
    expect(first.fake.muted()).toBe(true);
    first.unmount();
    expect(first.fake.muted()).toBe(false); // disposing restores the sound
    const second = await mount(await ready([finding({ startMs: 10_000, endMs: 11_000 })]));
    expect(within(screen.getAllByRole('listitem')[0]!).getByTestId('action-state')).toHaveTextContent('No action');
    await play(second.fake, 10.5);
    expect(second.fake.muted()).toBe(false);
  });
  it('replacing the file inside the panel rebuilds the coordinator and releases the old URL', async () => {
    const safety = await ready();
    const { rerender } = render(<PlaybackPanel file={FILE} mediaId="m" safety={safety} />);
    expect(created).toEqual(['blob:test-0']);
    rerender(<PlaybackPanel file={new File(['y'], 'other.mp4')} mediaId="m" safety={safety} />);
    expect(created).toEqual(['blob:test-0', 'blob:test-1']);
    expect(revoked).toContain('blob:test-0');
  });
  it('a failure inside the action subsystem stops automatic actions, restores the sound and leaves playback alone', async () => {
    const { fake } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    await play(fake, 10.5);
    expect(fake.muted()).toBe(true);
    vi.spyOn(PlaybackCoordinator.prototype, 'handle').mockImplementation(() => { throw new Error('boom'); });
    await play(fake, 10.75);
    expect(fake.muted()).toBe(false);
    expect(panel()).toHaveTextContent('Automatic actions stopped because of an error. Playback and your sound are not affected.');
    expect(screen.getByRole('switch', { name: 'Automatic actions' })).toBeDisabled();
    expect(panel()).not.toHaveTextContent('boom');
    await play(fake, 25); // the user can keep watching
    expect(fake.time()).toBeGreaterThanOrEqual(25 - 1e-9);
  });
  it('cleans up its listeners on unmount: late player events do nothing', async () => {
    const { fake, unmount } = await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'skip');
    unmount();
    await act(async () => { await fake.advanceTo(10.5); });
    expect(fake.seeks).toEqual([]);
  });
});

describe('PlaybackPanel: privacy and wording', () => {
  it('does not persist per-finding choices or the master switch, and says what IS remembered', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await mount(await ready());
    await userEvent.selectOptions(select(/0:10\.00 to 0:11\.00/), 'mute');
    await userEvent.click(screen.getByRole('switch', { name: 'Automatic actions' }));
    expect(setItem).not.toHaveBeenCalled();
    expect(panel()).toHaveTextContent('Your choices for each finding are kept for this video only and are not saved; the default action and the warning settings are remembered in this browser.');
  });
  it('states what actions are and are not, with no overall verdict', async () => {
    await mount(await ready());
    expect(panel()).toHaveTextContent('the file is not edited or uploaded again');
    expect(panel()).toHaveTextContent('Timing is not sample accurate');
    expect(panel()).toHaveTextContent('unsupported categories never trigger an action');
    expect(panel().textContent).not.toMatch(/\b(unsafe|dangerous|verdict|rating)\b|is safe\b/i);
  });
  it('shows hostile terms as inert text', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await mount(await ready([finding({ attributes: { term: hostile, matchMode: 'x', matchedText: 'x' } })]));
    expect(panel()).toHaveTextContent(hostile);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});
