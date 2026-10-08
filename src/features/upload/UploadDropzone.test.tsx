import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMediaIngestion } from '@/application/mediaIngestion';
import type { MediaProcessor } from '@/application/mediaProcessor';
import type { MediaUploader } from '@/application/mediaUploader';
import { MediaIngestionError } from '@/domain/media/errors';
import { normalizeMetadata } from '@/domain/media/metadata';
import { HEADERS, makeFile } from '@/test/files';
import { completedExtraction, processingExtraction } from '@/test/extraction';
import { processingTextAnalysis, readyTextAnalysis } from '@/test/textAnalysis';
import { processingVisual, readyVisual } from '@/test/visualAnalysis';
import { filtersStore } from '@/features/filters/filtersStore';
import { unavailableExtraction } from '@/domain/extraction/extraction';
import { UploadDropzone } from './UploadDropzone';

const MB = 1024 * 1024;
/** Extraction that never reports: keeps these tests about upload behaviour only. */
const neverSettles = () => new Promise<never>(() => undefined);
const okProcessor: MediaProcessor = {
  extractMetadata: async () => normalizeMetadata({ durationSeconds: 125, width: 1920, height: 1080 }, 'browser'),
};
const ingestionWith = (processor: MediaProcessor = okProcessor, maxBytes = 10 * MB) => createMediaIngestion({ processor, maxBytes });
const ffprobeMeta = normalizeMetadata({ durationSeconds: 125, width: 1920, height: 1080, frameRate: 29.97 }, 'ffprobe');
const group = () => screen.getByRole('group');
const drop = (file: File) => fireEvent.drop(group(), { dataTransfer: { files: [file] } });

describe('UploadDropzone', () => {
  it('renders the default state with heading, supported formats and a labelled action', () => {
    render(<UploadDropzone ingestion={ingestionWith()} maxBytes={10 * MB} />);
    expect(group()).toHaveAttribute('data-state', 'idle');
    expect(screen.getByRole('heading', { name: 'Drop a video to analyze' })).toBeInTheDocument();
    expect(group()).toHaveAccessibleDescription(/MP4, MOV, MKV and other supported formats, up to 10\.0 MB/);
    expect(screen.getByRole('button', { name: 'Choose video' })).toBeEnabled();
  });

  it('opens the file picker from the keyboard with Enter and Space', async () => {
    render(<UploadDropzone ingestion={ingestionWith()} />);
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Choose video' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it('shows the drag-over state, reverts on leave, and does not select on dragover alone', () => {
    render(<UploadDropzone ingestion={ingestionWith()} />);
    fireEvent.dragOver(group());
    expect(group()).toHaveAttribute('data-state', 'dragging');
    expect(screen.getByRole('heading', { name: 'Release to select this video' })).toBeInTheDocument();
    fireEvent.dragLeave(group());
    expect(group()).toHaveAttribute('data-state', 'idle');
  });

  it('walks validating → accepted/processing → ready for a chosen file', async () => {
    let finish!: () => void;
    const processor: MediaProcessor = {
      extractMetadata: () => new Promise((res) => { finish = () => res(normalizeMetadata({ durationSeconds: 125, width: 1920, height: 1080 }, 'browser')); }),
    };
    render(<UploadDropzone ingestion={ingestionWith(processor)} />);
    await userEvent.upload(screen.getByLabelText('Video file'), makeFile('../my;clip.mp4', HEADERS.mp4));

    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'processing'));
    expect(screen.getByRole('heading', { name: 'Preparing your media...' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Preparing your media' })).toBeInTheDocument();
    expect(group()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('my_clip.mp4')).toBeInTheDocument();
    expect(screen.getByText('MP4 video')).toBeInTheDocument();

    await act(async () => finish());
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByRole('heading', { name: 'Media ready' })).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
    expect(screen.getByText('1920×1080')).toBeInTheDocument();
    expect(screen.getByText('Analysis has not started')).toBeInTheDocument();
    expect(screen.getByText('Media: ready')).toBeInTheDocument();
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();
    expect(group()).not.toHaveAttribute('aria-busy');
  });

  it('accepts a dropped file', async () => {
    render(<UploadDropzone ingestion={ingestionWith()} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
  });

  it('keeps a valid file with unreadable metadata READY and explains the difference', async () => {
    const processor: MediaProcessor = { extractMetadata: async () => normalizeMetadata({}, 'browser', 'unsupported-by-browser') };
    render(<UploadDropzone ingestion={ingestionWith(processor)} />);
    drop(makeFile('film.mkv', HEADERS.matroska, ''));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByText('Video details are not available in this browser')).toBeInTheDocument();
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['unsupported type', makeFile('notes.txt', HEADERS.html, 'text/plain'), 'This file type is not supported', /Choose a video in one of these formats/],
    ['oversized', makeFile('big.mp4', HEADERS.mp4, 'video/mp4', 20 * MB), 'This file is too large', /limit is 10\.0 MB/],
    ['empty', makeFile('a.mp4', new Uint8Array(0)), 'This file is empty', /original video file/],
    ['wrong content', makeFile('fake.mp4', HEADERS.html), 'This does not look like a valid video', /may be damaged or renamed/],
  ])('shows what/why/fix for %s and allows retry', async (_n, file, title, body) => {
    render(<UploadDropzone ingestion={ingestionWith()} maxBytes={10 * MB} />);
    drop(file);
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'failed'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(body);
    expect(screen.getByRole('button', { name: 'Choose another video' })).toBeEnabled();
  });

  it('does not leak internal error details on unexpected failure', async () => {
    const processor: MediaProcessor = { extractMetadata: async () => { throw new Error('ENOENT /Users/secret/path'); } };
    render(<UploadDropzone ingestion={ingestionWith(processor)} />);
    drop(makeFile('a.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not prepare this video'));
    expect(document.body).not.toHaveTextContent('secret');
  });

  it('can recover: a failed attempt followed by a valid file reaches ready', async () => {
    render(<UploadDropzone ingestion={ingestionWith()} />);
    drop(makeFile('a.txt', HEADERS.html, 'text/plain'));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'failed'));
    drop(makeFile('a.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
  });

  it('ignores drops and disables the picker while disabled', () => {
    render(<UploadDropzone ingestion={ingestionWith()} disabled />);
    expect(screen.getByRole('button', { name: 'Choose video' })).toBeDisabled();
    expect(group()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.dragOver(group());
    expect(group()).toHaveAttribute('data-state', 'idle');
    drop(makeFile('a.mp4', HEADERS.mp4));
    expect(group()).toHaveAttribute('data-state', 'idle');
  });

  it('ignores drops while busy', async () => {
    const processor: MediaProcessor = { extractMetadata: () => new Promise(() => undefined) };
    render(<UploadDropzone ingestion={ingestionWith(processor)} />);
    drop(makeFile('a.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'processing'));
    drop(makeFile('b.mp4', HEADERS.mp4));
    expect(screen.getByText('a.mp4')).toBeInTheDocument();
    expect(screen.queryByText('b.mp4')).not.toBeInTheDocument();
  });
});

describe('UploadDropzone with a server uploader', () => {
  const serverAsset = () => ({
    id: 'srv-1', filename: 'clip.mp4', mimeType: 'video/mp4', container: 'mp4' as const, typeLabel: 'MP4 video', sizeBytes: 2048,
    status: 'ready' as const, metadata: { ...ffprobeMeta, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, hasSubtitles: false }, createdAt: 'x', failure: null,
  });

  it('shows REAL upload progress, then preparing, then Media ready / Analysis not started with server facts', async () => {
    let progress!: (n: number) => void;
    let finish!: () => void;
    const uploader: MediaUploader = {
      upload: (_f, h) => new Promise((resolve) => {
        progress = (n) => h?.onProgress?.(n);
        finish = () => resolve({ asset: serverAsset(), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } });
      }),
      waitForExtraction: neverSettles, waitForTextAnalysis: neverSettles, remove: vi.fn(async () => undefined),
    };
    render(<UploadDropzone ingestion={createMediaIngestion({ uploader, maxBytes: 10 * MB })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Uploading your video' })).toBeInTheDocument());
    expect(screen.getByRole('progressbar', { name: 'Uploading video' })).toHaveAttribute('aria-valuenow', '0');

    act(() => progress(0.43));
    expect(screen.getByRole('progressbar', { name: 'Uploading video' })).toHaveAttribute('aria-valuenow', '43');
    expect(screen.getByText('43%')).toBeInTheDocument();

    act(() => progress(1)); // bytes sent; server is now inspecting: no measurable progress
    expect(screen.getByRole('heading', { name: 'Preparing your media...' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Preparing your media' })).not.toHaveAttribute('aria-valuenow');

    await act(async () => finish());
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByRole('heading', { name: 'Media ready' })).toBeInTheDocument();
    for (const t of ['2:05', '1920×1080', '29.97 fps', 'H264', 'AAC']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getAllByText('None').length).toBeGreaterThan(0); // subtitles: none
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();
    expect(screen.getByText(/uploaded to the SafeWatch server and is deleted automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/stays on your device/)).not.toBeInTheDocument();
  });

  it('never shows a fabricated percentage before real progress arrives', async () => {
    const uploader: MediaUploader = { upload: () => new Promise(() => undefined), waitForExtraction: neverSettles, waitForTextAnalysis: neverSettles, remove: vi.fn(async () => undefined) };
    render(<UploadDropzone ingestion={createMediaIngestion({ uploader, maxBytes: 10 * MB })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'processing'));
    expect(screen.getByText('0%')).toBeInTheDocument(); // honest starting point; nothing is simulated
    expect(screen.queryByText(/^[1-9]\d?%$/)).not.toBeInTheDocument();
  });

  it.each([
    ['server-unreachable', 'We could not reach the SafeWatch server', /npm run dev:server/],
    ['server-busy', 'SafeWatch is busy right now', /try again/i],
    ['upload-failed', 'The upload did not finish', /connection/i],
    ['invalid-media', 'This does not look like a valid video', /damaged or renamed/],
    ['timeout', 'Preparing took too long', /try again/i],
    ['storage-failure', 'We could not store this video', /try again/i],
  ] as const)('maps server failure %s to readable copy', async (code, title, body) => {
    const uploader: MediaUploader = { upload: async () => { throw new MediaIngestionError(code); }, waitForExtraction: neverSettles, waitForTextAnalysis: neverSettles, remove: vi.fn(async () => undefined) };
    render(<UploadDropzone ingestion={createMediaIngestion({ uploader, maxBytes: 10 * MB })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(title));
    expect(screen.getByRole('alert')).toHaveTextContent(body);
    expect(screen.getByRole('button', { name: 'Choose another video' })).toBeEnabled();
  });

  it('releases the previous server upload when the user chooses a different video', async () => {
    const remove = vi.fn(async () => undefined);
    const uploader: MediaUploader = { upload: async () => ({ asset: serverAsset(), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } }), waitForExtraction: neverSettles, waitForTextAnalysis: neverSettles, remove };
    render(<UploadDropzone ingestion={createMediaIngestion({ uploader, maxBytes: 10 * MB })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    drop(makeFile('other.mp4', HEADERS.mp4));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('srv-1'));
  });
});

describe('UploadDropzone extraction (analysis assets) — separate from upload', () => {
  const readyAsset = () => ({
    id: 'srv-1', filename: 'clip.mp4', mimeType: 'video/mp4', container: 'mp4' as const, typeLabel: 'MP4 video', sizeBytes: 2048,
    status: 'ready' as const, metadata: ffprobeMeta, createdAt: 'x', failure: null,
  });
  const withExtraction = (waitForExtraction: MediaUploader['waitForExtraction']) => {
    const uploader: MediaUploader = {
      upload: async () => ({ asset: readyAsset(), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } }),
      waitForExtraction, waitForTextAnalysis: neverSettles, remove: vi.fn(async () => undefined),
    };
    return createMediaIngestion({ uploader, maxBytes: 10 * MB });
  };

  it('shows MEDIA READY immediately and tracks extraction as its own phase-based step (no percentages)', async () => {
    let push!: (e: ReturnType<typeof processingExtraction>) => void;
    let finish!: () => void;
    const ingestion = withExtraction((id, hooks) => new Promise((resolve) => {
      push = (e) => hooks?.onUpdate?.(e);
      finish = () => { const done = completedExtraction(id); hooks?.onUpdate?.(done); resolve(done); };
    }));
    render(<UploadDropzone ingestion={ingestion} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));

    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByRole('heading', { name: 'Media ready' })).toBeInTheDocument();
    expect(screen.getByText('Preparing analysis assets')).toBeInTheDocument();
    expect(screen.getByText('Media: ready')).toBeInTheDocument();
    expect(screen.getByText('Extraction: queued')).toBeInTheDocument();
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();

    act(() => push(processingExtraction('srv-1', 'extracting-subtitles')));
    expect(screen.getByText('Extraction: in progress')).toBeInTheDocument();
    expect(screen.getByText(/Extracting subtitles…/)).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(expect.arrayContaining(['Audio ready', 'Subtitles in progress', 'Frames waiting']));
    expect(screen.getByRole('progressbar', { name: 'Preparing analysis assets' })).not.toHaveAttribute('aria-valuenow'); // never a fabricated number
    expect(document.body.textContent).not.toMatch(/\d+%/);

    await act(async () => finish());
    expect(await screen.findByText('Media prepared. Ready for SafeWatch analysis.')).toBeInTheDocument();
    expect(screen.getByText('Extraction: completed')).toBeInTheDocument();
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();
    expect(screen.getByText(/has not analyzed this video yet/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/is safe|analysis complete/i);
  });

  it('summarises tracks, frames and preparation time, with expandable details', async () => {
    render(<UploadDropzone ingestion={withExtraction(async (id) => completedExtraction(id))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Media prepared. Ready for SafeWatch analysis.');
    const panel = screen.getByRole('region', { name: 'Analysis assets' });
    expect(panel).toHaveTextContent('Audio1 track');
    expect(panel).toHaveTextContent('Subtitles1 track');
    expect(panel).toHaveTextContent('Frames2 sampled');
    expect(panel).toHaveTextContent('Prepared in1.2 s');
    const details = screen.getByText('Extraction details');
    expect(details.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(details);
    expect(details.closest('details')).toHaveAttribute('open');
    expect(panel).toHaveTextContent('English');
    expect(panel).toHaveTextContent('AAC → WAV 16 kHz mono');
    expect(panel).toHaveTextContent('Spanish');
    expect(panel).toHaveTextContent('2 cues');
    expect(panel).toHaveTextContent('about every 10 s');
    expect(panel).toHaveTextContent('JPEG');
  });

  it('shows image subtitles as unsupported, never as text, and lists skipped items', async () => {
    const { subtitleTrack } = await import('@/test/extraction');
    const manifest = (id: string) => completedExtraction(id, {
      subtitles: [subtitleTrack({ id: 'sub-0', kind: 'image', codec: 'hdmv_pgs_subtitle', textExtraction: 'unsupported', cueCount: 0, cues: [], language: 'jpn' })],
      errors: [{ code: 'frame-unavailable', stage: 'frames', fatal: false, streamIndex: null }],
    });
    render(<UploadDropzone ingestion={withExtraction(async (id) => manifest(id))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Media prepared. Ready for SafeWatch analysis.');
    await userEvent.click(screen.getByText('Extraction details'));
    const panel = screen.getByRole('region', { name: 'Analysis assets' });
    expect(panel).toHaveTextContent('Japanese');
    expect(panel).toHaveTextContent('image subtitles (HDMV_PGS_SUBTITLE), not readable as text');
    expect(panel).toHaveTextContent('Some items were skipped');
    expect(panel).toHaveTextContent('a sampled moment had no frame');
  });

  it('renders untrusted track titles as inert text, never as HTML', async () => {
    const { audioAsset } = await import('@/test/extraction');
    const evil = '<img src=x onerror=alert(1)><script>window.__pwned=1</script>';
    render(<UploadDropzone ingestion={withExtraction(async (id) => completedExtraction(id, { audio: [audioAsset({ title: evil })] }))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Media prepared. Ready for SafeWatch analysis.');
    await userEvent.click(screen.getByText('Extraction details'));
    expect(screen.getByRole('region', { name: 'Analysis assets' })).toHaveTextContent(evil);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('zero audio and subtitle tracks are shown plainly', async () => {
    render(<UploadDropzone ingestion={withExtraction(async (id) => completedExtraction(id, { audio: [], subtitles: [] }))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Media prepared. Ready for SafeWatch analysis.');
    await userEvent.click(screen.getByText('Extraction details'));
    expect(screen.getByText('No audio track.')).toBeInTheDocument();
    expect(screen.getByText('No subtitle track.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Analysis assets' })).toHaveTextContent('Audio0 tracks');
  });

  it.each([
    ['timeout', 'Preparing analysis assets took too long', /shorter video/],
    ['limit-exceeded', 'This video is too large to prepare', /extraction limit/],
    ['server-busy', 'SafeWatch is busy preparing other videos', /try again/i],
    ['extraction-failed', 'Analysis assets could not be prepared', /uploading the video again/],
  ] as const)('a failed extraction (%s) is its own error and media stays READY', async (code, title, body) => {
    render(<UploadDropzone ingestion={withExtraction(async (id) => unavailableExtraction(id, 'x', code))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(title));
    expect(screen.getByRole('alert')).toHaveTextContent(body);
    expect(screen.getByRole('alert')).toHaveTextContent('Your media is still stored and ready.');
    expect(group()).toHaveAttribute('data-state', 'ready');
    expect(screen.getByRole('heading', { name: 'Media ready' })).toBeInTheDocument();
    expect(screen.getByText('Media: ready')).toBeInTheDocument();
    expect(screen.getByText('Extraction: failed')).toBeInTheDocument();
    expect(screen.queryByText('Media prepared. Ready for SafeWatch analysis.')).not.toBeInTheDocument();
  });

  it('losing the server while following extraction is reported as an extraction problem, not a media failure', async () => {
    render(<UploadDropzone ingestion={withExtraction(async () => { throw new MediaIngestionError('server-unreachable'); })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We lost contact with the SafeWatch server'));
    expect(group()).toHaveAttribute('data-state', 'ready');
  });

  it('ignores extraction updates from a replaced upload', async () => {
    let first!: (e: ReturnType<typeof processingExtraction>) => void;
    const ingestion = withExtraction((id, hooks) => new Promise(() => { if (!first) first = (e) => hooks?.onUpdate?.({ ...e, mediaId: id }); }));
    render(<UploadDropzone ingestion={ingestion} />);
    drop(makeFile('one.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    drop(makeFile('two.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    act(() => first(processingExtraction('srv-1', 'sampling-frames')));
    expect(screen.queryByText(/Sampling frames…/)).not.toBeInTheDocument();
  });

  it('browser-only mode shows no extraction UI (nothing is extracted locally)', async () => {
    render(<UploadDropzone ingestion={ingestionWith()} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    expect(screen.queryByRole('region', { name: 'Analysis assets' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Extraction:/)).not.toBeInTheDocument();
  });
});

describe('UploadDropzone text evidence (transcript) — a separate step after extraction', () => {
  const readyAsset = () => ({
    id: 'srv-1', filename: 'clip.mp4', mimeType: 'video/mp4', container: 'mp4' as const, typeLabel: 'MP4 video', sizeBytes: 2048,
    status: 'ready' as const, metadata: ffprobeMeta, createdAt: 'x', failure: null,
  });
  const ingestionWith = (text: MediaUploader['waitForTextAnalysis'], extraction: MediaUploader['waitForExtraction'] = async (id) => completedExtraction(id)) =>
    createMediaIngestion({
      uploader: { upload: async () => ({ asset: readyAsset(), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } }), waitForExtraction: extraction, waitForTextAnalysis: text, remove: vi.fn(async () => undefined) },
      maxBytes: 10 * MB,
    });

  it('starts only after extraction completed, shows phases, then the transcript, with Analysis still NOT started', async () => {
    window.localStorage.clear(); filtersStore.reload();
    let push!: (t: ReturnType<typeof processingTextAnalysis>) => void;
    let finish!: () => void;
    render(<UploadDropzone ingestion={ingestionWith((id, hooks) => new Promise((resolve) => {
      push = (t) => hooks?.onUpdate?.(t);
      finish = () => { const done = readyTextAnalysis(id); hooks?.onUpdate?.(done); resolve(done); };
    }))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Media prepared. Ready for SafeWatch analysis.');
    expect(screen.getByText('Text: queued')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Transcript' })).toHaveTextContent('Waiting to transcribe…');
    act(() => push(processingTextAnalysis('srv-1', 'speech-processing')));
    expect(screen.getByText('Text: in progress')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Transcript' })).toHaveTextContent('Transcribing speech…');
    await act(async () => finish());
    expect(await screen.findByText('Text: ready')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Transcript' })).toHaveTextContent('Subtitles2 cues');
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();
    expect(screen.getByText('Media: ready')).toBeInTheDocument();
    // It must never CLAIM safety (the disclaimer "has not judged whether anything is safe" is the opposite of a claim).
    expect(document.body.textContent).not.toMatch(/(video|media|content) (is|are) (safe|unsafe)|analysis (is )?complete|\bunsafe\b/i);
  });

  it('does not start text analysis when extraction failed', async () => {
    const text = vi.fn(async () => readyTextAnalysis('srv-1'));
    render(<UploadDropzone ingestion={ingestionWith(text, async (id) => unavailableExtraction(id, 'x', 'timeout'))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('took too long'));
    expect(text).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Transcript' })).not.toBeInTheDocument();
  });

  it('a failure of the text step is its own error and leaves media ready and extraction completed', async () => {
    render(<UploadDropzone ingestion={ingestionWith(async () => { throw new MediaIngestionError('server-unreachable'); })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Transcript' })).toHaveTextContent('We lost contact with the SafeWatch server'));
    expect(screen.getByText('Text: failed')).toBeInTheDocument();
    expect(screen.getByText('Extraction: completed')).toBeInTheDocument();
    expect(screen.getByText('Media: ready')).toBeInTheDocument();
  });

  it('shows matches for the user’s custom filters inside the transcript', async () => {
    window.localStorage.clear(); filtersStore.reload();
    filtersStore.add('SafeWatch', 'phrase');
    render(<UploadDropzone ingestion={ingestionWith(async (id) => readyTextAnalysis(id))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Text: ready');
    const rows = screen.getAllByRole('listitem').filter((li) => li.className.includes('sw-match'));
    expect(rows).toHaveLength(2);
  });
});

describe('UploadDropzone visual evidence — a separate step after extraction, independent of the text step', () => {
  const readyAsset = () => ({
    id: 'srv-1', filename: 'clip.mp4', mimeType: 'video/mp4', container: 'mp4' as const, typeLabel: 'MP4 video', sizeBytes: 2048,
    status: 'ready' as const, metadata: ffprobeMeta, createdAt: 'x', failure: null,
  });
  const ingestionWith = (visual: MediaUploader['waitForVisualAnalysis'], text: MediaUploader['waitForTextAnalysis'] = async (id) => readyTextAnalysis(id), extraction: MediaUploader['waitForExtraction'] = async (id) => completedExtraction(id)) =>
    createMediaIngestion({
      uploader: { upload: async () => ({ asset: readyAsset(), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } }), waitForExtraction: extraction, waitForTextAnalysis: text, waitForVisualAnalysis: visual, remove: vi.fn(async () => undefined) },
      maxBytes: 10 * MB,
    });

  it('starts after extraction, shows real frame progress, then the frames, with Analysis still NOT started', async () => {
    let push!: (v: ReturnType<typeof processingVisual>) => void;
    let finish!: () => void;
    render(<UploadDropzone ingestion={ingestionWith((id, hooks) => new Promise((resolve) => {
      push = (v) => hooks?.onUpdate?.(v);
      finish = () => { const done = readyVisual(id); hooks?.onUpdate?.(done); resolve(done); };
    }))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Media prepared. Ready for SafeWatch analysis.');
    expect(screen.getByText('Visual: queued')).toBeInTheDocument();
    act(() => push(processingVisual('srv-1', 'analyzing-frames', { framesDone: 1, framesTotal: 3 })));
    expect(screen.getByText('Visual: in progress')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Visual evidence' })).toHaveTextContent('Looking at frame 2 of 3…');
    await act(async () => finish());
    expect(await screen.findByText('Visual: ready')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Sampled frames' })).toBeInTheDocument();
    expect([...document.querySelectorAll('img')].some((i) => i.getAttribute('src')?.endsWith('/api/media/srv-1/frames/frm-00000'))).toBe(true);
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(video|media|content) (is|are) (safe|unsafe)|analysis (is )?complete|\bunsafe\b/i);
  });

  it('runs side by side with the text step: a slow transcript does not delay visual evidence', async () => {
    render(<UploadDropzone ingestion={ingestionWith(async (id) => readyVisual(id), () => new Promise(() => undefined))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    expect(await screen.findByText('Visual: ready')).toBeInTheDocument();
    expect(screen.getByText('Text: queued')).toBeInTheDocument();
  });

  it('a failure of the visual step is its own error and leaves media ready, extraction completed and text intact', async () => {
    render(<UploadDropzone ingestion={ingestionWith(async () => { throw new MediaIngestionError('server-unreachable'); })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Visual evidence' })).toHaveTextContent('We lost contact with the SafeWatch server'));
    expect(screen.getByText('Visual: failed')).toBeInTheDocument();
    expect(await screen.findByText('Text: ready')).toBeInTheDocument();
    expect(screen.getByText('Extraction: completed')).toBeInTheDocument();
    expect(screen.getByText('Media: ready')).toBeInTheDocument();
  });

  it('does not start visual analysis when extraction failed', async () => {
    const visual = vi.fn(async () => readyVisual('srv-1'));
    render(<UploadDropzone ingestion={ingestionWith(visual, undefined, async (id) => unavailableExtraction(id, 'x', 'timeout'))} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('took too long'));
    expect(visual).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Visual evidence' })).not.toBeInTheDocument();
  });

  it('an uploader without visual support reports visual analysis as not enabled instead of waiting forever', async () => {
    render(<UploadDropzone ingestion={ingestionWith(undefined)} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await screen.findByText('Text: ready');
    expect(await screen.findByText('Visual: not enabled')).toBeInTheDocument();
  });
});
