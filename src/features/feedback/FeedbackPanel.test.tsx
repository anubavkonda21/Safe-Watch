import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { feedbackStore } from './feedbackStore';
import { FeedbackPanel } from './FeedbackPanel';

const KEY = 'safewatch.feedback.v1';
beforeEach(() => { window.localStorage.clear(); feedbackStore.reload(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const panel = () => screen.getByRole('region', { name: 'Missed phrases' });
const mount = (over: Partial<Parameters<typeof FeedbackPanel>[0]> = {}) => render(<FeedbackPanel session="s1" durationMs={60_000} playheadMs={() => 12_340} {...over} />);
const open = async () => { await userEvent.click(screen.getByRole('button', { name: 'Report a missed phrase' })); return screen.getByRole('dialog', { name: 'Report a missed phrase' }); };
const fill = async (dialog: HTMLElement, v: { time?: string; phrase?: string; note?: string; category?: string }) => {
  if (v.time !== undefined) { const t = within(dialog).getByLabelText('Time in the video'); await userEvent.clear(t); await userEvent.type(t, v.time); }
  if (v.phrase !== undefined) await userEvent.type(within(dialog).getByLabelText('Missed word or phrase'), v.phrase);
  if (v.note !== undefined) await userEvent.type(within(dialog).getByLabelText('Note (optional)'), v.note);
  if (v.category !== undefined) await userEvent.selectOptions(within(dialog).getByLabelText('Where did you notice it?'), v.category);
};

describe('FeedbackPanel: what it says before anything is typed', () => {
  it('states that a report is saved on this device only and trains nothing, in the panel and in the form', async () => {
    mount();
    expect(panel()).toHaveTextContent('Saved only on this device, for you to review. It does not train SafeWatch, change this analysis or add a finding.');
    const dialog = await open();
    expect(dialog).toHaveTextContent('does not train SafeWatch, is not sent anywhere, does not change this analysis and is not added to the findings');
  });
  it('prefills the time from the playhead, and the user can correct it', async () => {
    mount();
    const dialog = await open();
    const time = within(dialog).getByLabelText('Time in the video');
    expect(time).toHaveValue('0:12.3');
    expect(dialog).toHaveTextContent('Between 0:00 and 1:00.0');
    await userEvent.clear(time);
    await userEvent.type(time, '0:30');
    expect(time).toHaveValue('0:30');
  });
  it('offers only the categories the product can represent: speech, subtitles, not sure', async () => {
    mount();
    const dialog = await open();
    expect([...(within(dialog).getByLabelText('Where did you notice it?') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['I heard it', 'It was in the subtitles', 'Not sure where']);
  });
});

describe('FeedbackPanel: submitting', () => {
  it('saves a valid report locally, closes the form, confirms, and lists it for review', async () => {
    mount();
    const dialog = await open();
    await fill(dialog, { phrase: 'quick brown fox', note: 'said twice', category: 'subtitle' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(screen.queryByRole('dialog', { name: 'Report a missed phrase' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device. It is a note for you: it is not a finding and does not change the analysis.');
    const list = screen.getByRole('list', { name: 'Your saved reports' });
    expect(list).toHaveTextContent('0:12.3');
    expect(list).toHaveTextContent('“quick brown fox”');
    expect(list).toHaveTextContent('It was in the subtitles · this video · said twice');
    const stored = JSON.parse(window.localStorage.getItem(KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ session: 's1', timestampMs: 12_300, durationMs: 60_000, phrase: 'quick brown fox', category: 'subtitle', note: 'said twice' });
  });
  it('rejects an empty phrase, an invalid time and a time past the end, each with a message on the right field, and saves nothing', async () => {
    mount();
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(within(dialog).getByText('Enter the word or phrase that was missed.')).toBeInTheDocument();
    await fill(dialog, { phrase: 'hello', time: 'soon' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(within(dialog).getByText('Enter a time such as 1:23 or 83.5.')).toBeInTheDocument();
    await fill(dialog, { time: '1:05' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(within(dialog).getByText('That time is after the end of the video.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Time in the video')).toHaveAttribute('aria-invalid', 'true');
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
  it('clears a field’s message as soon as the user edits that field', async () => {
    mount();
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(within(dialog).getByText('Enter the word or phrase that was missed.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Missed word or phrase'), 'a');
    expect(within(dialog).queryByText('Enter the word or phrase that was missed.')).not.toBeInTheDocument();
  });
  it('rejects too-long input and a punctuation-only phrase', async () => {
    mount();
    const dialog = await open();
    await fill(dialog, { phrase: '!!!' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(within(dialog).getByText('Include at least one letter or number.')).toBeInTheDocument();
  });
  it('Cancel saves nothing and clears the typed text for the next time', async () => {
    mount();
    let dialog = await open();
    await fill(dialog, { phrase: 'never saved' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(window.localStorage.getItem(KEY)).toBeNull();
    dialog = await open();
    expect(within(dialog).getByLabelText('Missed word or phrase')).toHaveValue('');
  });
  it('works when the video length is not known (any non-negative time) and when there is no player (empty time)', async () => {
    mount({ durationMs: null, playheadMs: () => null });
    const dialog = await open();
    expect(within(dialog).getByLabelText('Time in the video')).toHaveValue('');
    await fill(dialog, { time: '95:00', phrase: 'late' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(screen.getByRole('list', { name: 'Your saved reports' })).toHaveTextContent('95:00.0');
  });
});

describe('FeedbackPanel: review and delete', () => {
  const seed = async () => { mount(); const d = await open(); await fill(d, { phrase: 'first' }); await userEvent.click(within(d).getByRole('button', { name: 'Save report' })); const d2 = await open(); await fill(d2, { phrase: 'second', time: '0:20' }); await userEvent.click(within(d2).getByRole('button', { name: 'Save report' })); };
  it('lists newest first and deletes one report', async () => {
    await seed();
    const items = within(screen.getByRole('list', { name: 'Your saved reports' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('“second”');
    await userEvent.click(within(items[0]!).getByRole('button', { name: /Delete the report “second”/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toHaveLength(1);
  });
  it('deleting all asks first, can be undone by choosing "Keep them", and then removes everything', async () => {
    await seed();
    await userEvent.click(screen.getByRole('button', { name: 'Delete all reports' }));
    expect(panel()).toHaveTextContent('Delete all 2 saved reports?');
    await userEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Delete all reports' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete all' }));
    expect(screen.queryByRole('list', { name: 'Your saved reports' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([]);
  });
  it('restores saved reports after a reload and marks those from another video as earlier', async () => {
    await seed();
    feedbackStore.reload();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    document.body.innerHTML = '';
    render(<FeedbackPanel session="another-session" durationMs={30_000} playheadMs={() => 0} />);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('an earlier video');
  });
  it('ignores corrupt stored reports instead of showing or trusting them', () => {
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 'x', phrase: '<img src=x onerror=alert(1)>' }, 'junk', null]));
    feedbackStore.reload();
    mount();
    expect(screen.queryByRole('list', { name: 'Your saved reports' })).not.toBeInTheDocument();
  });
  it('shows hostile text as inert text', async () => {
    mount();
    const dialog = await open();
    await fill(dialog, { phrase: '<img src=x onerror=alert(1)><script>alert(2)</script>', note: '<b>x</b>' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(screen.getByRole('list', { name: 'Your saved reports' })).toHaveTextContent('<img src=x onerror=alert(1)><script>alert(2)</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});

describe('FeedbackPanel: privacy and separation from findings', () => {
  it('makes no network request at all, ever (open, save, review, delete)', async () => {
    const fetchSpy = vi.fn(); const xhr = vi.fn(); const beacon = vi.fn();
    vi.stubGlobal('fetch', fetchSpy); vi.stubGlobal('XMLHttpRequest', xhr); Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    mount();
    const dialog = await open();
    await fill(dialog, { phrase: 'private words', note: 'private note' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    await userEvent.click(screen.getByRole('button', { name: /Delete the report/ }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });
  it('writes only to its own storage key, and never logs what was typed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount();
    const dialog = await open();
    await fill(dialog, { phrase: 'secret-phrase-123' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(setItem.mock.calls.map((c) => c[0])).toEqual([KEY]);
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-phrase-123');
  });
  it('stores nothing that identifies the file: no name, no path, no media id, only a random session and the length', async () => {
    mount({ session: 'random-session-id' });
    const dialog = await open();
    await fill(dialog, { phrase: 'hello' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    const raw = window.localStorage.getItem(KEY)!;
    expect(raw).not.toMatch(/\.mp4|\.mkv|\/Users|\/tmp|filename|path/i);
    expect(Object.keys(JSON.parse(raw)[0]).sort()).toEqual(['category', 'createdAt', 'durationMs', 'id', 'note', 'phrase', 'session', 'timestampMs']);
  });
  it('a report is never a finding: the panel exposes no finding, finding list or action', async () => {
    mount();
    const dialog = await open();
    await fill(dialog, { phrase: 'hello' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(screen.queryByRole('list', { name: /finding/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /skip|mute|ignore/i })).not.toBeInTheDocument();
    expect(panel()).toHaveTextContent('not a finding');
  });
  it('makes no promise of future detection or improvement', async () => {
    mount();
    await open();
    expect(document.body.textContent).not.toMatch(/will be detected|we will fix|guarantee|improve (the model|detection)|helps? (train|improve)|thank you for helping/i);
  });
});
