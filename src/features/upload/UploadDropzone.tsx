import { useId, useRef, useState, type DragEvent } from 'react';
import { ingestMedia, type MetadataReader } from '@/application/ingestMedia';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import { CheckIcon, UploadIcon } from '@/components/ui/icons';
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  formatBytes,
  formatDuration,
  type SelectedVideo,
  type UploadRejection,
} from '@/domain/media/upload';
import { browserMetadataReader } from '@/infrastructure/browserMetadataReader';
import { config } from '@/infrastructure/config/env';
import { cn } from '@/lib/cn';
import './upload.css';

type State =
  | { status: 'idle' }
  | { status: 'dragging' }
  | { status: 'processing'; fileName: string }
  | { status: 'success'; video: SelectedVideo }
  | { status: 'error'; reason: UploadRejection | 'unreadable' };

const ERROR_COPY: Record<UploadRejection | 'unreadable', { title: string; body: (maxBytes: number) => string }> = {
  'unsupported-type': { title: 'This file type is not supported', body: () => `Choose a video file (${ACCEPTED_VIDEO_EXTENSIONS.join(', ').toUpperCase()}).` },
  'empty-file': { title: 'This file is empty', body: () => 'Choose a video that contains data.' },
  'too-large': { title: 'This file is too large', body: (max) => `The current limit is ${formatBytes(max)}.` },
  unreadable: { title: 'We could not read this file', body: () => 'It may be damaged. Try a different video.' },
};

interface UploadDropzoneProps {
  /** Injectable for tests and for the future server-side pipeline. */
  reader?: MetadataReader;
  maxBytes?: number;
}

/**
 * Checkpoint 0A: selects and validates a video and reads basic metadata
 * locally. Nothing is uploaded and no analysis runs. This is the entry point
 * of the future analysis workflow (Checkpoint 1: Media Ingestion).
 */
export function UploadDropzone({ reader = browserMetadataReader, maxBytes = config.maxUploadBytes }: UploadDropzoneProps) {
  const [state, setState] = useState<State>({ status: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const busy = state.status === 'processing';

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setState({ status: 'processing', fileName: file.name });
    const result = await ingestMedia(file, { reader, maxBytes });
    setState(result.ok ? { status: 'success', video: result.video } : { status: 'error', reason: result.reason });
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (busy) return;
    void handleFile(e.dataTransfer.files[0]);
  }

  function openPicker() {
    if (inputRef.current) inputRef.current.value = '';
    inputRef.current?.click();
  }

  const showDropCopy = state.status === 'idle' || state.status === 'dragging' || state.status === 'error';

  return (
    <div
      className={cn('sw-upload', state.status === 'dragging' && 'is-dragging', state.status === 'error' && 'is-error', state.status === 'success' && 'is-success')}
      role="group"
      aria-labelledby={headingId}
      data-state={state.status}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setState((s) => (s.status === 'dragging' ? s : { status: 'dragging' })); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setState((s) => (s.status === 'dragging' ? { status: 'idle' } : s)); }}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        className="sw-sr-only"
        accept={ACCEPTED_VIDEO_EXTENSIONS.map((e) => `.${e}`).join(',') + ',video/*'}
        tabIndex={-1}
        aria-label="Video file"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />

      <Badge tone="neutral">Early preview</Badge>

      {showDropCopy && (
        <>
          <span className="sw-upload__icon"><UploadIcon size={28} /></span>
          <h3 id={headingId} className="sw-h3">{state.status === 'dragging' ? 'Release to select this video' : 'Drop a video to analyze'}</h3>
          <p className="sw-body-sm sw-muted">MP4, MOV, MKV and other supported formats</p>
          {state.status === 'error' && (
            <div className="sw-upload__alert">
              <Alert tone="danger" title={ERROR_COPY[state.reason].title}>{ERROR_COPY[state.reason].body(maxBytes)}</Alert>
            </div>
          )}
          <Button onClick={openPicker}>{state.status === 'error' ? 'Choose another video' : 'Choose video'}</Button>
        </>
      )}

      {state.status === 'processing' && (
        <>
          <h3 id={headingId} className="sw-h3">Reading video</h3>
          <p className="sw-body-sm sw-muted sw-upload__filename">{state.fileName}</p>
          <div className="sw-upload__progress"><Progress label="Reading video details" /></div>
        </>
      )}

      {state.status === 'success' && (
        <>
          <span className="sw-upload__icon sw-upload__icon--success"><CheckIcon size={28} /></span>
          <h3 id={headingId} className="sw-h3">Video selected</h3>
          <p className="sw-body-sm sw-upload__filename">{state.video.name}</p>
          <p className="sw-caption sw-muted">
            {[
              formatBytes(state.video.sizeBytes),
              state.video.metadata.durationSeconds !== null && formatDuration(state.video.metadata.durationSeconds),
              state.video.metadata.width && state.video.metadata.height && `${state.video.metadata.width}×${state.video.metadata.height}`,
            ].filter(Boolean).join(' · ')}
          </p>
          <div className="sw-upload__alert">
            <Alert tone="info" title="Analysis is not available yet">
              This file stays on your device. Safety analysis arrives in a later release.
            </Alert>
          </div>
          <Button variant="secondary" onClick={openPicker}>Choose a different video</Button>
        </>
      )}

      <p className="sw-sr-only" role="status" aria-live="polite">
        {state.status === 'processing' && 'Reading video'}
        {state.status === 'success' && `Video selected: ${state.video.name}`}
        {state.status === 'error' && ERROR_COPY[state.reason].title}
      </p>
    </div>
  );
}
