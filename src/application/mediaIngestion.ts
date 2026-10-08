import type { AnalysisStatus } from '@/domain/analysis/job';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import type { VisualAnalysis } from '@/domain/vision/visualAnalysis';
import type { MediaAsset } from '@/domain/media/asset';
import { PENDING_METADATA } from '@/domain/media/asset';
import { CONTAINER_INFO, SNIFF_BYTES, detectContainer } from '@/domain/media/container';
import { MediaIngestionError } from '@/domain/media/errors';
import { containerMatchesExtension, sanitizeFilename, validateMediaFile } from '@/domain/media/validation';
import type { MediaProcessor } from './mediaProcessor';
import type { MediaUploader } from './mediaUploader';

export type MediaIngestionDeps = {
  maxBytes: number;
  newId?: () => string;
  now?: () => Date;
} & (
  | { processor: MediaProcessor; uploader?: undefined }
  | { uploader: MediaUploader; processor?: undefined }
);

export interface PreparedMedia {
  asset: MediaAsset;
  analysis: AnalysisStatus;
}

export interface MediaIngestion {
  /** `server`: files are uploaded and inspected remotely. `local`: inspected in the browser only. */
  readonly mode: 'local' | 'server';
  /** Validates the file (name, MIME, size, content signature) and creates an `accepted` asset. Throws MediaIngestionError. */
  accept(file: File): Promise<MediaAsset>;
  /** Makes the asset ready: uploads it (server mode) or reads metadata locally. Throws MediaIngestionError. */
  prepare(file: File, asset: MediaAsset, hooks?: { onProgress?: (fraction: number) => void }): Promise<PreparedMedia>;
  /** Server mode: follows extraction of audio, subtitles and frames. Local mode: resolves null (nothing is extracted). */
  extract(asset: MediaAsset, hooks?: { onUpdate?: (extraction: MediaExtraction) => void }): Promise<MediaExtraction | null>;
  /** Server mode: follows text analysis (transcript + subtitle timeline). Local mode: resolves null. */
  analyzeText(asset: MediaAsset, hooks?: { onUpdate?: (textAnalysis: TextAnalysis) => void }): Promise<TextAnalysis | null>;
  /** Server mode: follows visual analysis (frame observations). Local mode, or an uploader without it: resolves null. */
  analyzeVisual(asset: MediaAsset, hooks?: { onUpdate?: (visual: VisualAnalysis) => void }): Promise<VisualAnalysis | null>;
  /** Best-effort removal of server-side data for a finished asset. */
  remove(asset: MediaAsset): Promise<void>;
}

export function createMediaIngestion(deps: MediaIngestionDeps): MediaIngestion {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  return {
    mode: deps.uploader ? 'server' : 'local',

    async accept(file) {
      const check = validateMediaFile(file, deps.maxBytes);
      if (!check.ok) throw new MediaIngestionError(check.code);

      // Only the first bytes are read: large files are never loaded into memory.
      let head: Uint8Array;
      try {
        head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
      } catch {
        throw new MediaIngestionError('processing-failed', 'Could not read the file');
      }
      const container = detectContainer(head);
      if (!container || !containerMatchesExtension(file.name, container)) {
        throw new MediaIngestionError('invalid-media');
      }

      const info = CONTAINER_INFO[container];
      return {
        id: newId(),
        filename: sanitizeFilename(file.name),
        mimeType: info.mimeType,
        container,
        typeLabel: info.label,
        sizeBytes: file.size,
        status: 'accepted',
        metadata: PENDING_METADATA,
        createdAt: now().toISOString(),
        failure: null,
      };
    },

    async prepare(file, asset, hooks = {}) {
      try {
        if (deps.uploader) {
          const { asset: remote, analysis } = await deps.uploader.upload(file, { onProgress: hooks.onProgress });
          if (remote.status === 'failed') throw new MediaIngestionError(remote.failure?.code ?? 'processing-failed');
          return { asset: remote, analysis: analysis.status };
        }
        const metadata = await deps.processor.extractMetadata(file);
        return { asset: { ...asset, metadata }, analysis: 'not_started' };
      } catch (e) {
        throw e instanceof MediaIngestionError ? e : new MediaIngestionError('processing-failed');
      }
    },

    async extract(asset, hooks = {}) {
      if (!deps.uploader) return null;
      return deps.uploader.waitForExtraction(asset.id, { onUpdate: hooks.onUpdate });
    },

    async analyzeText(asset, hooks = {}) {
      if (!deps.uploader) return null;
      return deps.uploader.waitForTextAnalysis(asset.id, { onUpdate: hooks.onUpdate });
    },

    async analyzeVisual(asset, hooks = {}) {
      if (!deps.uploader?.waitForVisualAnalysis) return null;
      return deps.uploader.waitForVisualAnalysis(asset.id, { onUpdate: hooks.onUpdate });
    },

    async remove(asset) {
      await deps.uploader?.remove(asset.id);
    },
  };
}
