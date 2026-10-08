import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaResponse } from '@/domain/api/contract';
import { validateVisualAnalysis } from '@/domain/vision/visualAnalysis';
import { VisionError, type VisionFrameResult, type VisionFrameInput, type VisionRequest, type VisualAnalysisProvider } from '../src/application/visualPorts';
import type { VisualLimits } from '../src/application/visualAnalysisService';
import { eventually, generateVideo, hasFfmpeg, startTestApp, upload, waitForExtraction, waitForVisualAnalysis, type TestApp } from './helpers';

let app: TestApp;
let dir: string;
afterEach(async () => { await app?.close(); if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined as unknown as string; });

const FRAMES_1S = { frame: { intervalSeconds: 1, maxFrames: 300, maxWidth: 320, maxHeight: 320 } };
const ok = (f: VisionFrameInput, extra: Partial<VisionFrameResult> = {}): VisionFrameResult => ({
  frameId: f.frameId, error: null, width: 320, height: 240, elapsedMs: 2,
  observations: [{ type: 'classification', label: 'outdoor', confidence: 0.9 }, { type: 'object', label: 'person', confidence: 0.8, region: { x: 0.1, y: 0.1, width: 0.2, height: 0.5 } }],
  ...extra,
});

interface Scripted extends VisualAnalysisProvider { batches: Array<{ frames: VisionFrameInput[]; request: VisionRequest }>; active: number; peak: number }
/** A scripted provider: `reply` decides per batch; it records what it was asked. */
function fakeProvider(reply: (frames: readonly VisionFrameInput[], req: VisionRequest, call: number) => Promise<VisionFrameResult[]> | VisionFrameResult[] = (fs) => fs.map((f) => ok(f)), delayMs = 0): Scripted {
  const p: Scripted = {
    info: { name: 'fake', model: 'fake-model' }, batches: [], active: 0, peak: 0, isAvailable: async () => true,
    async analyze(frames, request) {
      p.batches.push({ frames: [...frames], request });
      p.active += 1; p.peak = Math.max(p.peak, p.active);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return await reply(frames, request, p.batches.length);
      } finally { p.active -= 1; }
    },
  };
  return p;
}
const hang = (_f: readonly VisionFrameInput[], req: VisionRequest) => new Promise<VisionFrameResult[]>((_res, rej) => req.signal.addEventListener('abort', () => rej(new VisionError(req.signal.reason === 'timeout' ? 'timeout' : 'cancelled'))));

/** A provider whose FIRST call waits for `release()`: keeps the single vision slot busy so tests can change a queued media item. */
function gate() {
  let release!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  const blocked = fakeProvider(async (fs, _r, call) => { if (call === 1) await open; return fs.map((f) => ok(f)); });
  return { release, blocked };
}

async function send(seconds = 6): Promise<string> {
  dir ||= await mkdtemp(join(tmpdir(), 'sw-visual-'));
  const file = join(dir, `v${seconds}.mp4`);
  generateVideo(file, { width: 320, height: 240, seconds });
  const { media } = (await (await upload(app, new Uint8Array(await readFile(file)), 'v.mp4')).json()) as MediaResponse;
  return media.asset.id;
}

async function analyse(provider: VisualAnalysisProvider | null, limits: Partial<VisualLimits> = {}, seconds = 6, extractionLimits: object = FRAMES_1S) {
  app = await startTestApp({ extraction: { limits: extractionLimits }, vision: { provider, limits } });
  const id = await send(seconds);
  return { id, visual: await waitForVisualAnalysis(app, id) };
}

describe.runIf(hasFfmpeg)('visual analysis service (scripted provider)', () => {
  it('turns every extracted frame into timestamped, ordered observations on the media timeline', async () => {
    const provider = fakeProvider();
    const { id, visual } = await analyse(provider);
    const extraction = await waitForExtraction(app, id);
    expect(visual.status).toBe('ready');
    expect(visual.provider).toEqual({ name: 'fake', model: 'fake-model' });
    expect(visual.frames.map((f) => f.timestampSeconds)).toEqual(extraction.frames!.frames.map((f) => f.timestampSeconds));
    expect(visual.frames.every((f) => f.status === 'analyzed' && f.observationCount === 2)).toBe(true);
    expect(visual.counts).toEqual({ analyzedFrameCount: 6, skippedFrameCount: 0, failedFrameCount: 0, observationCount: 12 });
    expect(visual.observations[0]).toMatchObject({ id: 'vis-frm-00000-1', frameId: 'frm-00000', type: 'object', label: 'person' }); // ids follow provider order; objects sort before classifications
    expect(validateVisualAnalysis(visual, 6.1)).toEqual([]);
    expect(visual.metrics).toMatchObject({ batches: 1 });
  });
  it('sends frames in bounded batches with the configured thresholds, and reports measurable progress', async () => {
    const provider = fakeProvider(undefined, 80);
    app = await startTestApp({ extraction: { limits: FRAMES_1S }, vision: { provider, limits: { batchSize: 2, minConfidence: 0.25, maxLabelsPerFrame: 3 } } });
    const id = await send(6);
    const seen: Array<{ framesDone: number; framesTotal: number }> = [];
    await eventually(async () => {
      const { media } = (await (await fetch(`${app.url}/api/media/${id}`)).json()) as MediaResponse;
      if (media.visual.progress) seen.push(media.visual.progress);
      return media.visual.status === 'ready';
    }, 10_000);
    expect(provider.batches.map((b) => b.frames.length)).toEqual([2, 2, 2]);
    expect(provider.batches[0]!.request).toMatchObject({ minConfidence: 0.25, maxLabelsPerFrame: 3 });
    expect(seen.every((p) => p.framesTotal === 6 && p.framesDone % 2 === 0)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
  it('hands the provider a server-generated path only inside the call, and never exposes paths or logs content', async () => {
    const provider = fakeProvider();
    const { id, visual } = await analyse(provider);
    expect(provider.batches[0]!.frames[0]!.path).toContain(`${id}.extraction`);
    expect(provider.batches[0]!.frames[0]!.path).toMatch(/frames\/frm-00000\.jpg$/);
    expect(JSON.stringify(visual)).not.toContain(app.storageDir);
    expect(JSON.stringify(visual)).not.toMatch(/\.jpg|\.extraction/);
    expect(JSON.stringify(app.logs)).not.toMatch(/outdoor|person/);
    expect(app.logs.find((l) => l.msg === 'visual analysis ready')).toMatchObject({ op: 'visual', mediaId: id, status: 'ready', frames: 6, analyzed: 6, observations: 12 });
  });

  describe('failure isolation', () => {
    it('one undecodable frame fails alone; the rest are kept and the issue is counted', async () => {
      const { visual } = await analyse(fakeProvider((fs) => fs.map((f) => (f.frameId === 'frm-00002' ? { ...ok(f), error: 'invalid-frame' as const, observations: [] } : ok(f, { frameId: f.frameId })))));
      expect(visual.status).toBe('ready');
      expect(visual.frames.map((f) => f.status)).toEqual(['analyzed', 'analyzed', 'failed', 'analyzed', 'analyzed', 'analyzed']);
      expect(visual.frames[2]).toMatchObject({ error: 'invalid-frame', observationCount: 0 });
      expect(visual.observations.some((o) => o.frameId === 'frm-00002')).toBe(false);
      expect(visual.issues).toContainEqual({ code: 'invalid-frame', stage: 'frames', fatal: false, count: 1 });
      expect(visual.counts).toMatchObject({ analyzedFrameCount: 5, failedFrameCount: 1 });
    });
    it('a failing batch (timeout) fails only that batch; later batches still run', async () => {
      const { visual } = await analyse(fakeProvider((fs, _r, call) => { if (call === 1) throw new VisionError('inference-failed'); return fs.map((f) => ok(f)); }), { batchSize: 2 });
      expect(visual.status).toBe('ready');
      expect(visual.frames.map((f) => f.status)).toEqual(['failed', 'failed', 'analyzed', 'analyzed', 'analyzed', 'analyzed']);
      expect(visual.issues).toContainEqual({ code: 'inference-failed', stage: 'frames', fatal: false, count: 2 });
    });
    it('a frame missing from storage is reported as frame-missing, distinct from decode failures', async () => {
      const { release, blocked } = gate();
      app = await startTestApp({ extraction: { maxConcurrent: 2, limits: FRAMES_1S }, vision: { provider: blocked } });
      await send(2); // occupies the single vision slot
      await eventually(() => blocked.batches.length === 1);
      const id = await send(3);
      await waitForExtraction(app, id);
      const frame = app.repository.get(id)!.extraction.frames!.frames[1]!;
      await app.storage.deleteArtifact(id, frame.artifact);
      release();
      const v = await waitForVisualAnalysis(app, id);
      expect(v.status).toBe('ready');
      expect(v.frames.map((f) => f.status)).toEqual(['analyzed', 'failed', 'analyzed']);
      expect(v.frames[1]).toMatchObject({ error: 'frame-missing' });
      expect(v.issues).toContainEqual({ code: 'frame-missing', stage: 'frames', fatal: false, count: 1 });
    });
    it('every frame failing makes the stage fail with the dominant fatal cause (media stays ready)', async () => {
      const { id, visual } = await analyse(fakeProvider((fs) => fs.map((f) => ({ ...ok(f), error: 'inference-failed' as const, observations: [] }))));
      expect(visual).toMatchObject({ status: 'failed', frames: [], observations: [] });
      expect(visual.issues.at(-1)).toMatchObject({ code: 'inference-failed', fatal: true, count: 6 });
      expect(app.repository.get(id)!.asset.status).toBe('ready');
      expect(app.repository.get(id)!.extraction.status).toBe('completed');
    });
    it('a provider that returns nothing for a frame fails that frame, not the stage', async () => {
      const { visual } = await analyse(fakeProvider((fs) => fs.filter((f) => f.frameId !== 'frm-00001').map((f) => ok(f))));
      expect(visual.status).toBe('ready');
      expect(visual.frames[1]).toMatchObject({ status: 'failed', error: 'inference-failed' });
    });
    it('a provider that becomes unavailable fails the stage fatally', async () => {
      const { visual } = await analyse(fakeProvider(() => { throw new VisionError('provider-unavailable'); }));
      expect(visual).toMatchObject({ status: 'failed', issues: [{ code: 'provider-unavailable', fatal: true }] });
    });
  });

  describe('limits', () => {
    it('analyses at most maxFrames; the rest are listed as skipped (over-limit), never dropped silently', async () => {
      const { visual } = await analyse(fakeProvider(), { maxFrames: 4 });
      expect(visual.frames).toHaveLength(6);
      expect(visual.frames.filter((f) => f.status === 'skipped').map((f) => [f.index, f.skipReason])).toEqual([[4, 'over-limit'], [5, 'over-limit']]);
      expect(visual.counts).toMatchObject({ analyzedFrameCount: 4, skippedFrameCount: 2 });
    });
    it('refuses an oversized frame before it reaches the provider (resource-limit)', async () => {
      const provider = fakeProvider();
      const { visual } = await analyse(provider, { maxFrameBytes: 1 });
      expect(provider.batches).toHaveLength(0);
      expect(visual).toMatchObject({ status: 'failed', issues: expect.arrayContaining([expect.objectContaining({ code: 'resource-limit', fatal: true })]) });
    });
    it('caps observations per frame and counts what it dropped', async () => {
      const many = Array.from({ length: 10 }, (_, i) => ({ type: 'classification', label: `l${i}`, confidence: 0.5 }));
      const { visual } = await analyse(fakeProvider((fs) => fs.map((f) => ok(f, { observations: many }))), { maxObservationsPerFrame: 3 });
      expect(visual.frames.every((f) => f.observationCount === 3)).toBe(true);
      expect(visual.issues).toContainEqual({ code: 'observations-dropped', stage: 'timeline', fatal: false, count: 42 });
    });
    it('drops unusable provider observations (unknown types, empty labels) and keeps the valid ones', async () => {
      const { visual } = await analyse(fakeProvider((fs) => fs.map((f) => ok(f, { observations: [{ type: 'unsafe', label: 'x', confidence: 1 }, { type: 'object', label: '' }, { type: 'object', label: 'dog', confidence: 7 }] }))));
      expect(visual.observations.map((o) => [o.label, o.confidence])).toEqual(Array(6).fill(['dog', null]));
      expect(visual.issues).toContainEqual({ code: 'observations-dropped', stage: 'timeline', fatal: false, count: 12 });
    });
    it('completes with a no-frames notice when extraction produced no frames', async () => {
      const { release, blocked } = gate();
      app = await startTestApp({ extraction: { maxConcurrent: 2, limits: FRAMES_1S }, vision: { provider: blocked } });
      await send(2);
      await eventually(() => blocked.batches.length === 1);
      const id = await send(2);
      await waitForExtraction(app, id);
      const rec = app.repository.get(id)!;
      app.repository.set({ ...rec, extraction: { ...rec.extraction, frames: null } });
      release();
      const v = await waitForVisualAnalysis(app, id);
      expect(v).toMatchObject({ status: 'ready', frames: [], observations: [], issues: [{ code: 'no-frames', stage: 'frames', fatal: false }] });
    });
  });

  describe('timeouts, cancellation and queueing', () => {
    it('times a batch out with the abort reason "timeout" (code timeout); all its frames fail so the stage fails', async () => {
      const provider = fakeProvider(hang);
      const { visual } = await analyse(provider, { timeoutMs: 300 });
      expect(provider.batches[0]!.request.signal.reason).toBe('timeout');
      expect(visual.issues.at(-1)).toMatchObject({ code: 'timeout', fatal: true });
    });
    it('deleting the media aborts an in-flight analysis (reason "cancelled") and leaves nothing on disk', async () => {
      const provider = fakeProvider(hang);
      app = await startTestApp({ extraction: { limits: FRAMES_1S }, vision: { provider, limits: { timeoutMs: 20_000 } } });
      const id = await send(3);
      await eventually(() => provider.batches.length === 1);
      await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE' });
      await eventually(() => provider.batches[0]!.request.signal.aborted);
      expect(provider.batches[0]!.request.signal.reason).toBe('cancelled');
      await eventually(async () => (await app.files()).length === 0);
      expect(app.repository.get(id)).toBeUndefined();
      expect(provider.active).toBe(0);
    });
    it('runs one analysis at a time by default; later media wait in a bounded queue', async () => {
      const provider = fakeProvider(undefined, 100);
      app = await startTestApp({ extraction: { maxConcurrent: 3, limits: FRAMES_1S }, vision: { provider, maxConcurrent: 1, maxQueued: 5 } });
      const ids = [await send(2), await send(2), await send(2)];
      for (const id of ids) expect((await waitForVisualAnalysis(app, id)).status).toBe('ready');
      expect(provider.peak).toBe(1);
    });
    it('fails visual analysis with server-busy (media stays ready) when its queue is full', async () => {
      const provider = fakeProvider(hang);
      app = await startTestApp({ extraction: { maxConcurrent: 2, limits: FRAMES_1S }, vision: { provider, maxConcurrent: 1, maxQueued: 0, limits: { timeoutMs: 500 } } });
      await send(2);
      await eventually(() => provider.batches.length === 1);
      const second = await send(2);
      const v = await waitForVisualAnalysis(app, second);
      expect(v).toMatchObject({ status: 'failed', issues: [{ code: 'server-busy', stage: 'queue', fatal: true }] });
      expect(app.repository.get(second)!.asset.status).toBe('ready');
    });
    it('without a provider the stage fails cleanly with provider-unavailable and everything else still works', async () => {
      const { id, visual } = await analyse(null);
      expect(visual).toMatchObject({ status: 'failed', issues: [{ code: 'provider-unavailable', stage: 'provider', fatal: true }] });
      expect((await waitForExtraction(app, id)).status).toBe('completed');
    });
    it('visual evidence follows the media lifecycle: expiry removes it with the files', async () => {
      app = await startTestApp({ extraction: { limits: FRAMES_1S }, vision: { provider: fakeProvider() }, retentionMs: 60_000 });
      const id = await send(3);
      await waitForVisualAnalysis(app, id);
      app.clock.now += 61_000;
      await app.service.sweep();
      expect((await fetch(`${app.url}/api/media/${id}/visual`)).status).toBe(404);
      expect((await fetch(`${app.url}/api/media/${id}/frames/frm-00000`)).status).toBe(404);
      expect(await app.files()).toEqual([]);
    });
  });

  describe('security: provider output and labels are untrusted data', () => {
    it('keeps hostile labels and OCR text inert (no markup interpretation, controls and bidi removed)', async () => {
      const hostile = '<script>alert(1)</script> $(rm -rf /) `id` ; | && \u202eevil\u202c \u0000 ../../etc/passwd';
      const { visual } = await analyse(fakeProvider((fs) => fs.map((f) => ok(f, { observations: [{ type: 'text', label: 'text', confidence: 1, text: hostile }] }))));
      const text = visual.observations[0]!.attributes!.text!;
      expect(text).toContain('<script>alert(1)</script>');
      expect([...text].some((c) => ['\u0000', '\u202e', '\u202c'].includes(c))).toBe(false);
      const res = await fetch(`${app.url}/api/media/${visual.mediaId}/visual`);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });
});

describe.runIf(hasFfmpeg)('visual API', () => {
  it('returns a not_started analysis when no provider stage is wired, and 404 for unknown or malformed ids', async () => {
    app = await startTestApp({ extraction: {} });
    const id = await send(2);
    await waitForExtraction(app, id);
    const body = (await (await fetch(`${app.url}/api/media/${id}/visual`)).json()) as { visualAnalysis: { status: string } };
    expect(body.visualAnalysis.status).toBe('not_started');
    for (const bad of ['nope', '00000000-0000-4000-8000-000000000000', '..%2F..%2Fetc']) {
      expect((await fetch(`${app.url}/api/media/${bad}/visual`)).status).toBe(404);
      expect((await fetch(`${app.url}/api/media/${bad}/frames/frm-00000`)).status).toBe(404);
    }
  });
  it('serves only frames listed in the manifest, as images, and rejects anything path-like', async () => {
    app = await startTestApp({ extraction: { limits: FRAMES_1S }, vision: { provider: fakeProvider() } });
    const id = await send(3);
    await waitForVisualAnalysis(app, id);
    const ok200 = await fetch(`${app.url}/api/media/${id}/frames/frm-00001`);
    expect(ok200.status).toBe(200);
    expect(ok200.headers.get('content-type')).toBe('image/jpeg');
    expect(ok200.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(Number(ok200.headers.get('content-length'))).toBe((await ok200.arrayBuffer()).byteLength);
    for (const bad of ['frm-99999', 'frm-1', '..%2F..%2Fmedia', 'frm-00001.jpg', 'frm-00001%2F..%2Faudio%2Faud-0.wav', 'audio%2Faud-0.wav']) {
      expect((await fetch(`${app.url}/api/media/${id}/frames/${bad}`)).status).toBe(404);
    }
    expect((await fetch(`${app.url}/api/media/${id}/frames/frm-00001`, { method: 'DELETE' })).status).toBe(404);
  });
  it('the observations=false form omits observations but keeps frames and counts', async () => {
    app = await startTestApp({ extraction: { limits: FRAMES_1S }, vision: { provider: fakeProvider() } });
    const id = await send(3);
    await waitForVisualAnalysis(app, id);
    const slim = ((await (await fetch(`${app.url}/api/media/${id}/visual?observations=false`)).json()) as { visualAnalysis: { observations: unknown[]; frames: unknown[]; counts: { observationCount: number } } }).visualAnalysis;
    expect(slim.observations).toEqual([]);
    expect(slim.frames.length).toBeGreaterThan(0);
    expect(slim.counts.observationCount).toBeGreaterThan(0);
  });
  it('health reports vision availability without paths or versions', async () => {
    app = await startTestApp({ extraction: {}, vision: { provider: fakeProvider() } });
    const h = (await (await fetch(`${app.url}/api/health`)).json()) as { vision: unknown };
    expect(h.vision).toEqual({ provider: 'test', available: true });
  });
});
