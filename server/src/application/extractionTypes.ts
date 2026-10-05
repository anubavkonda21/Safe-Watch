import type { FrameSamplingConfig, TrackDisposition } from '@/domain/extraction/extraction';

export interface AudioStreamInfo {
  streamIndex: number;
  language: string | null;
  title: string | null;
  disposition: TrackDisposition;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitRate: number | null;
  durationSeconds: number | null;
}

export interface SubtitleStreamInfo {
  streamIndex: number;
  language: string | null;
  title: string | null;
  disposition: TrackDisposition;
  codec: string | null;
}

/** Normalised result of probing a file's streams (not raw FFprobe output). */
export interface StreamInventory {
  durationSeconds: number | null;
  video: { width: number | null; height: number | null } | null;
  audio: AudioStreamInfo[];
  subtitles: SubtitleStreamInfo[];
}

export interface ExtractionLimits {
  timeoutMs: number;
  frame: FrameSamplingConfig;
  maxFrameBytes: number;
  maxAudioBytes: number;
  maxAudioTracks: number;
  maxCues: number;
  maxSubtitleBytes: number;
}
