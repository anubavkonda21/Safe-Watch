import type { FrameSamplingConfig } from './extraction';

export const DEFAULT_FRAME_SAMPLING: FrameSamplingConfig = {
  intervalSeconds: 10,
  maxFrames: 300,
  maxWidth: 768,
  maxHeight: 768,
};

export interface FramePlan {
  timestamps: number[];
  effectiveIntervalSeconds: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Deterministic frame-sampling plan.
 *
 * The number of samples is `ceil(duration / interval)`, capped at `maxFrames`
 * (so a 3-hour video with a 1-second interval still yields at most
 * `maxFrames` frames, spread over the whole video rather than stopping
 * early). The video is then divided into that many EQUAL intervals and one
 * frame is sampled at the middle of each: t = (i + 0.5) × duration / count.
 * Sampling mid-interval avoids the usually black first frame and end-of-file
 * seeks, and equal division guarantees every timestamp lies inside the media.
 * The step actually used is returned as `effectiveIntervalSeconds` (it can
 * differ slightly from the requested interval, or be much larger when the cap
 * applies). Same inputs → same timestamps, rounded to milliseconds.
 */
export function planFrameTimestamps(durationSeconds: number, config: FrameSamplingConfig): FramePlan {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { timestamps: [], effectiveIntervalSeconds: config.intervalSeconds };
  const requested = Math.max(config.intervalSeconds, durationSeconds / config.maxFrames);
  const count = Math.max(1, Math.min(config.maxFrames, Math.ceil(durationSeconds / requested - 1e-9)));
  const step = durationSeconds / count;
  const timestamps = Array.from({ length: count }, (_, i) => round3((i + 0.5) * step));
  return { timestamps, effectiveIntervalSeconds: round3(step) };
}

/** Output size that fits inside the box, preserving aspect ratio and never upscaling. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
