import {
  PENDING_METADATA,
  type MediaMetadata,
  type MetadataSource,
  type MetadataUnavailableReason,
} from './asset';

export interface RawMetadata {
  durationSeconds?: unknown;
  width?: unknown;
  height?: unknown;
  frameRate?: unknown;
}

const MAX_DIMENSION = 16384;
const MAX_DURATION_SECONDS = 60 * 60 * 24; // 24h: anything longer is treated as malformed
const MAX_FRAME_RATE = 1000;

const positive = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null;

const dimension = (v: unknown): number | null => {
  const n = positive(v, MAX_DIMENSION);
  return n === null ? null : Math.round(n);
};

/**
 * Turns whatever a processor reported into trusted metadata. Browser media
 * elements can report NaN/Infinity/0 for streams or unsupported codecs; those
 * values are rejected rather than displayed.
 *
 * `fallbackReason` explains emptiness when the processor itself had nothing
 * (e.g. timeout). Present-but-invalid values are reported as `malformed`.
 */
export function normalizeMetadata(
  raw: RawMetadata,
  source: MetadataSource,
  fallbackReason: MetadataUnavailableReason = 'unsupported-by-browser',
): MediaMetadata {
  const durationSeconds = positive(raw.durationSeconds, MAX_DURATION_SECONDS);
  const width = dimension(raw.width);
  const height = dimension(raw.height);
  const frameRate = positive(raw.frameRate, MAX_FRAME_RATE);

  const reported = [raw.durationSeconds, raw.width, raw.height, raw.frameRate].some(
    (v) => v !== undefined && v !== null && v !== 0,
  );
  const known = [durationSeconds, width !== null && height !== null ? 1 : null].filter((v) => v !== null).length;

  if (known === 0) {
    return {
      ...PENDING_METADATA,
      availability: 'unavailable',
      source,
      unavailableReason: reported ? 'malformed' : fallbackReason,
    };
  }
  return {
    ...PENDING_METADATA,
    availability: known === 2 ? 'available' : 'partial',
    source,
    durationSeconds,
    width: width !== null && height !== null ? width : null,
    height: width !== null && height !== null ? height : null,
    frameRate,
  };
}
