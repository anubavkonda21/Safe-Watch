import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { UploadSection } from '@/components/marketing/UploadSection';
import { loadYouTubeIframeApi } from '@/infrastructure/youtube/iframeApi';
import { FakeYTPlayer, fakeYTApi, SAMPLE_URL } from '@/test/youtube';
import { SourceSelector } from './SourceSelector';

vi.mock('@/infrastructure/youtube/iframeApi', async (orig) => ({ ...(await orig<typeof import('@/infrastructure/youtube/iframeApi')>()), loadYouTubeIframeApi: vi.fn() }));
const load = vi.mocked(loadYouTubeIframeApi);

beforeEach(() => { window.localStorage.clear(); FakeYTPlayer.reset(); load.mockReset(); load.mockResolvedValue(fakeYTApi); });

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const tab = (name: string) => screen.getByRole('tab', { name });

describe('SourceSelector', () => {
  it('starts on the local file source, and nothing from YouTube is loaded', () => {
    render(<SourceSelector local={<p>local experience</p>} />);
    expect(tab('Local file')).toHaveAttribute('aria-selected', 'true');
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('local experience')).toBeInTheDocument();
    expect(screen.queryByTestId('youtube-panel')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('is an accessible tab set: one tab in the tab order, a labelled panel, arrow keys / Home / End move and select', () => {
    render(<SourceSelector local={<p>local experience</p>} />);
    expect(screen.getByRole('tablist', { name: 'Where is the video?' })).toBeInTheDocument();
    expect(tab('Local file')).toHaveAttribute('tabindex', '0');
    expect(tab('YouTube')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Local file');
    fireEvent.keyDown(tab('Local file'), { key: 'ArrowRight' });
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'true');
    expect(tab('YouTube')).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('YouTube');
    fireEvent.keyDown(tab('YouTube'), { key: 'ArrowRight' });
    expect(tab('Local file')).toHaveAttribute('aria-selected', 'true'); // wraps
    fireEvent.keyDown(tab('Local file'), { key: 'End' });
    expect(tab('YouTube')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab('YouTube'), { key: 'Home' });
    expect(tab('Local file')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab('Local file'), { key: 'a' });
    expect(tab('Local file')).toHaveAttribute('aria-selected', 'true');
  });

  it('switching to YouTube unmounts the local experience; switching back unmounts YouTube and destroys its player', async () => {
    render(<SourceSelector local={<p>local experience</p>} />);
    fireEvent.click(tab('YouTube'));
    expect(screen.queryByText('local experience')).toBeNull();
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: SAMPLE_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Load video' }));
    await flush();
    await act(async () => { FakeYTPlayer.last.fireReady(); FakeYTPlayer.last.fireState(1); });
    const player = FakeYTPlayer.last;
    fireEvent.click(tab('Local file'));
    expect(player.destroyed).toBe(true); // the picture and the sound stop: nothing keeps playing in the background
    expect(screen.queryByTestId('youtube-panel')).toBeNull();
    expect(screen.getByText('local experience')).toBeInTheDocument();
  });

  it('coming back to YouTube later starts from the empty form: no earlier video, captions or findings', async () => {
    render(<SourceSelector local={<p>local experience</p>} />);
    fireEvent.click(tab('YouTube'));
    fireEvent.change(screen.getByLabelText('YouTube link'), { target: { value: SAMPLE_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Load video' }));
    await flush();
    fireEvent.click(tab('Local file'));
    fireEvent.click(tab('YouTube'));
    expect(screen.queryByLabelText('Progress')).toBeNull();
    expect((screen.getByLabelText('YouTube link') as HTMLInputElement).value).toBe('');
  });
});

describe('the existing local-file experience is unchanged', () => {
  it('the upload section still opens on the local file dropzone with its guide', () => {
    render(<UploadSection />);
    expect(screen.getByRole('button', { name: 'Choose video' })).toBeInTheDocument();
    expect(screen.getByText('What SafeWatch does today')).toBeInTheDocument();
    expect(screen.getByLabelText('Video file')).toBeInTheDocument();
    expect(tab('Local file')).toHaveAttribute('aria-selected', 'true');
    expect(load).not.toHaveBeenCalled();
  });

  it('switching to YouTube and back restores a working, empty dropzone', () => {
    render(<UploadSection />);
    fireEvent.click(tab('YouTube'));
    expect(screen.queryByRole('button', { name: 'Choose video' })).toBeNull();
    fireEvent.click(tab('Local file'));
    expect(screen.getByRole('button', { name: 'Choose video' })).toBeEnabled();
  });
});

describe('layout rules (the stylesheet is checked as text because jsdom does not lay anything out)', () => {
  const css = readFileSync(join(process.cwd(), 'src/features/youtube/youtube.css'), 'utf8');

  it('the player box is 16:9, never smaller than YouTube’s 200 px minimum height (202 px with its borders), and clips nothing of the frame', () => {
    expect(css).toMatch(/\.sw-yt \{[^}]*aspect-ratio: 16 \/ 9/);
    expect(css).toMatch(/\.sw-yt \{[^}]*min-height: 202px/);
    expect(css).toMatch(/\.sw-yt iframe \{[^}]*width: 100%[^}]*height: 100%/);
  });

  it('nothing is positioned over the player: no absolute or fixed layers on or inside it', () => {
    const rules = css.split('}').filter((r) => /\.sw-yt[\s{,]|\.sw-yt\b/.test(r.split('{')[0] ?? '') && !/\.sw-yt-/.test(r.split('{')[0] ?? ''));
    for (const r of rules) expect(r).not.toMatch(/position:\s*(absolute|fixed|sticky)/);
    expect(css).not.toMatch(/z-index/);
  });

  it('narrow screens: the form and stages collapse to one column and long text wraps instead of overflowing', () => {
    expect(css).toMatch(/@media \(max-width: 420px\)[^@]*\.sw-yt-form__row \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.sw-yt-stage \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.sw-yt-panel \.sw-btn \{[^}]*white-space: normal/);
    expect(css).toMatch(/\.sw-yt-form__row \{[^}]*minmax\(0, 1fr\)/);
  });

  it('touch targets: the tabs use the shared 44 px touch size', () => {
    expect(css).toMatch(/\.sw-source__tab \{[^}]*min-height: var\(--sw-touch\)/);
  });
});
