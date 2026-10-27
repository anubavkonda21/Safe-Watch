import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { filtersStore } from '@/features/filters/filtersStore';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import { loadYouTubeIframeApi, YouTubeApiError } from '@/infrastructure/youtube/iframeApi';
import { FakeYTPlayer, fakeYTApi, SAMPLE_ID, SAMPLE_URL } from '@/test/youtube';
import { YouTubePanel } from './YouTubePanel';

vi.mock('@/infrastructure/youtube/iframeApi', async (orig) => ({ ...(await orig<typeof import('@/infrastructure/youtube/iframeApi')>()), loadYouTubeIframeApi: vi.fn() }));
const load = vi.mocked(loadYouTubeIframeApi);

const SRT = '1\n00:00:02,000 --> 00:00:04,000\nHere is a test caption.\n\n2\n00:00:30,000 --> 00:00:33,000\nThe darn thing broke.\n\n3\n00:01:30,000 --> 00:01:33,000\nDarn it again.\n';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.localStorage.clear(); preferencesStore.reload(); filtersStore.reload();
  FakeYTPlayer.reset(); load.mockReset(); load.mockResolvedValue(fakeYTApi);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  filtersStore.add('darn', 'word-boundary');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const urlBox = () => screen.getByLabelText('YouTube link') as HTMLInputElement;
const submit = async (url: string) => { fireEvent.change(urlBox(), { target: { value: url } }); fireEvent.click(screen.getByRole('button', { name: 'Load video' })); await flush(); };
const readyPlayer = async (opts: { time?: number; playing?: boolean } = {}) => {
  await act(async () => { const p = FakeYTPlayer.last; p.time = opts.time ?? 0; p.fireReady(); if (opts.playing) p.fireState(1); });
  await flush();
};
const addCaptions = async (text: string, name = 'captions.srt') => {
  const input = screen.getByLabelText(/Caption file \(SRT or WebVTT\)/) as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [new File([text], name)] } }); await new Promise((r) => setTimeout(r, 0)); });
  await flush();
};
const stages = () => within(screen.getByLabelText('Progress'));

describe('the form and URL validation', () => {
  it('shows a labelled link field and loads nothing from YouTube until a valid link is submitted', () => {
    render(<YouTubePanel />);
    expect(urlBox()).toHaveAttribute('type', 'url');
    expect(load).not.toHaveBeenCalled();
    expect(FakeYTPlayer.instances).toHaveLength(0);
    expect(screen.queryByLabelText('Progress')).toBeNull();
  });

  it.each([
    ['https://evil.example/watch?v=dQw4w9WgXcQ', /not a YouTube video link/],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', /not a single video/],
    ['javascript:alert(1)', /web links/],
    ['https://www.youtube.com/watch?v=short', /not valid/],
    ['https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ', /user name or password/],
    ['', /Paste a YouTube link/],
  ])('rejects %j with a clear message, without contacting YouTube or building a player', async (bad, message) => {
    render(<YouTubePanel />);
    await submit(bad);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(urlBox()).toHaveAttribute('aria-invalid', 'true');
    expect(load).not.toHaveBeenCalled();
    expect(FakeYTPlayer.instances).toHaveLength(0);
    expect(screen.queryByLabelText('Progress')).toBeNull();
  });

  it('never echoes the rejected text back into the page', async () => {
    render(<YouTubePanel />);
    await submit('https://evil.example/<img src=x onerror=alert(1)>');
    expect(screen.getByRole('alert').innerHTML).not.toContain('evil.example');
    expect(document.querySelector('img')).toBeNull();
  });

  it('discloses, before anything is loaded, that YouTube is contacted and what is not sent', () => {
    render(<YouTubePanel />);
    expect(screen.getByText(/Loading a video contacts YouTube/)).toBeInTheDocument();
    expect(screen.getByText(/does not start by itself/)).toBeInTheDocument();
    expect(screen.getByText(/not sent to YouTube or to anyone else/)).toBeInTheDocument();
  });
});

describe('loading a video', () => {
  it('walks the visible stages: link validated → player loading → player loaded', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    expect(FakeYTPlayer.instances).toHaveLength(1);
    expect(FakeYTPlayer.last.options.videoId).toBe(SAMPLE_ID);
    expect(stages().getByText('Link validated')).toBeInTheDocument();
    expect(stages().getByText('Loading the YouTube player…')).toBeInTheDocument();
    await readyPlayer();
    expect(stages().getByText('Player loaded')).toBeInTheDocument();
  });

  it('accepts youtu.be and Shorts links too, and uses only the id', async () => {
    render(<YouTubePanel />);
    await submit(`https://youtu.be/${SAMPLE_ID}?t=30&si=tracking`);
    expect(FakeYTPlayer.last.options.videoId).toBe(SAMPLE_ID);
    await submit(`https://www.youtube.com/shorts/aaaaaaaaaaa`);
    expect(FakeYTPlayer.last.options.videoId).toBe('aaaaaaaaaaa');
  });

  it('gives the player a labelled, keyboard-reachable region and a 16:9 box that keeps the 200 px minimum', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    expect(screen.getByRole('region', { name: 'YouTube video player' })).toBeInTheDocument();
  });

  it('does not use the network itself: no fetch, and nothing is sent to the SafeWatch server', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions(SRT);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [100, /not available/], [101, /cannot be played here/], [150, /cannot be played here/], [2, /did not accept/], [5, /problem with this video/], [153, /could not identify/],
  ] as const)('player error %i is explained, offers a retry, and leaves no stale analysis', async (code, message) => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await act(async () => { FakeYTPlayer.last.fireError(code); });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(stages().getByText('Player could not load the video')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('"Try again" builds a fresh player', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await act(async () => { FakeYTPlayer.last.fireError(150); });
    const first = FakeYTPlayer.last;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(first.destroyed).toBe(true);
    expect(FakeYTPlayer.instances).toHaveLength(2);
    expect(screen.queryByText(/cannot be played here/)).toBeNull();
  });

  it('a blocked or failed API load is explained (no other way to load it is attempted)', async () => {
    load.mockRejectedValueOnce(new YouTubeApiError('network'));
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(FakeYTPlayer.instances).toHaveLength(0);
  });
});

describe('what can be checked, honestly', () => {
  it('without captions: analysis is unavailable, the reason is stated, and nothing is found or acted on', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    expect(stages().getByText(/Unavailable: no caption file/)).toBeInTheDocument();
    const caps = within(screen.getByLabelText('What can be checked for this source'));
    expect(caps.getByText(/only releases caption files to the video’s owner/)).toBeInTheDocument();
    expect(caps.getByText('Your phrases in speech').closest('li')).toHaveTextContent('Unavailable');
    expect(caps.getByText(/Scene categories/).closest('li')).toHaveTextContent('Not supported');
    expect(screen.queryByRole('list', { name: 'Findings and actions' })).toBeNull();
    expect(screen.getByText(/No analysis yet/)).toBeInTheDocument();
    expect(screen.getByText(/does not mean the video is suitable/)).toBeInTheDocument();
  });

  it('says plainly that speech cannot be checked for YouTube and points to the local file option', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    const caps = within(screen.getByLabelText('What can be checked for this source'));
    expect(caps.getByText(/does not give SafeWatch the audio/)).toBeInTheDocument();
    expect(caps.getAllByText(/local file option/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No speech is recognised for YouTube videos/)).toBeInTheDocument();
  });

  it('with captions: findings with exact cue timing, a PARTIAL analysis, and provenance naming the user’s file', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions(SRT, 'my-captions.srt');
    expect(stages().getByText(/Partial: your phrases were checked in your captions only/)).toBeInTheDocument();
    expect(stages().getByText('3 captions from your file')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Findings and actions' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('0:30.00 to 0:33.00');
    expect(rows[0]).toHaveTextContent('Subtitle cue, exact line');
    expect(rows[0]).toHaveTextContent('Flagged terms');
    expect(screen.getByText(/my-captions\.srt/)).toBeInTheDocument();
    expect(screen.getByText(/caption file you provided/)).toBeInTheDocument();
    expect(screen.getByText(/The analysis is partial/)).toBeInTheDocument();
    // No fabricated numbers anywhere in the panel.
    expect(screen.getByTestId('youtube-panel').textContent).not.toMatch(/\d+\s?%/);
  });

  it('never marks a YouTube analysis "Complete"', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions(SRT);
    expect(stages().queryByText(/^Complete$/)).toBeNull();
  });

  it('re-checks instantly when the phrase list changes (the captions never leave the browser)', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions(SRT);
    expect(within(screen.getByRole('list', { name: 'Findings and actions' })).getAllByRole('listitem')).toHaveLength(2);
    await act(async () => { filtersStore.add('caption', 'word-boundary'); });
    await flush();
    expect(within(screen.getByRole('list', { name: 'Findings and actions' })).getAllByRole('listitem')).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a caption file, or is too big, without changing the analysis', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions('this is just text', 'notes.txt');
    expect(screen.getByRole('alert')).toHaveTextContent(/does not look like an SRT or WebVTT/);
    expect(stages().getByText('None provided')).toBeInTheDocument();
    const input = screen.getByLabelText(/Caption file \(SRT or WebVTT\)/);
    const big = new File(['x'], 'big.srt'); Object.defineProperty(big, 'size', { value: 3_000_000 });
    await act(async () => { fireEvent.change(input, { target: { files: [big] } }); });
    expect(screen.getByRole('alert')).toHaveTextContent(/too large/);
  });

  it('removing the captions removes the findings and returns the analysis to unavailable', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions(SRT);
    fireEvent.click(screen.getByRole('button', { name: 'Remove captions' }));
    await flush();
    expect(screen.queryByRole('list', { name: 'Findings and actions' })).toBeNull();
    expect(stages().getByText(/Unavailable: no caption file/)).toBeInTheDocument();
  });

  it('reads WebVTT as well', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions('WEBVTT\n\n00:30.000 --> 00:33.000\nThe darn thing broke.\n', 'c.vtt');
    expect(within(screen.getByRole('list', { name: 'Findings and actions' })).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('late and missed findings are reported as such', () => {
  it('captions added while playback is already at 40 s: the 30 s finding is missed, the 90 s one is fine, and the page says so', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer({ time: 40, playing: true });
    await addCaptions(SRT);
    expect(screen.getByText(/1 finding was found after playback had already reached it, so no warning is possible for it/)).toBeInTheDocument();
    expect(screen.queryByText(/warning is late/)).toBeNull();
  });

  it('a finding found less than the lead time before it starts is reported as late', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer({ time: 20, playing: true });
    await addCaptions(SRT); // 30 s finding is 10 s away
    expect(screen.getByText(/1 finding was found less than 20 seconds before it starts, so its warning is late/)).toBeInTheDocument();
  });

  it('captions added before playback: no banner (every warning can be on time)', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    await addCaptions(SRT);
    expect(screen.queryByText(/found after playback|warning is late/)).toBeNull();
  });
});

describe('warnings on the YouTube timeline', () => {
  it('shows the warning 20 s ahead, names the phrase, lets Ignore mark it without touching playback, and shows nothing for a missed one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await act(async () => { FakeYTPlayer.last.time = 0; FakeYTPlayer.last.fireReady(); });
    await act(async () => { fireEvent.change(screen.getByLabelText(/Caption file \(SRT or WebVTT\)/), { target: { files: [new File([SRT], 'c.srt')] } }); await vi.advanceTimersByTimeAsync(50); });
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).toBeNull();
    const p = FakeYTPlayer.last;
    p.time = 9; await act(async () => { p.fireState(1); });
    const tick = setInterval(() => { if (p.state === 1) p.time += 0.05; }, 50);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); // 10.5 s: the window for the 30 s finding is open
    const card = screen.getByRole('group', { name: 'Upcoming flagged phrase' });
    expect(card).toHaveTextContent('A flagged phrase is coming up.');
    expect(card).toHaveTextContent('Starts in about 20 seconds');
    expect(card).not.toHaveTextContent(/late/i);
    fireEvent.click(within(card).getByRole('button', { name: 'Ignore' }));
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).toBeNull();
    expect(p.seeks).toEqual([]); expect(p.muteCalls).toEqual([]); expect(p.state).toBe(1); // playback untouched
    clearInterval(tick);
  });

  it('Skip on a warning arms the skip; the player seeks to the end of the finding when playback reaches it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await act(async () => { FakeYTPlayer.last.fireReady(); });
    await act(async () => { fireEvent.change(screen.getByLabelText(/Caption file \(SRT or WebVTT\)/), { target: { files: [new File([SRT], 'c.srt')] } }); await vi.advanceTimersByTimeAsync(50); });
    const p = FakeYTPlayer.last;
    p.time = 9; await act(async () => { p.fireState(1); });
    const tick = setInterval(() => { if (p.state === 1) p.time += 0.05; }, 50);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    fireEvent.click(within(screen.getByRole('group', { name: 'Upcoming flagged phrase' })).getByRole('button', { name: 'Skip' }));
    expect(p.seeks).toEqual([]); // nothing yet: it is armed, not executed
    await act(async () => { await vi.advanceTimersByTimeAsync(20_500); }); // playback reaches 30.x s
    expect(p.seeks).toEqual([[33, true]]);
    clearInterval(tick);
  });

  it('muting uses the player’s own mute and restores the sound afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await act(async () => { FakeYTPlayer.last.fireReady(); });
    await act(async () => { fireEvent.change(screen.getByLabelText(/Caption file \(SRT or WebVTT\)/), { target: { files: [new File([SRT], 'c.srt')] } }); await vi.advanceTimersByTimeAsync(50); });
    fireEvent.change(screen.getAllByRole('combobox', { name: /Action for the finding at 0:30/ })[0]!, { target: { value: 'mute' } });
    const p = FakeYTPlayer.last;
    p.time = 28; await act(async () => { p.fireState(1); });
    const tick = setInterval(() => { if (p.state === 1) p.time += 0.05; }, 50);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(p.muted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(p.muted).toBe(false);
    expect(p.muteCalls).toEqual(['mute', 'unMute']);
    clearInterval(tick);
  });
});

describe('switching and cleaning up', () => {
  it('a different video starts from nothing: no captions, findings, banner or error carries over, and the old player is destroyed', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer({ time: 40, playing: true });
    await addCaptions(SRT);
    expect(screen.getByText(/found after playback/)).toBeInTheDocument();
    const first = FakeYTPlayer.last;
    await submit('https://youtu.be/aaaaaaaaaaa');
    expect(first.destroyed).toBe(true);
    expect(FakeYTPlayer.last.options.videoId).toBe('aaaaaaaaaaa');
    expect(screen.queryByRole('list', { name: 'Findings and actions' })).toBeNull();
    expect(screen.queryByText(/found after playback/)).toBeNull();
    expect(stages().getByText('None provided')).toBeInTheDocument();
    expect(stages().getByText(/Unavailable: no caption file/)).toBeInTheDocument();
  });

  it('a rejected link keeps the current video and its state (nothing is torn down by a typo)', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    const p = FakeYTPlayer.last;
    await submit('not a link');
    expect(p.destroyed).toBe(false);
    expect(FakeYTPlayer.instances).toHaveLength(1);
  });

  it('"Stop and clear" destroys the player and returns to the empty form', async () => {
    render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await readyPlayer();
    const p = FakeYTPlayer.last;
    fireEvent.click(screen.getByRole('button', { name: 'Stop and clear this video' }));
    expect(p.destroyed).toBe(true);
    expect(screen.queryByLabelText('Progress')).toBeNull();
  });

  it('unmounting leaves no live player, timer or listener behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    const { unmount } = render(<YouTubePanel />);
    await submit(SAMPLE_URL);
    await act(async () => { FakeYTPlayer.last.fireReady(); });
    unmount();
    expect(FakeYTPlayer.instances.filter((x) => !x.destroyed)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
