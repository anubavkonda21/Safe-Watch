import { act, fireEvent, render, screen } from '@testing-library/react';
import { HomePage } from '@/pages/HomePage';
import { filtersStore } from '@/features/filters/filtersStore';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import { loadYouTubeIframeApi } from '@/infrastructure/youtube/iframeApi';
import { PlaybackPanel } from '@/features/playback/PlaybackPanel';
import { YouTubePanel } from '@/features/youtube/YouTubePanel';
import { axeViolations } from '@/test/axe';
import { installFakeVideo } from '@/test/media';
import { analysisWith, finding } from '@/test/safetyFindings';
import { FakeYTPlayer, fakeYTApi, SAMPLE_URL } from '@/test/youtube';

vi.mock('@/infrastructure/youtube/iframeApi', async (orig) => ({ ...(await orig<typeof import('@/infrastructure/youtube/iframeApi')>()), loadYouTubeIframeApi: vi.fn() }));
const load = vi.mocked(loadYouTubeIframeApi);

beforeEach(() => { window.localStorage.clear(); preferencesStore.reload(); filtersStore.reload(); FakeYTPlayer.reset(); load.mockReset(); load.mockResolvedValue(fakeYTApi); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const SRT = '1\n00:00:30,000 --> 00:00:33,000\nThe darn thing broke.\n';

describe('automated accessibility checks (axe-core, jsdom rule set; not a compliance claim)', () => {
  it('the landing page', async () => {
    render(<HomePage />);
    expect(await axeViolations()).toEqual([]);
  });

  it('every interactive control on the landing page has an accessible name', () => {
    render(<HomePage />);
    const controls = [...document.querySelectorAll<HTMLElement>('a[href], button, input:not([type=hidden]), select, textarea, [role=tab], [role=switch]')];
    expect(controls.length).toBeGreaterThan(10);
    for (const c of controls) expect(c, c.outerHTML.slice(0, 90)).toHaveAccessibleName();
  });

  it('the YouTube source with a loaded player, captions and findings', async () => {
    filtersStore.add('darn', 'word-boundary');
    render(<YouTubePanel />);
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: SAMPLE_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Load video' }));
    await flush();
    await act(async () => { FakeYTPlayer.last.fireReady(); });
    await act(async () => { fireEvent.change(screen.getByLabelText(/Caption file/), { target: { files: [new File([SRT], 'c.srt')] } }); await new Promise((r) => setTimeout(r, 0)); });
    await flush();
    expect(screen.getByRole('list', { name: 'Findings and actions' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('the YouTube source in its error state', async () => {
    render(<YouTubePanel />);
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: SAMPLE_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Load video' }));
    await flush();
    await act(async () => { FakeYTPlayer.last.fireError(150); });
    expect(await axeViolations()).toEqual([]);
  });

  it('the YouTube form with a rejected link', async () => {
    render(<YouTubePanel />);
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: 'nonsense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load video' }));
    expect(await axeViolations()).toEqual([]);
    expect(screen.getByLabelText('YouTube link')).toHaveAccessibleDescription(/Watch links, youtu\.be links/);
  });

  it('local playback with findings', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:a11y'); URL.revokeObjectURL = vi.fn();
    const darn = finding({ id: 'sf-flagged-terms-0000', startMs: 30_000, endMs: 32_000, attributes: { term: 'Darn', matchMode: 'word-boundary', matchedText: 'darn' } });
    render(<PlaybackPanel file={new File(['x'], 'clip.mp4', { type: 'video/mp4' })} mediaId="m" safety={{ state: 'ready', analysis: await analysisWith([darn]) }} />);
    installFakeVideo(document.querySelector('video')!);
    expect(screen.getByRole('list', { name: 'Findings and actions' })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});

describe('warning behaviour that assistive technology depends on', () => {
  it('a warning is announced through a polite live region and is a labelled group', async () => {
    filtersStore.add('darn', 'word-boundary');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    render(<YouTubePanel />);
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: SAMPLE_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Load video' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { FakeYTPlayer.last.fireReady(); });
    await act(async () => { fireEvent.change(screen.getByLabelText(/Caption file/), { target: { files: [new File([SRT], 'c.srt')] } }); await vi.advanceTimersByTimeAsync(50); });
    const p = FakeYTPlayer.last;
    p.time = 9; await act(async () => { p.fireState(1); });
    const tick = setInterval(() => { if (p.state === 1) p.time += 0.05; }, 50);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const card = screen.getByRole('group', { name: 'Upcoming flagged phrase' });
    const live = screen.getAllByRole('status').find((e) => e.getAttribute('aria-live') === 'polite' && /flagged phrase is coming up/.test(e.textContent ?? ''));
    expect(live).toBeDefined();
    expect(live!.textContent).toMatch(/Starts in about 20 seconds/);
    // Same warning, still showing: the announcement text is not re-set by time passing.
    const before = live!.textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(live!.textContent).toBe(before);
    // Controls are real buttons with names; Escape dismisses from inside the card.
    expect(card.querySelectorAll('button')).toHaveLength(3);
    for (const b of card.querySelectorAll('button')) expect(b).toHaveAccessibleName();
    // axe needs real timers; the DOM (with the warning on screen) is unchanged.
    vi.useRealTimers();
    expect(await axeViolations()).toEqual([]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Skip' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).toBeNull();
    clearInterval(tick);
  });
});
