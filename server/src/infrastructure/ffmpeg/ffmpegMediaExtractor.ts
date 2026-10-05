import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { AUDIO_FORMAT } from '@/domain/extraction/extraction';
import { parseSrt, type RawCue } from '@/domain/extraction/subtitles';
import { ExtractionError } from '../../application/errors';
import type { ExtractedAudio, ExtractedFrame, ExtractionContext, MediaExtractor } from '../../application/extractionPorts';
import type { AudioStreamInfo, StreamInventory, SubtitleStreamInfo } from '../../application/extractionTypes';
import type { MediaInput } from '../../application/ports';
import { buildFfprobeArgs, inputArgs, summarizeStreams } from './ffprobe';
import { ProcessError, runBinary } from './processRunner';
import type { FfmpegPaths } from './ffmpegMediaProcessor';

/** WAV header written by FFmpeg with `-fflags +bitexact` (no LIST chunk): bytes before the PCM data. */
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = AUDIO_FORMAT.sampleRate * AUDIO_FORMAT.channels * 2;
/** Bounds a single short FFmpeg invocation (one frame, one probe) regardless of the job timeout. */
const SINGLE_STEP_TIMEOUT_MS = 60_000;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Resolves `parts` under `base` and refuses anything that would leave it. Parts are server-generated, this is defence in depth. */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = resolve(base);
  const p = resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + sep)) throw new ExtractionError('invalid-output');
  return p;
}

/** Reads width/height from a JPEG's start-of-frame marker. Returns null if not a JPEG. */
export function readJpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1] ?? 0;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = ((buf[i + 2] ?? 0) << 8) | (buf[i + 3] ?? 0);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = ((buf[i + 5] ?? 0) << 8) | (buf[i + 6] ?? 0);
      const width = ((buf[i + 7] ?? 0) << 8) | (buf[i + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * FFmpeg implementation of the extraction port. Every invocation keeps the
 * Checkpoint 2 controls: argv arrays through `runBinary` (shell: false,
 * minimal environment, closed stdin, stdout cap, kill on abort),
 * `-protocol_whitelist file`, a demuxer forced from the verified container,
 * server-generated output names under the job's extraction directory, and
 * bounded outputs. Partial outputs are removed on every failure path.
 */
export class FfmpegMediaExtractor implements MediaExtractor {
  constructor(private readonly paths: FfmpegPaths) {}

  async inspect(input: MediaInput, signal: AbortSignal): Promise<StreamInventory> {
    const result = await this.run(this.paths.ffprobePath, buildFfprobeArgs(input.path, input.container), signal);
    if (result.exitCode !== 0) throw new ExtractionError('invalid-media');
    let json: unknown;
    try { json = JSON.parse(result.stdout); } catch { throw new ExtractionError('invalid-media'); }
    const inventory = summarizeStreams(json);
    if (!inventory) throw new ExtractionError('invalid-media');
    return inventory;
  }

  async extractAudio(ctx: ExtractionContext, stream: AudioStreamInfo, ordinal: number): Promise<ExtractedAudio> {
    const artifact = `audio/aud-${ordinal}.wav`;
    const out = safeJoin(ctx.workspace.dir, artifact);
    await mkdir(safeJoin(ctx.workspace.dir, 'audio'), { recursive: true, mode: 0o700 });
    const max = ctx.limits.maxAudioBytes;
    const args = [
      '-v', 'error', '-hide_banner', '-nostdin', ...inputArgs(ctx.input.path, ctx.input.container),
      '-map', `0:${stream.streamIndex}`, '-vn', '-sn', '-dn', '-map_metadata', '-1',
      '-ac', String(AUDIO_FORMAT.channels), '-ar', String(AUDIO_FORMAT.sampleRate), '-c:a', AUDIO_FORMAT.codec,
      '-fflags', '+bitexact', '-flags:a', '+bitexact', '-fs', String(max + 1), '-threads', '1', '-f', AUDIO_FORMAT.container, '-y', out,
    ];
    try {
      ctx.stats.processes += 1;
      const result = await this.run(this.paths.ffmpegPath, args, ctx.signal);
      if (result.exitCode !== 0) throw new ExtractionError('extraction-failed');
      const { size } = await stat(out).catch(() => ({ size: 0 }));
      if (size > max) throw new ExtractionError('limit-exceeded');
      if (size < WAV_HEADER_BYTES) throw new ExtractionError('extraction-failed');
      return { artifact, sizeBytes: size, durationSeconds: round3((size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND), sha256: await sha256(out) };
    } catch (e) {
      await rm(out, { force: true }).catch(() => undefined); // never leave partial output
      throw e;
    }
  }

  async extractSubtitleCues(ctx: ExtractionContext, stream: SubtitleStreamInfo): Promise<RawCue[]> {
    const args = [
      '-v', 'error', '-hide_banner', '-nostdin', ...inputArgs(ctx.input.path, ctx.input.container),
      '-map', `0:${stream.streamIndex}`, '-an', '-vn', '-dn', '-f', 'srt', '-',
    ];
    ctx.stats.processes += 1;
    let result;
    try {
      result = await this.run(this.paths.ffmpegPath, args, ctx.signal, ctx.limits.maxSubtitleBytes);
    } catch (e) {
      if (e instanceof ProcessError && e.kind === 'output-too-large') throw new ExtractionError('limit-exceeded');
      throw e;
    }
    if (result.exitCode !== 0) throw new ExtractionError('extraction-failed');
    return parseSrt(result.stdout);
  }

  async sampleFrame(ctx: ExtractionContext, timestampSeconds: number, index: number): Promise<ExtractedFrame | null> {
    const name = `frm-${String(index).padStart(5, '0')}`;
    const artifact = `frames/${name}.jpg`;
    const out = safeJoin(ctx.workspace.dir, artifact);
    await mkdir(safeJoin(ctx.workspace.dir, 'frames'), { recursive: true, mode: 0o700 });
    const { maxWidth, maxHeight } = ctx.limits.frame;
    // Fast input seek (-ss before -i): jump to the nearest keyframe, then decode to the exact time.
    const args = [
      '-v', 'error', '-hide_banner', '-nostdin', '-ss', timestampSeconds.toFixed(3), ...inputArgs(ctx.input.path, ctx.input.container),
      '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
      '-vf', `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', '4', '-pix_fmt', 'yuvj420p', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-threads', '1', '-f', 'image2', '-update', '1', '-y', out,
    ];
    try {
      ctx.stats.processes += 1;
      const result = await this.run(this.paths.ffmpegPath, args, ctx.signal, undefined, SINGLE_STEP_TIMEOUT_MS);
      const info = await stat(out).catch(() => null);
      if (result.exitCode !== 0 || !info || info.size === 0) { await rm(out, { force: true }); return null; }
      const dims = await readHeader(out);
      if (!dims) throw new ExtractionError('invalid-output');
      return { artifact, width: dims.width, height: dims.height, sizeBytes: info.size };
    } catch (e) {
      await rm(out, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  private async run(binary: string, args: string[], signal: AbortSignal, maxStdoutBytes?: number, stepTimeoutMs?: number) {
    const combined = stepTimeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(stepTimeoutMs)]) : signal;
    try {
      return await runBinary(binary, args, { signal: combined, maxStdoutBytes });
    } catch (e) {
      if (e instanceof ProcessError && e.kind === 'aborted') throw new ExtractionError('timeout');
      if (e instanceof ProcessError && e.kind === 'output-too-large') throw e;
      throw new ExtractionError('extraction-failed');
    }
  }
}

async function readHeader(path: string) {
  const handle = await open(path, 'r');
  try {
    const buf = new Uint8Array(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return readJpegSize(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
