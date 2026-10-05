import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaResponse } from '@/domain/api/contract';
import { normalizeMetadata } from '@/domain/media/metadata';
import type { RawCue } from '@/domain/extraction/subtitles';
import { ExtractionError } from '../src/application/errors';
import type { ExtractedAudio, ExtractedFrame, ExtractionContext, MediaExtractor } from '../src/application/extractionPorts';
import type { AudioStreamInfo, StreamInventory, SubtitleStreamInfo } from '../src/application/extractionTypes';
import { fixture, startTestApp, upload, waitForExtraction, waitForStatus, type TestApp } from './helpers';

let app: TestApp;
afterEach(async () => { await app?.close(); });

const disp = { default: false, forced: false, original: false, hearingImpaired: false, commentary: false };
const audioStream = (streamIndex: number, extra: Partial<AudioStreamInfo> = {}): AudioStreamInfo =>
  ({ streamIndex, language: 'eng', title: null, disposition: disp, codec: 'aac', sampleRate: 48000, channels: 2, bitRate: 128000, durationSeconds: 10, ...extra });
const subStream = (streamIndex: number, codec: string, extra: Partial<SubtitleStreamInfo> = {}): SubtitleStreamInfo =>
  ({ streamIndex, language: 'eng', title: null, disposition: disp, codec, ...extra });

interface Script {
  inventory?: Partial<StreamInventory>;
  audioHash?: (ordinal: number) => string;
  cues?: (stream: SubtitleStreamInfo) => RawCue[] | Error;
  frame?: (ts: number, index: number) => ExtractedFrame | null | Error;
  hang?: 'audio' | 'frames';
  audioBytes?: number;
}

/** Writes real files into the workspace so cleanup is observable, but never runs FFmpeg. */
function fakeExtractor(script: Script = {}): MediaExtractor & { calls: string[] } {
  const calls: string[] = [];
  const hangUntilAbort = (signal: AbortSignal) => new Promise<never>((_r, rej) => signal.addEventListener('abort', () => rej(new ExtractionError('timeout'))));
  return {
    calls,
    async inspect() {
      calls.push('inspect');
      return { durationSeconds: 100, video: { width: 1920, height: 1080 }, audio: [audioStream(1)], subtitles: [], ...script.inventory };
    },
    async extractAudio(ctx: ExtractionContext, _s: AudioStreamInfo, ordinal: number): Promise<ExtractedAudio> {
      calls.push(`audio-${ordinal}`);
      const artifact = `audio/aud-${ordinal}.wav`;
      await mkdir(join(ctx.workspace.dir, 'audio'), { recursive: true });
      await writeFile(join(ctx.workspace.dir, artifact), 'wav');
      if (script.hang === 'audio') await hangUntilAbort(ctx.signal);
      return { artifact, sizeBytes: script.audioBytes ?? 1000, durationSeconds: 10, sha256: script.audioHash ? script.audioHash(ordinal) : `hash-${ordinal}` };
    },
    async extractSubtitleCues(_c, stream) {
      calls.push(`sub-${stream.streamIndex}`);
      const r = script.cues ? script.cues(stream) : [{ startSeconds: 1, endSeconds: 2, text: 'hello' }];
      if (r instanceof Error) throw r;
      return r;
    },
    async sampleFrame(ctx, ts, index) {
      calls.push(`frame-${index}`);
      await mkdir(join(ctx.workspace.dir, 'frames'), { recursive: true });
      await writeFile(join(ctx.workspace.dir, `frames/frm-${String(index).padStart(5, '0')}.jpg`), 'jpg');
      if (script.hang === 'frames') await hangUntilAbort(ctx.signal);
      const r = script.frame ? script.frame(ts, index) : { artifact: `frames/frm-${String(index).padStart(5, '0')}.jpg`, width: 768, height: 432, sizeBytes: 500 };
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

async function run(opts: Parameters<typeof startTestApp>[0] & object, file = 'sample.mp4') {
  app = await startTestApp(opts);
  const mime = file.endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const { media } = (await (await upload(app, new Uint8Array(fixture(file)), file, mime)).json()) as MediaResponse;
  await waitForStatus(app, media.asset.id, ['ready']);
  return { id: media.asset.id, extraction: await waitForExtraction(app, media.asset.id) };
}

describe('MediaExtractionService policy', () => {
  it('completes: media READY, extraction COMPLETED, analysis NOT started (three separate states)', async () => {
    const { id, extraction } = await run({ extraction: { extractor: fakeExtractor() } });
    expect(extraction.status).toBe('completed');
    const res = (await (await fetch(`${app.url}/api/media/${id}`)).json()) as MediaResponse;
    expect(res.media.asset.status).toBe('ready');
    expect(res.media.extraction).toEqual({ status: 'completed', phase: null });
    expect(res.media.analysis).toEqual({ status: 'not_started' });
  });
  it('plans frames deterministically from the media duration with the configured cap', async () => {
    const { extraction } = await run({ extraction: { extractor: fakeExtractor(), limits: { frame: { intervalSeconds: 10, maxFrames: 4, maxWidth: 768, maxHeight: 768 } } } });
    expect(extraction.frames!.frames.map((f) => f.timestampSeconds)).toEqual([12.5, 37.5, 62.5, 87.5]); // 100 s, capped at 4 → equal intervals of 25 s
    expect(extraction.frames!.effectiveIntervalSeconds).toBe(25);
    expect(extraction.frames!.config.maxFrames).toBe(4);
  });
  it('extracts every audio track in order, preserving metadata, and dedupes bit-identical tracks without dropping them', async () => {
    const x = fakeExtractor({ inventory: { audio: [audioStream(1, { language: 'eng', title: 'Main' }), audioStream(2, { language: 'spa' }), audioStream(3, { language: 'fra' })] }, audioHash: (o) => (o === 2 ? 'unique' : 'same') });
    const { extraction } = await run({ extraction: { extractor: x } });
    expect(extraction.audio.map((a) => [a.id, a.streamIndex, a.language, a.duplicateOf, a.artifact])).toEqual([
      ['aud-0', 1, 'eng', null, 'audio/aud-0.wav'], ['aud-1', 2, 'spa', 'aud-0', null], ['aud-2', 3, 'fra', null, 'audio/aud-2.wav'],
    ]);
    expect(extraction.audio[0]).toMatchObject({ title: 'Main', format: { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 } });
    // the duplicate's file was removed, the unique ones kept
    expect((await readdir(join(app.storageDir, `${id0(app)}.extraction`, 'audio'))).sort()).toEqual(['aud-0.wav', 'aud-2.wav']);
    expect(extraction.metrics!.outputBytes).toBe(2 * 1000 + extraction.frames!.totalSizeBytes);
  });
  it('supports zero audio tracks and zero subtitle tracks', async () => {
    const { extraction } = await run({ extraction: { extractor: fakeExtractor({ inventory: { audio: [], subtitles: [] } }) } });
    expect(extraction).toMatchObject({ status: 'completed', audio: [], subtitles: [], errors: [] });
  });
  it('reports audio tracks beyond the track limit as warnings instead of dropping them silently', async () => {
    const x = fakeExtractor({ inventory: { audio: [audioStream(1), audioStream(2), audioStream(3)] } });
    const { extraction } = await run({ extraction: { extractor: x, limits: { maxAudioTracks: 2 } } });
    expect(extraction.audio).toHaveLength(2);
    expect(extraction.errors).toEqual([{ code: 'limit-exceeded', stage: 'audio', fatal: false, streamIndex: 3 }]);
    expect(extraction.status).toBe('completed');
  });
  it('fails safely when an audio track would exceed the output limit, before decoding it', async () => {
    const x = fakeExtractor({ inventory: { audio: [audioStream(1, { durationSeconds: 3600 })] } });
    const { id, extraction } = await run({ extraction: { extractor: x, limits: { maxAudioBytes: 1_000_000 } } }); // 1 h of 16 kHz mono ≈ 115 MB
    expect(extraction).toMatchObject({ status: 'failed', errors: [{ code: 'limit-exceeded', stage: 'audio', fatal: true }], audio: [], frames: null });
    expect(x.calls).not.toContain('audio-0');
    expect(await app.files()).not.toContain(`${id}.extraction`);
  });
  it('shares ONE audio budget across all tracks: a second track that would exceed it fails the extraction and cleans up', async () => {
    // each 10 s track ≈ 320 KB of 16 kHz mono PCM; the 500 KB budget fits one but not two
    const x = fakeExtractor({ inventory: { audio: [audioStream(1), audioStream(2)] }, audioBytes: 320_000 });
    const { id, extraction } = await run({ extraction: { extractor: x, limits: { maxAudioBytes: 500_000 } } });
    expect(extraction).toMatchObject({ status: 'failed', errors: [{ code: 'limit-exceeded', stage: 'audio', fatal: true }], audio: [] });
    expect(x.calls).toContain('audio-0');
    expect(x.calls).not.toContain('audio-1');
    expect(await app.files()).not.toContain(`${id}.extraction`);
  });
  it('passes the REMAINING audio budget to the adapter for each track', async () => {
    const seen: number[] = [];
    const x = fakeExtractor({ inventory: { audio: [audioStream(1, { durationSeconds: 1 }), audioStream(2, { durationSeconds: 1 })] }, audioBytes: 32_000, audioHash: (o) => `h${o}` });
    const inner = x.extractAudio.bind(x);
    x.extractAudio = async (ctx, s, o) => { seen.push(ctx.limits.maxAudioBytes); return inner(ctx, s, o); };
    await run({ extraction: { extractor: x, limits: { maxAudioBytes: 100_000 } } });
    expect(seen).toEqual([100_000, 68_000]);
  });
  it('lists text, image and unknown subtitle tracks; only text is extracted; image is never treated as text', async () => {
    const x = fakeExtractor({ inventory: { subtitles: [subStream(2, 'subrip'), subStream(3, 'hdmv_pgs_subtitle', { language: 'jpn' }), subStream(4, 'dvd_subtitle'), subStream(5, 'mystery_codec')] } });
    const { extraction } = await run({ extraction: { extractor: x } });
    expect(extraction.subtitles.map((t) => [t.codec, t.kind, t.textExtraction, t.cueCount])).toEqual([
      ['subrip', 'text', 'extracted', 1], ['hdmv_pgs_subtitle', 'image', 'unsupported', 0], ['dvd_subtitle', 'image', 'unsupported', 0], ['mystery_codec', 'unknown', 'unsupported', 0],
    ]);
    expect(x.calls.filter((c) => c.startsWith('sub-'))).toEqual(['sub-2']); // never attempted to read image/unknown tracks
    expect(extraction.errors).toEqual([]);
  });
  it('normalises cues and keeps hostile subtitle text inert', async () => {
    const x = fakeExtractor({ inventory: { subtitles: [subStream(2, 'subrip')] }, cues: () => [
      { startSeconds: 2, endSeconds: 3, text: '<i>Hi</i>‮ there' },
      { startSeconds: 2, endSeconds: 3, text: 'Hi there' },
      { startSeconds: 4, endSeconds: 5, text: '   ' },
      { startSeconds: 6, endSeconds: 7, text: '<script>alert(1)</script>' },
    ] });
    const { extraction } = await run({ extraction: { extractor: x } });
    expect(extraction.subtitles[0]!.cues.map((c) => c.text)).toEqual(['Hi there', '<script>alert(1)</script>']);
    expect(extraction.subtitles[0]!.cues[0]).toMatchObject({ index: 0, startSeconds: 2, endSeconds: 3 });
    expect(JSON.stringify(app.logs)).not.toMatch(/alert\(1\)|Hi there/); // subtitle text is never logged
  });
  it('a single unreadable subtitle track is a warning, not a failure', async () => {
    const x = fakeExtractor({ inventory: { subtitles: [subStream(2, 'subrip'), subStream(3, 'ass')] }, cues: (s) => (s.streamIndex === 2 ? new ExtractionError('extraction-failed') : [{ startSeconds: 0, endSeconds: 1, text: 'ok' }]) });
    const { extraction } = await run({ extraction: { extractor: x } });
    expect(extraction.status).toBe('completed');
    expect(extraction.subtitles.map((t) => t.textExtraction)).toEqual(['failed', 'extracted']);
    expect(extraction.errors).toEqual([{ code: 'track-unavailable', stage: 'subtitles', fatal: false, streamIndex: 2 }]);
  });
  it('enforces the per-track cue limit as a warning', async () => {
    const x = fakeExtractor({ inventory: { subtitles: [subStream(2, 'subrip')] }, cues: () => Array.from({ length: 5 }, (_, i) => ({ startSeconds: i, endSeconds: i + 0.5, text: `c${i}` })) });
    const { extraction } = await run({ extraction: { extractor: x, limits: { maxCues: 3 } } });
    expect(extraction.subtitles[0]).toMatchObject({ textExtraction: 'failed', cues: [] });
    expect(extraction.errors[0]).toMatchObject({ code: 'limit-exceeded', fatal: false });
  });
  it('fails safely and cleans up when total frame storage exceeds the limit', async () => {
    const { id, extraction } = await run({ extraction: { extractor: fakeExtractor(), limits: { maxFrameBytes: 1200 } } }); // 500 B per frame → third frame exceeds
    expect(extraction).toMatchObject({ status: 'failed', errors: [{ code: 'limit-exceeded', stage: 'frames', fatal: true }], frames: null, audio: [] });
    expect(await app.files()).not.toContain(`${id}.extraction`);
  });
  it('skips frames that cannot be decoded (warning) but fails if none can', async () => {
    const some = await run({ extraction: { extractor: fakeExtractor({ frame: (t, i) => (t < 20 ? null : { artifact: `frames/frm-0000${i}.jpg`, width: 10, height: 10, sizeBytes: 5 }) }), limits: { frame: { intervalSeconds: 10, maxFrames: 3, maxWidth: 768, maxHeight: 768 } } } });
    expect(some.extraction.status).toBe('completed');
    expect(some.extraction.errors.filter((e) => e.code === 'frame-unavailable')).toHaveLength(1);
    await app.close();
    const none = await run({ extraction: { extractor: fakeExtractor({ frame: () => null }) } });
    expect(none.extraction).toMatchObject({ status: 'failed', errors: [{ code: 'extraction-failed', fatal: true }] });
  });
  it('samples only the first moment, with a warning, when the duration is unknown', async () => {
    // Both the probe inventory and the media record have no duration (e.g. a recorded WebM).
    const processor = { extractMetadata: async () => normalizeMetadata({ width: 160, height: 120 }, 'ffprobe'), verifyDecodable: async () => undefined };
    const { extraction } = await run({ processor, extraction: { extractor: fakeExtractor({ inventory: { durationSeconds: null } }) } });
    expect(extraction.status).toBe('completed');
    expect(extraction.frames!.frames.map((f) => f.timestampSeconds)).toEqual([0]);
    expect(extraction.errors).toEqual([{ code: 'duration-unknown', stage: 'frames', fatal: false, streamIndex: null }]);
  });
  it('fails an invalid manifest as invalid-output instead of publishing it', async () => {
    const { extraction } = await run({ extraction: { extractor: fakeExtractor({ frame: () => ({ artifact: 'frames/x.jpg', width: 5000, height: 5000, sizeBytes: 1 }) }) } });
    expect(extraction).toMatchObject({ status: 'failed', errors: [{ code: 'invalid-output', stage: 'finalizing', fatal: true }] });
  });
  it('times out: aborts the work, deletes partial outputs, records a timeout', async () => {
    const x = fakeExtractor({ hang: 'frames' });
    const { id, extraction } = await run({ extraction: { extractor: x, limits: { timeoutMs: 150 } } });
    expect(extraction).toMatchObject({ status: 'failed', errors: [{ code: 'timeout', stage: 'frames', fatal: true }] });
    await expectNoExtractionDir(app, id);
    expect(app.logs.some((l) => l.msg === 'extraction failed' && l.code === 'timeout')).toBe(true);
  });
  it('reports phase-based progress (never percentages) while processing', async () => {
    app = await startTestApp({ extraction: { extractor: fakeExtractor({ hang: 'audio' }), limits: { timeoutMs: 600 } } });
    const { media } = (await (await upload(app, new Uint8Array(fixture('sample.mp4')), 'a.mp4')).json()) as MediaResponse;
    const seen = new Set<string>();
    const end = Date.now() + 5000;
    for (;;) {
      const e = ((await (await fetch(`${app.url}/api/media/${media.asset.id}/extraction`)).json()) as { extraction: { status: string; phase: string | null } }).extraction;
      seen.add(`${e.status}:${e.phase}`);
      if (e.status === 'failed' || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toContain('processing:extracting-audio');
    expect(JSON.stringify([...seen])).not.toMatch(/%|percent|progress/i);
  });
  it('bounds concurrency: one extraction at a time by default, later ones wait in a bounded queue', async () => {
    let active = 0, peak = 0;
    const slow = fakeExtractor();
    const inner = slow.inspect.bind(slow);
    slow.inspect = async (...a) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 80)); try { return await inner(...a); } finally { active -= 1; } };
    app = await startTestApp({ extraction: { extractor: slow, maxConcurrent: 1, maxQueued: 5 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(((await (await upload(app, new Uint8Array(fixture('sample.mp4')), `a${i}.mp4`)).json()) as MediaResponse).media.asset.id);
    for (const id of ids) expect((await waitForExtraction(app, id)).status).toBe('completed');
    expect(peak).toBe(1);
  });
  it('rejects extraction with server-busy when the extraction queue is full (media stays ready)', async () => {
    const blocker = fakeExtractor({ hang: 'frames' });
    app = await startTestApp({ extraction: { extractor: blocker, maxConcurrent: 1, maxQueued: 0, limits: { timeoutMs: 400 } } });
    const first = ((await (await upload(app, new Uint8Array(fixture('sample.mp4')), 'a.mp4')).json()) as MediaResponse).media.asset.id;
    await waitForStatus(app, first, ['ready']);
    await new Promise((r) => setTimeout(r, 100));
    const second = ((await (await upload(app, new Uint8Array(fixture('sample.mp4')), 'b.mp4')).json()) as MediaResponse).media.asset.id;
    const ready = await waitForStatus(app, second, ['ready']);
    const e = await waitForExtraction(app, second);
    expect(ready.asset.status).toBe('ready');
    expect(e).toMatchObject({ status: 'failed', errors: [{ code: 'server-busy', stage: 'queue', fatal: true }] });
  });
});

async function expectNoExtractionDir(a: TestApp, id: string) {
  const { eventually } = await import('./helpers');
  await eventually(async () => !(await a.files()).includes(`${id}.extraction`));
}
const id0 = (a: TestApp) => [...(a.repository as unknown as { records: Map<string, unknown> }).records.keys()][0]!;
