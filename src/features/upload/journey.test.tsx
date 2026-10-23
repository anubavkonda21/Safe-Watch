import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { createMediaIngestion } from '@/application/mediaIngestion';
import type { MediaUploader } from '@/application/mediaUploader';
import { normalizeMetadata } from '@/domain/media/metadata';
import { appliedStore } from '@/features/filters/appliedStore';
import { filtersStore } from '@/features/filters/filtersStore';
import { feedbackStore } from '@/features/feedback/feedbackStore';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import { readyContext } from '@/test/contextAnalysis';
import { completedExtraction } from '@/test/extraction';
import { HEADERS, makeFile } from '@/test/files';
import { installFakeVideo } from '@/test/media';
import { analysisWith, finding } from '@/test/safetyFindings';
import { readyTextAnalysis } from '@/test/textAnalysis';
import { readyVisual } from '@/test/visualAnalysis';
import { UploadDropzone } from './UploadDropzone';
import { ProductGuide } from './ProductGuide';

/**
 * The whole path a person takes: choose a video, list a phrase, see the evidence and findings, get a heads-up, choose Skip,
 * watch it be skipped, and report a phrase that was missed. Everything is real code except the server answers (the uploader).
 */
const MB = 1024 * 1024;
const meta = normalizeMetadata({ durationSeconds: 125, width: 1920, height: 1080, frameRate: 29.97 }, 'ffprobe');
const asset = () => ({ id: 'srv-1', filename: 'clip.mp4', mimeType: 'video/mp4', container: 'mp4' as const, typeLabel: 'MP4 video', sizeBytes: 2048, status: 'ready' as const, metadata: meta, createdAt: 'x', failure: null });

const CUE = finding({
  id: 'sf-flagged-terms-0000', startMs: 30_000, endMs: 32_000, warnings: ['coarse-timing'], attributes: { term: 'darn', matchMode: 'word-boundary', matchedText: 'darn' },
  evidence: [{ evidenceId: 'sub-sub-0-3', modality: 'subtitle', kind: 'subtitle', startMs: 30_000, endMs: 32_000, sourceId: 'sub-0', contextEventId: 'ctx-0001', sourceConfidence: null }],
});

function ingestion(over: Partial<MediaUploader> = {}) {
  const requests: Array<{ terms: unknown }> = [];
  const i = createMediaIngestion({
    uploader: {
      upload: async () => ({ asset: asset(), analysis: { status: 'not_started' }, extraction: { status: 'queued', phase: null }, text: { status: 'not_started', phase: null }, visual: { status: 'not_started', phase: null, progress: null } }),
      waitForExtraction: async (id) => completedExtraction(id), waitForTextAnalysis: async (id) => readyTextAnalysis(id), waitForVisualAnalysis: async (id) => readyVisual(id),
      loadContext: async (id) => readyContext(id),
      loadSafetyFindings: async (_id, terms) => { requests.push({ terms }); return analysisWith(terms.length > 0 ? [CUE] : []); },
      remove: async () => undefined, ...over,
    },
    maxBytes: 10 * MB,
  });
  return { ingestion: i, requests };
}

beforeEach(() => {
  window.localStorage.clear(); filtersStore.reload(); preferencesStore.reload(); feedbackStore.reload(); appliedStore.reset();
  URL.createObjectURL = vi.fn(() => 'blob:journey'); URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const drop = (file: File) => fireEvent.drop(screen.getByRole('group', { name: /Drop a video|Media ready|Checking/ }) , { dataTransfer: { files: [file] } });

describe('the complete journey', () => {
  it('from choosing a video to a skipped finding and a saved report, with honest statements all the way', async () => {
    const { ingestion: ing, requests } = ingestion();
    render(<><UploadDropzone ingestion={ing} /><ProductGuide /></>);

    // 1. What SafeWatch can and cannot do is visible before anything is chosen.
    const guide = screen.getByRole('complementary', { name: 'What SafeWatch does today' });
    expect(guide).toHaveTextContent('Your own words and phrases, in speech and subtitles.');
    expect(guide).toHaveTextContent('sexual content, violence, graphic injury or gore, drug-related content');
    expect(guide).toHaveTextContent('Finding nothing does not mean a video is safe');

    // 2. The user lists a phrase (the same store the Custom filters section uses), then chooses a video.
    filtersStore.add('darn', 'word-boundary');
    drop(makeFile('clip.mp4', HEADERS.mp4));
    const player = (await screen.findByLabelText('Uploaded video preview')) as HTMLVideoElement;
    const fake = installFakeVideo(player, 125);
    await act(async () => { fake.loaded(); });

    // 3. Evidence availability and status are stated in the app's real words; the server was asked about the enabled phrase only.
    const evidence = await screen.findByRole('group', { name: 'Evidence available for this video' }, { timeout: 3000 }).catch(() => screen.getByLabelText('Evidence available for this video'));
    expect(evidence).toHaveTextContent('Speech');
    expect(evidence).toHaveTextContent('available');
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests.at(-1)).toEqual({ terms: [{ phrase: 'darn', matchMode: 'word-boundary' }] });
    expect(await screen.findByRole('list', { name: 'Findings' })).toBeInTheDocument();
    expect(screen.getAllByText('Not supported')).toHaveLength(4); // the four unsupported categories stay unsupported
    expect(screen.getByText('Analysis: not started')).toBeInTheDocument();

    // 4. Playing: a heads-up appears 20 seconds ahead and does nothing by itself.
    await act(async () => { await fake.advanceTo(10); });
    const card = screen.getByRole('group', { name: 'Upcoming flagged phrase' });
    expect(card).toHaveTextContent('A flagged phrase is coming up.');
    expect(card).toHaveTextContent('“darn”');
    expect(fake.seeks).toEqual([]);

    // 5. The user chooses Skip; the CP8 skip then happens at the interval, once.
    fireEvent.click(within(card).getByRole('button', { name: 'Skip' }));
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).not.toBeInTheDocument();
    await act(async () => { await fake.advanceTo(31); });
    expect(fake.seeks).toEqual([32]);

    // 6. A missed phrase is reported: a local note, separate from the findings.
    const findingsBefore = within(screen.getByRole('list', { name: 'Findings' })).getAllByRole('listitem').length;
    await userEvent.click(screen.getByRole('button', { name: 'Report a missed phrase' }));
    const dialog = screen.getByRole('dialog', { name: 'Report a missed phrase' });
    expect(within(dialog).getByLabelText('Time in the video')).toHaveValue('0:32.0');
    await userEvent.type(within(dialog).getByLabelText('Missed word or phrase'), 'heck');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
    expect(screen.getByRole('list', { name: 'Your saved reports' })).toHaveTextContent('“heck”');
    expect(within(screen.getByRole('list', { name: 'Findings' })).getAllByRole('listitem')).toHaveLength(findingsBefore);
    expect(JSON.parse(window.localStorage.getItem('safewatch.feedback.v1')!)).toHaveLength(1);
  });

  it('without any phrase listed: the analysis abstains, nothing is warned about, and nothing is called clean', async () => {
    const { ingestion: ing } = ingestion();
    render(<UploadDropzone ingestion={ing} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    const player = (await screen.findByLabelText('Uploaded video preview')) as HTMLVideoElement;
    const fake = installFakeVideo(player, 125);
    await act(async () => { fake.loaded(); });
    await screen.findAllByText(/no flagged terms are listed/);
    await act(async () => { await fake.advanceTo(35); });
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(clean|all clear)\b|100% protected|(video|media|content|scene) is safe/i);
  });

  it('when the server cannot provide findings: playback is untouched, nothing is warned, the state is stated', async () => {
    const { ingestion: ing } = ingestion({ loadSafetyFindings: async () => { throw new Error('down'); } });
    filtersStore.add('darn', 'word-boundary');
    render(<UploadDropzone ingestion={ing} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    expect(await screen.findByText('Safety classification is not available')).toBeInTheDocument();
    expect(await screen.findByText('Safety findings are not available, so there is nothing to act on. Playback is not affected.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Upcoming flagged phrase' })).not.toBeInTheDocument();
    await waitFor(() => expect(appliedStore.getSnapshot().status).toBe('failed'));
  });

  it('reports no network traffic of its own for the local features: no third-party request is ever made', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    const { ingestion: ing } = ingestion();
    filtersStore.add('darn', 'word-boundary');
    render(<UploadDropzone ingestion={ing} />);
    drop(makeFile('clip.mp4', HEADERS.mp4));
    const player = (await screen.findByLabelText('Uploaded video preview')) as HTMLVideoElement;
    const fake = installFakeVideo(player, 125);
    await act(async () => { fake.loaded(); await fake.advanceTo(12); });
    await userEvent.click(screen.getByRole('button', { name: 'Report a missed phrase' }));
    await userEvent.type(screen.getByLabelText('Missed word or phrase'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));
    expect(fetchSpy).not.toHaveBeenCalled(); // the uploader here is a stub; the warning, preferences and feedback code make no requests of their own
  });
});
