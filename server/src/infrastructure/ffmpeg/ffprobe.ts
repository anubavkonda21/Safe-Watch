import type { ContainerFormat } from '@/domain/media/container';
import { normalizeMetadata } from '@/domain/media/metadata';
import type { MediaMetadata } from '@/domain/media/asset';

/**
 * Demuxer forced for each container the signature check allows. Forcing the
 * input format means FFmpeg will not auto-detect exotic demuxers (HLS, concat,
 * etc.) that could reference other files or URLs from inside an upload.
 */
export const DEMUXER: Record<ContainerFormat, string> = {
  mp4: 'mov',
  quicktime: 'mov',
  matroska: 'matroska',
  webm: 'matroska',
  avi: 'avi',
};

/** Flags shared by every invocation. `file` is the only protocol FFmpeg may open. */
const SAFE_INPUT = ['-protocol_whitelist', 'file'] as const;

export const buildFfprobeArgs = (path: string, container: ContainerFormat): string[] => [
  '-v', 'error', '-hide_banner', ...SAFE_INPUT, '-f', DEMUXER[container],
  '-print_format', 'json', '-show_format', '-show_streams', '-i', path,
];

export const buildDecodeCheckArgs = (path: string, container: ContainerFormat): string[] => [
  '-v', 'error', '-hide_banner', '-nostdin', ...SAFE_INPUT, '-f', DEMUXER[container], '-i', path,
  '-t', '2', '-map', '0:v:0', '-an', '-sn', '-dn', '-threads', '1', '-f', 'null', '-',
];

export interface ProbeSummary {
  durationSeconds: number | null;
  video: { codec: string | null; width: number | null; height: number | null; frameRate: number | null } | null;
  audioCodec: string | null;
  hasAudio: boolean;
  hasSubtitles: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length < 64 ? v : null);

/** "30000/1001" → 29.97; "0/0" → null. */
export function parseFrameRate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const [n, d] = v.split('/').map(Number);
  if (n === undefined || d === undefined || !Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
  return Math.round((n / d) * 1000) / 1000;
}

/** Reduces raw FFprobe JSON to the few facts SafeWatch uses. Tolerates missing or odd fields. Returns null if the shape is unusable. */
export function summarizeProbe(json: unknown): ProbeSummary | null {
  if (!isObject(json) || !Array.isArray(json.streams)) return null;
  const streams = json.streams.filter(isObject);
  const isCover = (s: Record<string, unknown>) => isObject(s.disposition) && s.disposition.attached_pic === 1;
  const video = streams.find((s) => s.codec_type === 'video' && !isCover(s));
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = isObject(json.format) ? json.format : {};

  return {
    durationSeconds: num(format.duration) ?? (video ? num(video.duration) : null),
    video: video
      ? {
          codec: str(video.codec_name),
          width: num(video.width),
          height: num(video.height),
          frameRate: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
        }
      : null,
    audioCodec: audio ? str(audio.codec_name) : null,
    hasAudio: audio !== undefined,
    hasSubtitles: streams.some((s) => s.codec_type === 'subtitle'),
  };
}

/** Normalises a probe summary into SafeWatch metadata (source "ffprobe"). Requires a video stream. */
export function summaryToMetadata(summary: ProbeSummary): MediaMetadata | null {
  if (!summary.video) return null;
  const base = normalizeMetadata(
    { durationSeconds: summary.durationSeconds, width: summary.video.width, height: summary.video.height, frameRate: summary.video.frameRate },
    'ffprobe',
  );
  return {
    ...base,
    videoCodec: summary.video.codec,
    audioCodec: summary.audioCodec,
    hasAudio: summary.hasAudio,
    hasSubtitles: summary.hasSubtitles,
  };
}
