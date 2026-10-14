import type { RawTranscription } from '@/domain/speech/normalize';
import { validateContextAnalysis, type ContextAnalysis } from '@/domain/context/contextAnalysis';
import type { MediaResponse } from '@/domain/api/contract';
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
    { start: 6.5, end: 8.0, text: ' A second, much later sentence.', confidence: 0.7 },
  ],
};
const speech: SpeechToTextProvider = { info: { name: 'fake', model: 'fake-model' }, isAvailable: async () => true, transcribe: async () => HELLO };
const vision: VisualAnalysisProvider = {
  info: { name: 'fake-vision', model: 'fake-model' }, isAvailable: async () => true,
  analyze: async (frames: readonly VisionFrameInput[]): Promise<VisionFrameResult[]> => frames.map((f) => ({
    frameId: f.frameId, error: null, width: 320, height: 240, elapsedMs: 1,
    observations: [{ type: 'object', label: 'person', confidence: 0.94, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.5 } }, { type: 'classification', label: 'indoor', confidence: 0.6 }],
  })),
};
const FRAMES = { frame: { intervalSeconds: 3, maxFrames: 300, maxWidth: 320, maxHeight: 320 } };

async function run(opts: { speech?: SpeechToTextProvider | null; vision?: VisualAnalysisProvider | null; context?: Parameters<typeof startTestApp>[0] extends infer O ? (O extends { context?: infer C } ? C : never) : never } = {}) {
  app = await startTestApp({
    processor: new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }), extraction: { limits: FRAMES }, speech: { provider: opts.speech === undefined ? speech : opts.speech }, vision: { provider: opts.vision === undefined ? vision : opts.vision }, context: opts.context,
  });
  const res = await upload(app, new Uint8Array(fixture('speech-subs.mkv')), 'speech-subs.mkv', 'video/x-matroska');
  const { media } = (await res.json()) as MediaResponse;
  const id = media.asset.id;
  await waitForExtraction(app, id);
  await waitForTextAnalysis(app, id);
  await waitForVisualAnalysis(app, id);
  return { id, context: await waitForContext(app, id) };
}
const get = async (path: string) => (await fetch(`${app.url}${path}`));

describe('GET /api/media/:id/context', () => {
  it('correlates real speech, subtitle and visual evidence of one upload on its media timeline', async () => {
    const { id, context } = await run();
    expect(context).toMatchObject({ mediaId: id, status: 'ready', inputs: { speech: 'used', subtitles: 'used', visual: 'used' }, warnings: [] });
    expect(validateContextAnalysis(context)).toEqual([]);
    expect(context.durationMs).toBeGreaterThan(8000);
    const multi = context.events.filter((e) => e.corroboration === 'multi-source');
    expect(multi.length).toBeGreaterThan(0);
    const first = context.events[0]!;
    expect(first.sources).toEqual(['speech', 'subtitle', 'visual']); // "Hello, this is a SafeWatch test." at 0.2 to 2.6 s, its cue, and the frame at 1.4 s
    expect(first.members.find((m) => m.modality === 'speech')).toMatchObject({ label: 'Hello, this is a SafeWatch test.', confidence: 0.9, sourceId: 'aud-0' });
    expect(first.members.find((m) => m.modality === 'visual' && m.label === 'person')).toMatchObject({ kind: 'object', confidence: 0.94 });
    // Every piece of evidence the earlier stages produced is accounted for (once).
    const { textAnalysis } = (await (await get(`/api/media/${id}/transcript`)).json()) as { textAnalysis: { timeline: unknown[] } };
    const { visualAnalysis } = (await (await get(`/api/media/${id}/visual`)).json()) as { visualAnalysis: { observations: unknown[] } };
    expect(context.counts.evidenceCount).toBe(textAnalysis.timeline.length + visualAnalysis.observations.length);
    const memberIds = context.events.flatMap((e) => e.members.map((m) => m.evidenceId));
    expect(new Set(memberIds).size).toBe(memberIds.length);
  });

  it('keeps unrelated moments apart when the configured window is narrow: the later sentence is a different event from the first', async () => {
    // The fixture's subtitle cues run back to back, so with the default 1.5 s window the whole 8.5 s is one chain; a 200 ms window separates the moments.
    const { context } = await run({ context: { windowBeforeMs: 0, windowAfterMs: 200, maxVisualCoverageMs: 0 } });
    const late = context.events.find((e) => e.members.some((m) => m.modality === 'speech' && m.label.startsWith('A second')))!;
    expect(late.id).not.toBe(context.events[0]!.id);
    expect(late.startMs).toBeGreaterThanOrEqual(6000);
  });

  it('is deterministic: repeated requests return identical bodies', async () => {
    const { id } = await run();
    const bodies = await Promise.all([1, 2, 3].map(async () => (await get(`/api/media/${id}/context`)).text()));
    expect(new Set(bodies).size).toBe(1);
  });

  it('is configurable: a zero-width window splits what the default window merges', async () => {
    const wide = (await run()).context;
    await app.close();
    const tight = (await run({ context: { windowBeforeMs: 0, windowAfterMs: 0, maxVisualCoverageMs: 0 } })).context;
    expect(tight.events.length).toBeGreaterThan(wide.events.length);
    expect(tight.config).toMatchObject({ windowBeforeMs: 0, windowAfterMs: 0 });
  });

  it('the evidence=false form keeps events, times and sources but omits members', async () => {
    const { id, context } = await run();
    const slim = ((await (await get(`/api/media/${id}/context?evidence=false`)).json()) as { context: ContextAnalysis }).context;
    expect(slim.events.map((e) => [e.id, e.startMs, e.endMs, e.sources])).toEqual(context.events.map((e) => [e.id, e.startMs, e.endMs, e.sources]));
    expect(slim.events.every((e) => e.members.length === 0)).toBe(true);
    expect(slim.counts.evidenceCount).toBe(context.counts.evidenceCount);
  });

  it('visual analysis not configured: speech and subtitle context still works, and the gap is reported', async () => {
    const { context } = await run({ vision: null });
    expect(context).toMatchObject({ status: 'partial', inputs: { speech: 'used', subtitles: 'used', visual: 'not-enabled' }, warnings: [{ code: 'visual-not-enabled' }] });
    expect(context.events.length).toBeGreaterThan(0);
    expect(context.events.every((e) => !e.sources.includes('visual'))).toBe(true);
  });
  it('speech not configured: subtitle and visual context still works', async () => {
    const { context } = await run({ speech: null });
    expect(context).toMatchObject({ status: 'partial', inputs: { speech: 'not-enabled', subtitles: 'used', visual: 'used' } });
    expect(context.events.some((e) => e.sources.includes('subtitle') && e.sources.includes('visual'))).toBe(true);
  });
  it('a failing visual provider is a reported failure, not an empty success', async () => {
    const broken: VisualAnalysisProvider = { ...vision, analyze: async () => { throw new Error('boom'); } };
    const { context } = await run({ vision: broken });
    expect(context).toMatchObject({ status: 'partial', inputs: { visual: 'failed' }, warnings: [{ code: 'visual-failed' }] });
  });

  it('is pending (without events) until the evidence stages have finished', async () => {
    app = await startTestApp({ extraction: { limits: FRAMES }, speech: { provider: speech }, vision: { provider: vision } });
    const { media } = (await (await upload(app, new Uint8Array(fixture('speech-subs.mkv')), 'speech-subs.mkv', 'video/x-matroska')).json()) as MediaResponse;
    const early = ((await (await get(`/api/media/${media.asset.id}/context`)).json()) as { context: ContextAnalysis }).context;
    expect(early).toMatchObject({ status: 'pending', events: [] });
  });

  it('never exposes paths or provider internals, and never logs evidence', async () => {
    const { id } = await run();
    const body = await (await get(`/api/media/${id}/context`)).text();
    expect(body).not.toContain(app.storageDir);
    expect(body).not.toMatch(/\.wav|\.jpg|\.extraction|\/tmp|\/var\//);
    expect(JSON.stringify(app.logs)).not.toMatch(/SafeWatch test|second, much later/);
  });

  it('contains no safety vocabulary outside the evidence text itself', async () => {
    const { context } = await run();
    const structural = JSON.stringify({ ...context, events: context.events.map((e) => ({ ...e, members: e.members.map((m) => ({ ...m, label: '' })), ambient: [], facts: { ...e.facts, highlights: [] } })) });
    expect(structural).not.toMatch(/safe|unsafe|danger|violen|sexual|drug|graphic|explicit|verdict|policy|risk|score/i);
  });
});

describe('context API validation', () => {
  it.each(['nope', '00000000-0000-4000-8000-000000000000', '..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'a%00b', '%2Fetc%2Fpasswd'])('unknown or malformed id %s is 404 and touches no files', async (bad) => {
    app = await startTestApp({ extraction: {} });
    const res = await get(`/api/media/${bad}/context`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
  it('only GET is served', async () => {
    const { id } = await run();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await fetch(`${app.url}/api/media/${id}/context`, { method })).status).toBe(404);
  });
  it('accepts no client-provided path or evidence: query parameters other than evidence=false are ignored', async () => {
    const { id, context } = await run();
    const res = await get(`/api/media/${id}/context?path=/etc/passwd&file=../../x&evidence=`);
    expect(((await res.json()) as { context: ContextAnalysis }).context.events.length).toBe(context.events.length);
  });
  it('a media item without extraction wired reports pending with an honest status', async () => {
    app = await startTestApp({});
    const { media } = (await (await upload(app, new Uint8Array(fixture('sample.mp4')), 'sample.mp4')).json()) as MediaResponse;
    const res = await get(`/api/media/${media.asset.id}/context`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { context: ContextAnalysis }).context.status).toBe('pending');
  });
});
