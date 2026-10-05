import type { AnalysisStatus } from '../analysis/job';
import type { MediaExtraction } from '../extraction/extraction';
import type { MediaAsset } from './asset';
import { toFailure, type MediaFailure } from './errors';

/**
 * Ingestion session state machine. Pure and framework-free.
 *
 *   idle → validating → accepted → processing → ready
 *               ↓                       ↓
 *             failed ←──────────────────┘
 *
 * `idle`/`validating` exist before an asset does; accepted/processing/ready
 * carry the asset; `failed` carries only a typed failure.
 *
 * While processing, `phase` says what is happening: `uploading` (bytes are
 * going to the server; `uploadFraction` is real measured progress) or
 * `inspecting` (the server/browser is reading the media; no measurable
 * progress). `ready` is MEDIA readiness; `extraction` (audio, subtitles, frames)
 * and `analysis` are tracked separately.
 * Events that are illegal in the current state are ignored (state returned as-is).
 */
export type IngestionState =
  | { status: 'idle' }
  | { status: 'validating'; fileName: string }
  | { status: 'accepted'; asset: MediaAsset }
  | { status: 'processing'; asset: MediaAsset; phase: ProcessingPhase; uploadFraction: number | null }
  | { status: 'ready'; asset: MediaAsset; analysis: AnalysisStatus; extraction: MediaExtraction | null }
  | { status: 'failed'; failure: MediaFailure };

export type ProcessingPhase = 'uploading' | 'inspecting';

export type IngestionEvent =
  | { type: 'select'; fileName: string }
  | { type: 'accepted'; asset: MediaAsset }
  | { type: 'process'; phase?: ProcessingPhase }
  | { type: 'progress'; fraction: number }
  | { type: 'ready'; asset: MediaAsset; analysis?: AnalysisStatus }
  | { type: 'extraction'; extraction: MediaExtraction }
  | { type: 'fail'; error: unknown }
  | { type: 'reset' };

export const initialIngestionState: IngestionState = { status: 'idle' };

export function ingestionReducer(state: IngestionState, event: IngestionEvent): IngestionState {
  switch (event.type) {
    case 'select':
      return state.status === 'idle' || state.status === 'ready' || state.status === 'failed'
        ? { status: 'validating', fileName: event.fileName }
        : state;
    case 'accepted':
      return state.status === 'validating'
        ? { status: 'accepted', asset: { ...event.asset, status: 'accepted' } }
        : state;
    case 'process':
      return state.status === 'accepted'
        ? {
            status: 'processing',
            asset: { ...state.asset, status: 'processing' },
            phase: event.phase ?? 'inspecting',
            uploadFraction: event.phase === 'uploading' ? 0 : null,
          }
        : state;
    case 'progress': {
      if (state.status !== 'processing' || state.phase !== 'uploading') return state;
      const fraction = Math.min(1, Math.max(0, event.fraction));
      // Never move backwards; reaching 100% means the upload is done and the server is now inspecting.
      const next = Math.max(fraction, state.uploadFraction ?? 0);
      return { ...state, uploadFraction: next, phase: next >= 1 ? 'inspecting' : 'uploading' };
    }
    case 'ready':
      return state.status === 'processing'
        ? { status: 'ready', asset: { ...event.asset, status: 'ready' }, analysis: event.analysis ?? 'not_started', extraction: null }
        : state;
    case 'extraction':
      // Extraction belongs to the ready asset; updates for a replaced asset are ignored.
      return state.status === 'ready' && state.asset.id === event.extraction.mediaId ? { ...state, extraction: event.extraction } : state;
    case 'fail':
      return state.status === 'validating' || state.status === 'processing'
        ? { status: 'failed', failure: toFailure(event.error) }
        : state;
    case 'reset':
      return state.status === 'validating' || state.status === 'processing' ? state : initialIngestionState;
  }
}

export const isBusy = (s: IngestionState) => s.status === 'validating' || s.status === 'processing';
