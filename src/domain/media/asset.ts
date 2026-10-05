import type { ContainerFormat } from './container';
import type { MediaFailure } from './errors';

/**
 * Lifecycle of an asset once it has passed validation. `idle` and
 * `validating` describe the ingestion session (see ingestion.ts), not an asset:
 * there is no asset before validation succeeds.
 *
 *   accepted  – passed client-side validation (browser only)
 *   uploaded  – the server has received and stored the file
 *   processing – the server is inspecting it (FFprobe/FFmpeg)
 *   ready     – media is stored and understood
 *   failed    – could not be stored or understood
 *
 * This is MEDIA status. Analysis status is separate (domain/analysis/job.ts).
 */
export type MediaAssetStatus = 'accepted' | 'uploaded' | 'processing' | 'ready' | 'failed';

export type MetadataSource = 'browser' | 'ffprobe';

/**
 * How complete the technical metadata is. "unavailable" does NOT mean the
 * file is invalid; it means this processor could not read details.
 */
export type MetadataAvailability = 'pending' | 'available' | 'partial' | 'unavailable';

export type MetadataUnavailableReason = 'unsupported-by-browser' | 'timeout' | 'malformed';

/** `null` always means "unknown", never "absent" (e.g. hasAudio null ≠ false). */
export interface MediaMetadata {
  availability: MetadataAvailability;
  source: MetadataSource | null;
  unavailableReason: MetadataUnavailableReason | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean | null;
  hasSubtitles: boolean | null;
}

export interface MediaAsset {
  /** Stable reference for future analysis jobs. */
  id: string;
  /** Sanitised display name. Never used as a storage path. */
  filename: string;
  /** Canonical MIME type for the container detected from the file's bytes. */
  mimeType: string;
  container: ContainerFormat;
  /** Human-readable detected type, e.g. "MP4 video". */
  typeLabel: string;
  sizeBytes: number;
  status: MediaAssetStatus;
  metadata: MediaMetadata;
  /** ISO-8601 timestamp. */
  createdAt: string;
  failure: MediaFailure | null;
}

export const PENDING_METADATA: MediaMetadata = {
  availability: 'pending',
  source: null,
  unavailableReason: null,
  durationSeconds: null,
  width: null,
  height: null,
  frameRate: null,
  videoCodec: null,
  audioCodec: null,
  hasAudio: null,
  hasSubtitles: null,
};
