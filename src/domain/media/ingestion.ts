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
 * Events that are illegal in the current state are ignored (state returned as-is).
 */
export type IngestionState =
  | { status: 'idle' }
  | { status: 'validating'; fileName: string }
  | { status: 'accepted'; asset: MediaAsset }
  | { status: 'processing'; asset: MediaAsset }
  | { status: 'ready'; asset: MediaAsset }
  | { status: 'failed'; failure: MediaFailure };

export type IngestionEvent =
  | { type: 'select'; fileName: string }
  | { type: 'accepted'; asset: MediaAsset }
  | { type: 'process' }
  | { type: 'ready'; asset: MediaAsset }
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
        ? { status: 'processing', asset: { ...state.asset, status: 'processing' } }
        : state;
    case 'ready':
      return state.status === 'processing'
        ? { status: 'ready', asset: { ...event.asset, status: 'ready' } }
        : state;
    case 'fail':
      return state.status === 'validating' || state.status === 'processing'
        ? { status: 'failed', failure: toFailure(event.error) }
        : state;
    case 'reset':
      return state.status === 'validating' || state.status === 'processing' ? state : initialIngestionState;
  }
}

export const isBusy = (s: IngestionState) => s.status === 'validating' || s.status === 'processing';
