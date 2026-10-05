import type { MediaAsset } from '@/domain/media/asset';
import { PENDING_METADATA } from '@/domain/media/asset';
import { CONTAINER_INFO, SNIFF_BYTES, detectContainer } from '@/domain/media/container';
import { MediaIngestionError } from '@/domain/media/errors';
import { containerMatchesExtension, sanitizeFilename, validateMediaFile } from '@/domain/media/validation';
import type { MediaProcessor } from './mediaProcessor';

export interface MediaIngestionDeps {
  processor: MediaProcessor;
  maxBytes: number;
  newId?: () => string;
  now?: () => Date;
}

export interface MediaIngestion {
  /** Validates the file (name, MIME, size, content signature) and creates an `accepted` asset. Throws MediaIngestionError. */
  accept(file: File): Promise<MediaAsset>;
  /** Reads technical metadata through the processor and returns the asset with it. Throws MediaIngestionError. */
  prepare(file: File, asset: MediaAsset): Promise<MediaAsset>;
}

export function createMediaIngestion(deps: MediaIngestionDeps): MediaIngestion {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  return {
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

    async prepare(file, asset) {
      try {
        const metadata = await deps.processor.extractMetadata(file);
        return { ...asset, metadata };
      } catch (e) {
        throw e instanceof MediaIngestionError ? e : new MediaIngestionError('processing-failed');
      }
    },
  };
}
