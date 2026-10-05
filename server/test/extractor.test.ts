import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractionError } from '../src/application/errors';
import type { ExtractionContext } from '../src/application/extractionPorts';
import { FfmpegMediaExtractor, readJpegSize, safeJoin } from '../src/infrastructure/ffmpeg/ffmpegMediaExtractor';
import { runBinary } from '../src/infrastructure/ffmpeg/processRunner';
import { defaultExtractionLimits, generateVideo, hasFfmpeg } from './helpers';

const fx = (n: string) => join(fileURLToPath(new URL('./fixtures/', import.meta.url)), n);
const extractor = new FfmpegMediaExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'sw-ext-')); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

const ctxFor = (path: string, container: 'mp4' | 'matroska' | 'webm', limits = defaultExtractionLimits(), signal = new AbortController().signal): ExtractionContext =>
  ({ input: { path, container }, workspace: { dir: work }, signal, limits, stats: { processes: 0 } });
const never = new AbortController().signal;

describe('safeJoin (output path safety)', () => {
  it('stays inside the base directory and refuses traversal', () => {
    expect(safeJoin('/base/dir', 'audio', 'aud-0.wav')).toBe('/base/dir/audio/aud-0.wav');
    for (const bad of ['..', '../x', 'audio/../../x', '/etc/passwd']) expect(() => safeJoin('/base/dir', bad)).toThrow(ExtractionError);
  });
});

describe('readJpegSize', () => {
  it('reads dimensions from a real JPEG and rejects non-JPEG bytes', async () => {
    const out = join(work, 'f.jpg');
    await runBinary('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=123x45', '-frames:v', '1', out]);
    expect(readJpegSize(new Uint8Array(await readFile(out)))).toEqual({ width: 123, height: 45 });
    expect(readJpegSize(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(readJpegSize(new Uint8Array(0))).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)('FfmpegMediaExtractor (real FFmpeg)', () => {
  it('inspects streams: tracks, languages, titles, dispositions, codecs', async () => {
    const inv = await extractor.inspect({ path: fx('multi.mkv'), container: 'matroska' }, never);
    expect(inv.durationSeconds).toBeCloseTo(3, 0);
    expect(inv.video).toMatchObject({ width: 160, height: 120 });
    expect(inv.audio).toMatchObject([
      { streamIndex: 1, language: 'eng', title: 'English mono', codec: 'aac', sampleRate: 44100, channels: 1, disposition: { default: true } },
      { streamIndex: 2, language: 'spa', title: null, codec: 'aac', sampleRate: 48000, channels: 1, disposition: { default: false } },
    ]);
    expect(inv.subtitles).toMatchObject([
      { streamIndex: 3, language: 'eng', codec: 'subrip', disposition: { default: true } },
      { streamIndex: 4, language: 'spa', title: 'Spanish (ASS)', codec: 'ass' },
    ]);
  });
  it('reports zero audio and zero subtitle tracks without failing', async () => {
    const inv = await extractor.inspect({ path: fx('sample-silent.webm'), container: 'webm' }, never);
    expect(inv.audio).toEqual([]);
    expect(inv.subtitles).toEqual([]);
  });
  it('extracts analysis-format audio: 16 kHz mono PCM s16le WAV with correct size and duration', async () => {
    const ctx = ctxFor(fx('multi.mkv'), 'matroska');
    const inv = await extractor.inspect(ctx.input, never);
    const out = await extractor.extractAudio(ctx, inv.audio[1]!, 1);
    expect(out.artifact).toBe('audio/aud-1.wav');
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    const probe = await runBinary('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', join(work, out.artifact)]);
    const j = JSON.parse(probe.stdout);
    expect(j.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 });
    expect(Number(j.format.duration)).toBeCloseTo(out.durationSeconds, 2);
    expect(out.sizeBytes).toBe((await stat(join(work, out.artifact))).size);
    expect(ctx.stats.processes).toBe(1);
  });
  it('extracts a text subtitle track to raw timed cues', async () => {
    const ctx = ctxFor(fx('multi.mkv'), 'matroska');
    const inv = await extractor.inspect(ctx.input, never);
    const srt = await extractor.extractSubtitleCues(ctx, inv.subtitles[0]!);
    expect(srt.map((c) => [c.startSeconds, c.endSeconds])).toEqual([[0, 0.8], [1, 2]]);
    const ass = await extractor.extractSubtitleCues(ctx, inv.subtitles[1]!);
    expect(ass.map((c) => [c.startSeconds, c.endSeconds])).toEqual([[0.2, 1.1], [1.5, 2.5]]);
  });
  it('samples a frame as JPEG at the requested size, with measured dimensions', async () => {
    const ctx = ctxFor(fx('sample.mp4'), 'mp4');
    const f = await extractor.sampleFrame(ctx, 0.5, 0);
    expect(f).toMatchObject({ artifact: 'frames/frm-00000.jpg', width: 160, height: 120 });
    const bytes = new Uint8Array(await readFile(join(work, f!.artifact)));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(f!.sizeBytes).toBe(bytes.length);
  });
  it('downscales large video to the configured box, preserving aspect ratio (never upscaling)', async () => {
    const big = join(work, 'big.mp4');
    generateVideo(big, { width: 1920, height: 1080, seconds: 2 });
    const f = await extractor.sampleFrame(ctxFor(big, 'mp4', { ...defaultExtractionLimits(), frame: { ...defaultExtractionLimits().frame, maxWidth: 640, maxHeight: 640 } }), 1, 0);
    expect(f).toMatchObject({ width: 640, height: 360 });
    const small = await extractor.sampleFrame(ctxFor(fx('sample.mp4'), 'mp4'), 0.5, 1);
    expect(small).toMatchObject({ width: 160, height: 120 });
  });
  it('returns null (not a corrupt file) when there is no frame at the requested time', async () => {
    const ctx = ctxFor(fx('sample.mp4'), 'mp4');
    expect(await extractor.sampleFrame(ctx, 500, 3)).toBeNull();
    expect(await readdir(join(work, 'frames'))).toEqual([]);
  });
  it('rejects audio above the size limit and deletes the partial output', async () => {
    const ctx = ctxFor(fx('multi.mkv'), 'matroska', { ...defaultExtractionLimits(), maxAudioBytes: 10_000 });
    const inv = await extractor.inspect(ctx.input, never);
    await expect(extractor.extractAudio(ctx, inv.audio[0]!, 0)).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(await readdir(join(work, 'audio'))).toEqual([]);
  });
  it('caps subtitle output', async () => {
    const ctx = ctxFor(fx('multi.mkv'), 'matroska', { ...defaultExtractionLimits(), maxSubtitleBytes: 10 });
    const inv = await extractor.inspect(ctx.input, never);
    await expect(extractor.extractSubtitleCues(ctx, inv.subtitles[0]!)).rejects.toMatchObject({ code: 'limit-exceeded' });
  });
  it('aborts running work as a timeout and leaves no partial files', async () => {
    const ac = new AbortController(); ac.abort();
    const ctx = ctxFor(fx('multi.mkv'), 'matroska', defaultExtractionLimits(), ac.signal);
    await expect(extractor.extractAudio(ctx, { streamIndex: 1 } as never, 0)).rejects.toMatchObject({ code: 'timeout' });
    await expect(extractor.sampleFrame(ctx, 1, 0)).rejects.toMatchObject({ code: 'timeout' });
    expect(await readdir(join(work, 'audio'))).toEqual([]);
    expect(await readdir(join(work, 'frames'))).toEqual([]);
  });
  it('treats a stream index that does not exist as a failure, not a crash', async () => {
    const ctx = ctxFor(fx('multi.mkv'), 'matroska');
    await expect(extractor.extractAudio(ctx, { streamIndex: 99 } as never, 0)).rejects.toMatchObject({ code: 'extraction-failed' });
    expect(await readdir(join(work, 'audio'))).toEqual([]);
  });
  it('rejects non-media input as invalid-media', async () => {
    await expect(extractor.inspect({ path: fx('garbage-with-mp4-header.mp4'), container: 'mp4' }, never)).rejects.toMatchObject({ code: 'invalid-media' });
  });
  it('never lets stream indexes or timestamps inject arguments (values are numbers formatted by us)', async () => {
    const ctx = ctxFor(fx('multi.mkv'), 'matroska');
    await expect(extractor.extractAudio(ctx, { streamIndex: '1; touch /tmp/sw-pwned' as unknown as number } as never, 0)).rejects.toBeInstanceOf(ExtractionError);
    const { exitCode } = await runBinary('ls', ['/tmp/sw-pwned']).catch(() => ({ exitCode: 2 }));
    expect(exitCode).not.toBe(0);
  });
});
