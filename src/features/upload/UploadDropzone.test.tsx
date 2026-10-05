import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMediaIngestion } from '@/application/mediaIngestion';
import type { MediaProcessor } from '@/application/mediaProcessor';
import type { MediaUploader } from '@/application/mediaUploader';
import { MediaIngestionError } from '@/domain/media/errors';
import { normalizeMetadata } from '@/domain/media/metadata';
import { HEADERS, makeFile } from '@/test/files';
import { UploadDropzone } from './UploadDropzone';

const MB = 1024 * 1024;
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
        finish = () => resolve({ asset: serverAsset(), analysis: { status: 'not_started' } });
      }),
      remove: vi.fn(async () => undefined),
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
    for (const t of ['2:05', '1920×1080', '29.97 fps', 'H264', 'AAC', 'None']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();
    expect(screen.getByText(/uploaded to the SafeWatch server and is stored temporarily/)).toBeInTheDocument();
    expect(screen.queryByText(/stays on your device/)).not.toBeInTheDocument();
  });

  it('never shows a fabricated percentage before real progress arrives', async () => {
    const uploader: MediaUploader = { upload: () => new Promise(() => undefined), remove: vi.fn(async () => undefined) };
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
    const uploader: MediaUploader = { upload: async () => { throw new MediaIngestionError(code); }, remove: vi.fn(async () => undefined) };
    render(<UploadDropzone ingestion={createMediaIngestion({ uploader, maxBytes: 10 * MB })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(title));
    expect(screen.getByRole('alert')).toHaveTextContent(body);
    expect(screen.getByRole('button', { name: 'Choose another video' })).toBeEnabled();
  });

  it('releases the previous server upload when the user chooses a different video', async () => {
    const remove = vi.fn(async () => undefined);
    const uploader: MediaUploader = { upload: async () => ({ asset: serverAsset(), analysis: { status: 'not_started' } }), remove };
    render(<UploadDropzone ingestion={createMediaIngestion({ uploader, maxBytes: 10 * MB })} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    await waitFor(() => expect(group()).toHaveAttribute('data-state', 'ready'));
    drop(makeFile('other.mp4', HEADERS.mp4));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('srv-1'));
  });
});
