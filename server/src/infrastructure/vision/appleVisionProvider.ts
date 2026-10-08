import { access } from 'node:fs/promises';
import type { RawObservation } from '@/domain/vision/observation';
import { VisionError, type VisionFrameInput, type VisionFrameResult, type VisionRequest, type VisualAnalysisProvider } from '../../application/visualPorts';
import { ProcessError, runBinary } from '../ffmpeg/processRunner';

export interface AppleVisionOptions {
  /** Path of the compiled `safewatch-vision` helper (see native/apple-vision). */
  binaryPath: string;
  /** Hard cap on helper output. Eight frames produce a few KB. */
  maxOutputBytes?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The helper reports `decode-failed` for anything that is not a decodable JPEG/PNG. */
const FRAME_ERRORS: Record<string, VisionFrameResult['error']> = { 'decode-failed': 'invalid-frame', 'inference-failed': 'inference-failed' };

/**
 * Maps the helper's JSON document to per-frame results. Pure and defensive:
 * the helper echoes frames by position, so results are matched by index and a
 * missing or malformed entry becomes `inference-failed` for that frame only.
 * Throws VisionError('invalid-response') only when the document itself is unusable.
 */
export function parseAppleVisionJson(json: unknown, frames: readonly VisionFrameInput[]): VisionFrameResult[] {
  if (!isObject(json) || json.provider !== 'apple-vision' || !Array.isArray(json.frames)) throw new VisionError('invalid-response');
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const f of json.frames) if (isObject(f) && Number.isInteger(f.index)) byIndex.set(f.index as number, f);
  return frames.map((input, i) => {
    const f = byIndex.get(i);
    const failed = (error: NonNullable<VisionFrameResult['error']>): VisionFrameResult => ({ frameId: input.frameId, error, width: null, height: null, elapsedMs: null, observations: [] });
    if (!f) return failed('inference-failed');
    if (f.ok !== true) return failed(FRAME_ERRORS[String(f.error)] ?? 'inference-failed');
    const observations: RawObservation[] = (Array.isArray(f.observations) ? f.observations : []).filter(isObject).map((o) => ({
      type: o.type, label: o.label, confidence: o.confidence, region: o.region, text: o.text,
    }));
    return { frameId: input.frameId, error: null, width: num(f.width), height: num(f.height), elapsedMs: num(f.elapsedMs), observations };
  });
}

/**
 * Apple Vision (macOS, local, on-device) behind the VisualAnalysisProvider
 * port, through the `safewatch-vision` helper binary. Frames never leave the
 * machine. Arguments are an argv array (no shell); frame paths are
 * server-generated and passed after `--`, so they can never be read as
 * options. The helper opens only JPEG/PNG and reports undecodable input as a
 * per-frame failure. Engine stderr is discarded.
 */
export class AppleVisionProvider implements VisualAnalysisProvider {
  readonly info = { name: 'apple-vision', model: 'vision-framework' };
  private available: Promise<boolean> | null = null;

  constructor(private readonly options: AppleVisionOptions) {}

  isAvailable(): Promise<boolean> {
    this.available ??= (async () => {
      try {
        await access(this.options.binaryPath);
        return (await runBinary(this.options.binaryPath, ['--help'], { maxStdoutBytes: 64 * 1024 })).exitCode === 0;
      } catch {
        return false;
      }
    })();
    return this.available;
  }

  async analyze(frames: readonly VisionFrameInput[], request: VisionRequest): Promise<VisionFrameResult[]> {
    if (frames.length === 0) return [];
    if (!(await this.isAvailable())) throw new VisionError('provider-unavailable');
    const abortError = () => new VisionError(request.signal.reason === 'timeout' ? 'timeout' : 'cancelled');
    if (request.signal.aborted) throw abortError();

    const args = ['--min-confidence', String(request.minConfidence), '--max-labels', String(request.maxLabelsPerFrame), '--', ...frames.map((f) => f.path)];
    let result;
    try {
      result = await runBinary(this.options.binaryPath, args, { signal: request.signal, maxStdoutBytes: this.options.maxOutputBytes ?? 4 * 1024 * 1024 });
    } catch (e) {
      if (e instanceof ProcessError && e.kind === 'aborted') throw abortError();
      if (e instanceof ProcessError && e.kind === 'output-too-large') throw new VisionError('invalid-response');
      throw new VisionError('inference-failed');
    }
    if (result.exitCode !== 0) throw new VisionError('inference-failed');
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new VisionError('invalid-response'); }
    return parseAppleVisionJson(parsed, frames);
  }
}
