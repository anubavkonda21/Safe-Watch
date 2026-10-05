import { NOT_STARTED, type AnalysisState } from '@/domain/analysis/job';
import type { MediaResource } from '@/domain/api/contract';
import type { MediaAsset, MediaAssetStatus, MediaMetadata } from '@/domain/media/asset';
import type { MediaErrorCode } from '@/domain/media/errors';

/** Server-side aggregate: the media asset plus separate analysis state and expiry. */
export interface MediaRecord {
  asset: MediaAsset;
  analysis: AnalysisState;
  /** Epoch milliseconds after which the record and its file are discarded. */
  expiresAt: number;
}

export class InvalidTransitionError extends Error {
  constructor(from: MediaAssetStatus, to: MediaAssetStatus) {
    super(`Illegal media transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** uploaded → processing → ready | failed; uploaded → failed. Terminal states do not move. */
const ALLOWED: Record<MediaAssetStatus, readonly MediaAssetStatus[]> = {
  accepted: [],
  uploaded: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  ready: [],
  failed: [],
};

function move(record: MediaRecord, to: MediaAssetStatus, patch: Partial<MediaAsset>): MediaRecord {
  if (!ALLOWED[record.asset.status].includes(to)) throw new InvalidTransitionError(record.asset.status, to);
  return { ...record, asset: { ...record.asset, ...patch, status: to } };
}

export const createUploadedRecord = (asset: MediaAsset, now: number, retentionMs: number): MediaRecord => ({
  asset: { ...asset, status: 'uploaded' },
  analysis: NOT_STARTED,
  expiresAt: now + retentionMs,
});

export const markProcessing = (r: MediaRecord): MediaRecord => move(r, 'processing', {});
export const markReady = (r: MediaRecord, metadata: MediaMetadata): MediaRecord => move(r, 'ready', { metadata });
export const markFailed = (r: MediaRecord, code: MediaErrorCode): MediaRecord => move(r, 'failed', { failure: { code } });

export const toResource = (r: MediaRecord): MediaResource => ({ asset: r.asset, analysis: r.analysis });
