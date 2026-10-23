import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import { createMediaIngestion, type MediaIngestion } from '@/application/mediaIngestion';
import type { MediaUploader } from '@/application/mediaUploader';
import { PENDING_METADATA, type MediaAsset } from '@/domain/media/asset';
import type { SafetyAnalysis } from '@/domain/safety/finding';
import { appliedStore } from '@/features/filters/appliedStore';
import { filtersStore, termsKey } from '@/features/filters/filtersStore';
import { safetyFor } from '@/test/safetyAnalysis';
import { SafetyPanel } from './SafetyPanel';

beforeEach(() => { window.localStorage.clear(); filtersStore.reload(); appliedStore.reset(); });

const asset: MediaAsset = { id: 'm', filename: 'a.mp4', mimeType: 'video/mp4', container: 'mp4', typeLabel: 'MP4 video', sizeBytes: 5, status: 'ready', metadata: PENDING_METADATA, createdAt: 'x', failure: null };
const ingestionWith = (load: MediaUploader['loadSafetyFindings']): MediaIngestion =>
  createMediaIngestion({ uploader: { upload: vi.fn(), waitForExtraction: vi.fn(), waitForTextAnalysis: vi.fn(), loadSafetyFindings: load, remove: vi.fn() } as unknown as MediaUploader, maxBytes: 1 });
const panel = () => screen.getByRole('region', { name: 'Safety classification' });
const render1 = (load: MediaUploader['loadSafetyFindings'], ready = true) => render(<SafetyPanel ingestion={ingestionWith(load)} asset={asset} evidenceReady={ready} />);

describe('SafetyPanel states', () => {
  it('waits, without a percentage, until the evidence steps have finished, and does not call the server before', () => {
    const load = vi.fn(async () => safetyFor('m', []));
    render1(load, false);
    expect(panel()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(load).not.toHaveBeenCalled();
  });
  it('says plainly when the server cannot provide it (a plain notice, not an alarm)', async () => {
    render1(async () => { throw new Error('x'); });
    expect(await screen.findByText('Safety classification is not available')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const { container } = render1(async () => null as never);
    expect(await within(container).findByText('Safety classification is not available')).toBeInTheDocument();
  });
});

describe('SafetyPanel categories (real support, not aspiration)', () => {
  it('lists every category: flagged terms implemented, the other four not supported with the reason available', async () => {
    render1(async () => safetyFor('m', [['safe watch', 'phrase']]));
    const list = await screen.findByRole('list', { name: 'Categories' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => within(i).getByText(/^(Implemented|Not supported)$/).textContent)).toEqual(['Implemented', 'Not supported', 'Not supported', 'Not supported', 'Not supported']);
    expect(items.map((i) => i.querySelector('.sw-cat__name')!.textContent)).toEqual(['Flagged terms', 'Sexual content', 'Violence', 'Graphic injury or gore', 'Drug-related content']);
    for (const i of items.slice(1)) expect(i).toHaveTextContent('Not supported yet. SafeWatch does not check this.');
    await userEvent.click(within(items[2]!).getByText('What this category means'));
    expect(items[2]).toHaveTextContent('Why not supported');
    expect(items[2]).toHaveTextContent('weapon-shaped object');
  });
  it('states what it checks and that there is no score or verdict', async () => {
    render1(async () => safetyFor('m', [['safe watch', 'phrase']]));
    await screen.findByRole('list', { name: 'Categories' });
    expect(panel()).toHaveTextContent('Only flagged words in speech and subtitles are checked today');
    expect(panel()).toHaveTextContent('no overall score and no verdict');
    expect(panel()).toHaveTextContent('It does not say what the sentence means or whether anything is acceptable');
  });
  it('a negative result is scoped: "no flagged terms found in speech and subtitles", not "clean"', async () => {
    render1(async () => safetyFor('m', [['nonexistentword', 'word-boundary']]));
    expect(await screen.findByText(/No flagged terms found in speech and subtitles\. This covers only what was transcribed or subtitled\./)).toBeInTheDocument();
    expect(panel()).toHaveTextContent('none of the listed words occur in the checked text, not that the video has been judged');
    expect(screen.queryByRole('list', { name: 'Findings' })).not.toBeInTheDocument();
  });
  it('abstains visibly when no terms are listed, instead of showing a clean result', async () => {
    render1(async () => safetyFor('m', []));
    expect(await screen.findAllByText(/no flagged terms are listed/)).not.toHaveLength(0);
    expect(panel()).not.toHaveTextContent('No flagged terms found');
  });
  it('partial: names the modality that could not be checked', async () => {
    render1(async () => safetyFor('m', [['safe watch', 'phrase']], { visual: null }));
    await screen.findByRole('list', { name: 'Categories' });
    expect(panel()).toBeInTheDocument();
    const a: SafetyAnalysis = await safetyFor('m', [['nonexistentword', 'word-boundary']]);
    const partial = { ...a, status: 'partial' as const, categories: a.categories.map((c) => (c.category === 'flagged-terms' ? { ...c, evaluation: 'partial' as const, reason: 'speech-unavailable' as const, modalities: { evaluated: ['subtitle' as const], missing: ['speech' as const] } } : c)) };
    const { container } = render1(async () => partial);
    expect(await within(container).findByText(/in subtitles only\. speech could not be checked\./i)).toBeInTheDocument();
  });
});

describe('SafetyPanel findings', () => {
  it('shows findings chronologically with category, status, sources and the term', async () => {
    render1(async () => safetyFor('m', [['safe watch', 'phrase']]));
    const list = await screen.findByRole('list', { name: 'Findings' });
    const [first] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Flagged terms');
    expect(first).toHaveTextContent('Detected');
    expect(first).toHaveTextContent('Speech');
    expect(first).toHaveTextContent('Subtitles');
    expect(first).toHaveTextContent('“safe watch”');
    expect(first).toHaveTextContent(/\d:\d\d\.\d\d to \d:\d\d\.\d\d/);
  });
  it('draws a findings timeline and selecting a marker or a card reveals the evidence and why it was found', async () => {
    render1(async () => safetyFor('m', [['safe watch', 'phrase']]));
    const timeline = await screen.findByRole('group', { name: 'Findings timeline' });
    const marks = within(timeline).getAllByRole('button');
    expect(marks[0]).toHaveAccessibleName(/^Finding .* to .*, detected$/);
    expect(screen.getByText('Select a finding to see its evidence.')).toBeInTheDocument();
    await userEvent.click(marks[0]!);
    const card = within(screen.getByRole('list', { name: 'Findings' })).getAllByRole('listitem')[0]!;
    expect(card).toHaveTextContent('both contain the listed term “safe watch”');
    const evidence = within(card).getByRole('list', { name: 'Evidence' });
    expect(evidence).toHaveTextContent('Speech');
    expect(evidence).toHaveTextContent('recognizer confidence 60%');
    expect(evidence).toHaveTextContent('Subtitles');
    expect(evidence).toHaveTextContent('context ctx-0000');
    expect(card).toHaveTextContent('No probability is given: none was measured.');
    expect(card).toHaveTextContent('Found by flagged-terms-matcher (rule based)');
    await userEvent.click(marks[0]!);
    expect(within(card).queryByRole('list', { name: 'Evidence' })).not.toBeInTheDocument();
  });
  it('marks uncertain findings as uncertain, with the reason in plain words', async () => {
    const a = await safetyFor('m', [['safe watch', 'phrase']]);
    const f = a.findings[0]!;
    const uncertain = { ...a, findings: [{ ...f, status: 'uncertain' as const, warnings: ['low-source-confidence' as const, 'subtitle-disagrees' as const, 'coarse-timing' as const], evidence: [f.evidence[0]!] }] };
    render1(async () => uncertain);
    await userEvent.click(await screen.findByRole('button', { name: /Finding .*, uncertain/ }));
    const card = within(screen.getByRole('list', { name: 'Findings' })).getAllByRole('listitem')[0]!;
    expect(card).toHaveTextContent('Uncertain');
    expect(card).toHaveTextContent('Speech recognition was unsure about these words.');
    expect(card).toHaveTextContent('The subtitles shown at that time do not contain the term.');
    expect(card).toHaveTextContent('Timing covers the whole line, not the single word.');
  });
  it('keeps hostile text inert: markup from terms or evidence is rendered as plain text', async () => {
    const a = await safetyFor('m', [['safe watch', 'phrase']]);
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const f = a.findings[0]!;
    render1(async () => ({ ...a, findings: [{ ...f, explanation: hostile, attributes: { ...f.attributes!, term: hostile } }] }));
    await userEvent.click(await screen.findByRole('button', { name: /Finding / , expanded: false }).catch(() => screen.getByRole('button', { name: /^Finding / })));
    expect(panel()).toHaveTextContent(hostile);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});

describe('SafetyPanel and the user’s flagged terms', () => {
  it('sends only the ENABLED terms (phrase and mode) and asks again when they change', async () => {
    filtersStore.add('safe watch', 'phrase');
    filtersStore.add('ignored', 'word-boundary');
    filtersStore.toggle(filtersStore.getSnapshot()[1]!.id);
    const load = vi.fn(async (_id: string, terms: ReadonlyArray<{ phrase: string; matchMode: string }>) => safetyFor('m', terms.map((t) => [t.phrase, t.matchMode as 'phrase'])));
    render1(load);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[0]![0]).toBe('m');
    expect(load.mock.calls[0]![1]).toEqual([{ phrase: 'safe watch', matchMode: 'phrase' }]);
    expect(await screen.findByRole('list', { name: 'Findings' })).toBeInTheDocument();
    act(() => { filtersStore.add('test', 'word-boundary'); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]![1]).toEqual([{ phrase: 'safe watch', matchMode: 'phrase' }, { phrase: 'test', matchMode: 'word-boundary' }]);
  });
  it('ignores a slow answer for terms that were changed in the meantime', async () => {
    const resolvers: Array<(a: SafetyAnalysis) => void> = [];
    const load = vi.fn(() => new Promise<SafetyAnalysis>((resolve) => { resolvers.push(resolve); }));
    filtersStore.add('first', 'word-boundary');
    render1(load);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    act(() => { filtersStore.add('second', 'word-boundary'); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => { resolvers[0]!(await safetyFor('m', [['first', 'word-boundary']])); });
    expect(panel()).toHaveAttribute('aria-busy', 'true');
    await act(async () => { resolvers[1]!(await safetyFor('m', [['safe watch', 'phrase']])); });
    expect(await screen.findByRole('list', { name: 'Findings' })).toBeInTheDocument();
  });
});

describe('SafetyPanel vocabulary', () => {
  it('never shows a score, a verdict or a blanket label', async () => {
    render1(async () => safetyFor('m', [['safe watch', 'phrase']]));
    await screen.findByRole('list', { name: 'Findings' });
    const own = [...panel().querySelectorAll('.sw-label, .sw-safety__lead, .sw-cat__name, .sw-cat > .sw-caption, .sw-safety > .sw-caption, .sw-safety > .sw-body-sm')]    .map((n) => n.textContent).join(' ').replace('SafeWatch gives no overall score and no verdict.', '');
    expect(panel().textContent).toContain('no overall score and no verdict'); // the only mention is a denial
    expect(own).not.toMatch(/\b(unsafe|dangerous|verdict|risk|score|rating|passed|failed)\b/i);
    expect(own).not.toMatch(/\b(video|media|content) (is|are) (safe|clean|fine)\b/i);
    expect(panel().textContent).not.toMatch(/\d+\s*\/\s*100|\d+%\s*(safe|unsafe)/i);
  });
});

describe('SafetyPanel reports which phrase list was applied', () => {
  it('pending while asking, then applied with the exact list it asked about; unmounting forgets it', async () => {
    filtersStore.add('safe watch', 'phrase');
    let finish!: () => void;
    const { unmount } = render1(() => new Promise<SafetyAnalysis>((resolve) => { finish = () => resolve(void 0 as never); }));
    await waitFor(() => expect(appliedStore.getSnapshot()).toEqual({ status: 'pending' }));
    unmount();
    expect(appliedStore.getSnapshot()).toEqual({ status: 'idle' });
    void finish;
  });
  it('applied carries the list key; a failed request is reported as failed', async () => {
    filtersStore.add('safe watch', 'phrase');
    const ok = render1(async () => safetyFor('m', [['safe watch', 'phrase']]));
    await waitFor(() => expect(appliedStore.getSnapshot()).toEqual({ status: 'applied', key: termsKey(filtersStore.getSnapshot()) }));
    ok.unmount();
    render1(async () => { throw new Error('x'); });
    await waitFor(() => expect(appliedStore.getSnapshot()).toEqual({ status: 'failed' }));
  });
});
