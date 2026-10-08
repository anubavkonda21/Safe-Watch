import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaResponse } from '@/domain/api/contract';
import { validateVisualAnalysis, type VisualAnalysis } from '@/domain/vision/visualAnalysis';
import { hasFfmpeg, hasRealVision, realVision, startTestApp, upload, waitForVisualAnalysis, type TestApp } from './helpers';

/**
 * REAL on-device inference (Apple Vision) on real photographs: nothing here is mocked.
 * `globalSetup` builds the helper and fetches the checksummed images before the run, so on macOS these
 * tests always execute; the explicit `hasRealVision` assertion makes a missing helper a FAILURE, never a skip.
 * They prove the pipeline works end to end; with seven photos they say nothing about model accuracy.
 */
const CACHE = new URL('./fixtures/vision-cache/', import.meta.url).pathname;
const img = (name: string) => join(CACHE, name);
const LIVING_ROOM = '000000000139.jpg';
const STREET_SIGN = '000000000724.jpg';
const SKIER = '000000000785.jpg';
const BOOKSHELF = '000000000632.jpg';
const req = () => ({ signal: new AbortController().signal, minConfidence: 0.1, maxLabelsPerFrame: 8 });

describe.runIf(process.platform === 'darwin')('real visual inference (Apple Vision, no mocks)', () => {
  it('the helper is available (globalSetup built it); a missing helper fails the run instead of skipping', () => {
    expect(hasRealVision).toBe(true);
  });

  it('describes real photographs with labels, a located person and recognised text', async () => {
    const names = [LIVING_ROOM, STREET_SIGN, SKIER, BOOKSHELF];
    const results = await realVision.analyze(names.map((n, i) => ({ frameId: `frm-0000${i}`, path: img(n) })), req());
    const labels = results.map((r) => new Set(r.observations.filter((o) => o.type === 'classification').map((o) => String(o.label))));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(labels[0]).toContain('living_room');
    expect(labels[1]).toContain('street_sign');
    expect(labels[2]).toContain('skiing');
    expect(labels[3]).toContain('bookshelf');
    // Localised object with a normalised top-left box inside the frame.
    const person = results[2]!.observations.find((o) => o.type === 'object' && o.label === 'person');
    expect(person).toBeTruthy();
    const box = person!.region as { x: number; y: number; width: number; height: number };
    expect(box.x + box.width).toBeLessThanOrEqual(1.0001);
    expect(box.y + box.height).toBeLessThanOrEqual(1.0001);
    // The skier stands right of centre in the upper half of the photo (checked visually against the image).
    expect(box.x).toBeGreaterThan(0.4);
    expect(box.y).toBeLessThan(0.5);
    // Dimensions are the real image dimensions.
    expect([results[0]!.width, results[0]!.height]).toEqual([640, 426]);
    // Confidences are the model's own, in [0, 1].
    for (const r of results) {
      for (const o of r.observations) {
        if (typeof o.confidence !== 'number') continue;
        expect(o.confidence).toBeGreaterThanOrEqual(0);
        expect(o.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reads text rendered into a frame', async () => {
    const [r] = await realVision.analyze([{ frameId: 'frm-00000', path: img('textframe.jpg') }], req());
    const text = r!.observations.find((o) => o.type === 'text');
    expect(String(text?.text)).toContain('VISUAL TEST');
  });

  it('isolates bad frames: a corrupt JPEG fails alone, its neighbours are still analysed', async () => {
    const results = await realVision.analyze([
      { frameId: 'frm-00000', path: img(SKIER) }, { frameId: 'frm-00001', path: img('corrupt.jpg') },
      { frameId: 'frm-00002', path: img('does-not-exist.jpg') }, { frameId: 'frm-00003', path: img(LIVING_ROOM) },
    ], req());
    expect(results.map((r) => r.error)).toEqual([null, 'invalid-frame', 'invalid-frame', null]);
    expect(results[0]!.observations.length).toBeGreaterThan(0);
    expect(results[3]!.observations.length).toBeGreaterThan(0);
  });

  it('opens only images: a non-image file is refused, not interpreted', async () => {
    const [r] = await realVision.analyze([{ frameId: 'frm-00000', path: new URL('./fixtures/apple-vision-sample.json', import.meta.url).pathname }], req());
    expect(r!.error).toBe('invalid-frame');
  });

  it('a frame with no content still returns the model output (observations are not verdicts)', async () => {
    const [r] = await realVision.analyze([{ frameId: 'frm-00000', path: img('black.jpg') }], req());
    expect(r!.error).toBeNull();
    // Whatever the model says about black pixels is just a label; it must carry a confidence and nothing like a safety field.
    for (const o of r!.observations) expect(Object.keys(o).sort().every((k) => ['type', 'label', 'confidence', 'region', 'text'].includes(k))).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin' && hasFfmpeg)('real visual analysis through the whole pipeline (upload → FFmpeg frames → Apple Vision → API)', () => {
  let app: TestApp;
  let dir: string;
  afterEach(async () => { await app?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

  /** A 12 s video: four real photographs, three seconds each. Frame sampling at 3 s lands one frame inside each photo. */
  async function slideshow() {
    dir = await mkdtemp(join(tmpdir(), 'sw-slideshow-'));
    const names = [LIVING_ROOM, STREET_SIGN, SKIER, BOOKSHELF];
    const out = join(dir, 'slides.mp4');
    const inputs = names.flatMap((n) => ['-loop', '1', '-t', '3', '-framerate', '10', '-i', img(n)]);
    const filter = names.map((_, i) => `[${i}:v]scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`).join(';') + `;${names.map((_, i) => `[v${i}]`).join('')}concat=n=4:v=1:a=0[v]`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out], { stdio: 'ignore' });
    return new Uint8Array(await readFile(out));
  }

  it('produces ordered, timestamped visual observations that match what each part of the video shows', async () => {
    app = await startTestApp({
      extraction: { limits: { frame: { intervalSeconds: 3, maxFrames: 300, maxWidth: 768, maxHeight: 768 } } },
      vision: { provider: realVision, limits: { timeoutMs: 120_000, batchSize: 2 } },
    });
    const res = await upload(app, await slideshow(), 'slides.mp4');
    const { media } = (await res.json()) as MediaResponse;
    expect(media.visual.status).toBe('not_started');
    const v: VisualAnalysis = await waitForVisualAnalysis(app, media.asset.id, 180_000);

    expect(v.status).toBe('ready');
    expect(v.provider).toEqual({ name: 'apple-vision', model: 'vision-framework' });
    expect(v.frames.map((f) => f.timestampSeconds)).toEqual([1.5, 4.5, 7.5, 10.5]);
    expect(v.frames.every((f) => f.status === 'analyzed')).toBe(true);
    expect(v.counts).toMatchObject({ analyzedFrameCount: 4, failedFrameCount: 0, skippedFrameCount: 0 });
    expect(v.counts.observationCount).toBe(v.observations.length);
    expect(v.metrics!.batches).toBe(2);
    expect(validateVisualAnalysis(v, 12.5)).toEqual([]);

    const at = (t: number) => v.observations.filter((o) => o.timestampSeconds === t);
    expect(at(1.5).map((o) => o.label)).toContain('living_room');
    expect(at(4.5).map((o) => o.label)).toContain('street_sign');
    expect(at(7.5).map((o) => o.label)).toContain('skiing');
    expect(at(7.5).some((o) => o.type === 'object' && o.label === 'person' && o.region !== null)).toBe(true);
    expect(at(10.5).map((o) => o.label)).toContain('bookshelf');
    // Chronological order across the whole result.
    expect(v.observations.map((o) => o.timestampSeconds)).toEqual([...v.observations.map((o) => o.timestampSeconds)].sort((a, b) => a - b));

    // The same frames are viewable through the API and are real JPEGs.
    const frame = await fetch(`${app.url}/api/media/${media.asset.id}/frames/${v.frames[2]!.frameId}`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(frame.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await frame.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);

    // Evidence only: nothing in the payload is a safety judgement.
    expect(JSON.stringify(v)).not.toMatch(/safe|unsafe|score|verdict|violen|sexual|drug|censor|mute|skip_scene/i);
  }, 240_000);
});
