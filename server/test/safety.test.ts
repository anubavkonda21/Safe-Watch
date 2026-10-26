import type { MediaResponse, SafetyResponse } from '@/domain/api/contract';
import { validateSafetyAnalysis, type SafetyAnalysis } from '@/domain/safety/finding';
import type { RawTranscription } from '@/domain/speech/normalize';
import type { SpeechToTextProvider } from '../src/application/speechPorts';
import type { VisionFrameInput, VisionFrameResult, VisualAnalysisProvider } from '../src/application/visualPorts';
import { FfmpegMediaProcessor } from '../src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { fixture, startTestApp, upload, waitForContext, waitForExtraction, waitForTextAnalysis, waitForVisualAnalysis, type TestApp } from './helpers';

let app: TestApp;
afterEach(async () => { await app?.close(); });

const HELLO: RawTranscription = {
  language: 'en', wordTiming: 'alignment',
  segments: [
    { start: 0.2, end: 2.6, text: ' Hello, this is a SafeWatch test.', confidence: 0.9 },
    { start: 6.5, end: 8.0, text: ' A second, much later sentence.', confidence: 0.3 },
  ],
};
const speech: SpeechToTextProvider = { info: { name: 'fake', model: 'fake-model' }, isAvailable: async () => true, transcribe: async () => HELLO };
const vision: VisualAnalysisProvider = {
  info: { name: 'fake-vision', model: 'fake-model' }, isAvailable: async () => true,
  analyze: async (frames: readonly VisionFrameInput[]): Promise<VisionFrameResult[]> => frames.map((f) => ({
    frameId: f.frameId, error: null, width: 320, height: 240, elapsedMs: 1,
    observations: [{ type: 'object', label: 'person', confidence: 0.94 }, { type: 'text', label: 'text', confidence: 1, text: 'FLAGGEDWORD' }],
  })),
};

async function start(opts: { speech?: SpeechToTextProvider | null; vision?: VisualAnalysisProvider | null } = {}) {
  app = await startTestApp({
    processor: new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }), extraction: { limits: { frame: { intervalSeconds: 3, maxFrames: 300, maxWidth: 320, maxHeight: 320 } } },
    speech: { provider: opts.speech === undefined ? speech : opts.speech }, vision: { provider: opts.vision === undefined ? vision : opts.vision },
  });
  const { media } = (await (await upload(app, new Uint8Array(fixture('speech-subs.mkv')), 'speech-subs.mkv', 'video/x-matroska')).json()) as MediaResponse;
  const id = media.asset.id;
  await waitForExtraction(app, id); await waitForTextAnalysis(app, id); await waitForVisualAnalysis(app, id); await waitForContext(app, id);
  return id;
}
const post = (path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(`${app.url}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const safety = async (res: Response) => ((await res.json()) as SafetyResponse).safety;
const terms = (...t: Array<[string, string]>) => ({ terms: t.map(([phrase, matchMode]) => ({ phrase, matchMode })) });

describe('POST /api/media/:id/safety-findings', () => {
  it('finds a flagged term in the real pipeline output and ties it to evidence, timestamps and context', async () => {
    const id = await start();
    const res = await post(`/api/media/${id}/safety-findings`, terms(['safewatch test', 'phrase']));
    expect(res.status).toBe(200);
    const a = await safety(res);
    expect(a).toMatchObject({ mediaId: id, taxonomyVersion: 'safewatch-taxonomy-1', status: 'ready', termCount: 1 });
    expect(validateSafetyAnalysis(a)).toEqual([]);
    const [f] = a.findings;
    expect(f).toMatchObject({ category: 'flagged-terms', status: 'detected', rawScore: null, calibratedProbability: null, classifier: { id: 'flagged-terms-matcher', kind: 'rule-based' } });
    expect(f!.evidence.map((e) => e.modality).sort()).toEqual(['speech', 'subtitle']);
    expect(f!.evidence.every((e) => e.contextEventId === 'ctx-0000')).toBe(true);
    expect(f!.startMs).toBeGreaterThanOrEqual(0);
    expect(f!.endMs).toBeGreaterThan(f!.startMs);
    expect(f!.explanation).toContain('safewatch test');
  });
  it('reports speech that only the recognizer supports, with low confidence, as uncertain', async () => {
    const id = await start();
    const a = await safety(await post(`/api/media/${id}/safety-findings`, terms(['much later', 'phrase'])));
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ status: 'uncertain' });
    expect(a.findings[0]!.warnings).toContain('low-source-confidence');
    expect(a.findings[0]!.evidence[0]).toMatchObject({ modality: 'speech', sourceConfidence: 0.3 });
  });
  it('does not turn visual observations or on-screen text into findings: OCR is not scanned yet and says so by omission from the modalities', async () => {
    const id = await start();
    const a = await safety(await post(`/api/media/${id}/safety-findings`, terms(['FLAGGEDWORD', 'exact'], ['person', 'word-boundary'])));
    expect(a.findings).toEqual([]);
    expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ evaluation: 'evaluated', findingCount: 0, modalities: { evaluated: ['speech', 'subtitle'], missing: [] } });
  });
  it('lists the whole taxonomy with real support: only flagged terms is implemented', async () => {
    const id = await start();
    const a = await safety(await post(`/api/media/${id}/safety-findings`, terms(['x', 'word-boundary'])));
    expect(a.categories.map((c) => [c.category, c.support, c.evaluation])).toEqual([
      ['flagged-terms', 'implemented', 'evaluated'], ['sexual-content', 'unsupported', 'not-supported'], ['violence', 'unsupported', 'not-supported'],
      ['graphic-injury', 'unsupported', 'not-supported'], ['drug-content', 'unsupported', 'not-supported'],
    ]);
  });
  it('speech not enabled: still scans subtitles, and the result is partial with the missing modality named', async () => {
    const id = await start({ speech: null });
    const a = await safety(await post(`/api/media/${id}/safety-findings`, terms(['quick brown fox', 'phrase'])));
    expect(a.status).toBe('partial');
    expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ evaluation: 'partial', reason: 'speech-unavailable', modalities: { evaluated: ['subtitle'], missing: ['speech'] }, findingCount: 1 });
    expect(a.findings[0]!.evidence.map((e) => e.modality)).toEqual(['subtitle']);
  });
  it('is deterministic: the same request gives the same body', async () => {
    const id = await start();
    const bodies = await Promise.all([1, 2, 3].map(async () => (await post(`/api/media/${id}/safety-findings`, terms(['safewatch test', 'phrase'], ['quick brown fox', 'phrase']))).text()));
    expect(new Set(bodies).size).toBe(1);
  });
  it('never exposes paths, and never logs transcript text or the user’s terms', async () => {
    const id = await start();
    const body = await (await post(`/api/media/${id}/safety-findings`, terms(['safewatch test', 'phrase']))).text();
    expect(body).not.toContain(app.storageDir);
    expect(body).not.toMatch(/\.wav|\.jpg|\.extraction|\/tmp|\/var\//);
    expect(JSON.stringify(app.logs)).not.toMatch(/SafeWatch test|safewatch test|quick brown|much later/);
  });
  it('the whole request bodies are bounded: 100 terms are accepted, 101 are not', async () => {
    const id = await start();
    const many = (n: number) => ({ terms: Array.from({ length: n }, (_, i) => ({ phrase: `word${i}`, matchMode: 'word-boundary' })) });
    expect((await post(`/api/media/${id}/safety-findings`, many(100))).status).toBe(200);
    expect((await post(`/api/media/${id}/safety-findings`, many(101))).status).toBe(400);
  });
});

describe('GET /api/media/:id/safety-findings', () => {
  it('without terms abstains explicitly instead of returning a clean result', async () => {
    const id = await start();
    const a = await safety(await fetch(`${app.url}/api/media/${id}/safety-findings`));
    expect(a).toMatchObject({ status: 'not-evaluated', findings: [], termCount: 0 });
    expect(a.categories.find((c) => c.category === 'flagged-terms')).toMatchObject({ evaluation: 'abstained', reason: 'no-terms-configured' });
  });
  it('is pending until the evidence steps have finished', async () => {
    app = await startTestApp({ extraction: {}, speech: { provider: speech }, vision: { provider: vision } });
    const { media } = (await (await upload(app, new Uint8Array(fixture('speech-subs.mkv')), 'speech-subs.mkv', 'video/x-matroska')).json()) as MediaResponse;
    const a = await safety(await fetch(`${app.url}/api/media/${media.asset.id}/safety-findings`));
    expect(a).toMatchObject({ status: 'pending', findings: [] });
  });
});

describe('request validation', () => {
  const bad: Array<[string, unknown, Record<string, string>?]> = [
    ['not JSON', '{ nope', undefined],
    ['wrong content type', JSON.stringify(terms(['x', 'word-boundary'])), { 'content-type': 'text/plain' }],
    ['no content type', JSON.stringify(terms(['x', 'word-boundary'])), {}],
    ['array body', [], undefined],
    ['null body', 'null', undefined],
    ['missing terms', {}, undefined],
    ['extra top-level field', { terms: [], path: '/etc/passwd' }, undefined],
    ['terms not an array', { terms: 'x' }, undefined],
    ['term not an object', { terms: ['darn'] }, undefined],
    ['unknown match mode', terms(['x', 'regex']), undefined],
    ['missing match mode', { terms: [{ phrase: 'x' }] }, undefined],
    ['extra term field', { terms: [{ phrase: 'x', matchMode: 'phrase', file: '/etc/passwd' }] }, undefined],
    ['non-string phrase', { terms: [{ phrase: 5, matchMode: 'phrase' }] }, undefined],
    ['empty phrase', terms(['   ', 'phrase']), undefined],
    ['phrase without words', terms(['!!!', 'phrase']), undefined],
    ['phrase too long', terms(['a'.repeat(201), 'phrase']), undefined],
    ['duplicate terms', terms(['darn', 'phrase'], ['DARN', 'phrase']), undefined],
    ['body above the limit', 'x'.repeat(40 * 1024), undefined],
  ];
  it.each(bad)('%s is rejected with 400 INVALID_REQUEST and a fixed message', async (_n, body, headers) => {
    const id = await start();
    const res = await post(`/api/media/${id}/safety-findings`, body, headers ?? { 'content-type': 'application/json' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error).toMatchObject({ code: 'INVALID_REQUEST', message: 'The request is not valid.' });
  });
  it.each(['nope', '00000000-0000-4000-8000-000000000000', '..%2F..%2Fetc%2Fpasswd', '%2e%2e', '%2Fetc%2Fpasswd'])('unknown or malformed id %s is 404 for GET and POST', async (badId) => {
    app = await startTestApp({ extraction: {} });
    app.login();
    expect((await fetch(`${app.url}/api/media/${badId}/safety-findings`)).status).toBe(404);
    expect((await post(`/api/media/${badId}/safety-findings`, terms(['x', 'word-boundary']))).status).toBe(404);
  });
  it('only GET and POST are served', async () => {
    const id = await start();
    for (const method of ['PUT', 'DELETE', 'PATCH']) expect((await fetch(`${app.url}/api/media/${id}/safety-findings`, { method })).status).toBe(404);
  });
  it('a path-like phrase is just a word to look for: it matches text, touches no file', async () => {
    const id = await start();
    const a = await safety(await post(`/api/media/${id}/safety-findings`, terms(['../../etc/passwd', 'phrase'])));
    expect(a).toMatchObject({ status: 'ready', findings: [] });
  });
  it('terms can be normal words in any script and the response never echoes unsanitised markup as markup', async () => {
    const id = await start();
    const a: SafetyAnalysis = await safety(await post(`/api/media/${id}/safety-findings`, terms(['<script>alert(1)</script>', 'phrase'], ['बकवास', 'word-boundary'])));
    expect(a.termCount).toBe(2);
    expect(a.findings).toEqual([]);
  });
});
