import { useId, useRef, useState, type DragEvent } from 'react';
import type { MediaIngestion } from '@/application/mediaIngestion';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import { CheckIcon, UploadIcon } from '@/components/ui/icons';
import type { MediaAsset } from '@/domain/media/asset';
import { formatBytes, formatDuration } from '@/domain/media/format';
import { isBusy, type ProcessingPhase } from '@/domain/media/ingestion';
import type { AnalysisStatus } from '@/domain/analysis/job';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import { ACCEPTED_VIDEO_EXTENSIONS } from '@/domain/media/validation';
import { config } from '@/infrastructure/config/env';
import { defaultMediaIngestion } from '@/infrastructure/mediaIngestionFactory';
import { cn } from '@/lib/cn';
import { errorCopy } from './errorCopy';
import { ExtractionBadge, ExtractionPanel } from './ExtractionPanel';
import { TextBadge, TranscriptPanel } from './TranscriptPanel';
import { useMediaIngestion } from './useMediaIngestion';
import './upload.css';

interface UploadDropzoneProps {
  /** Injectable for tests and for the future server-side pipeline. */
  ingestion?: MediaIngestion;
  maxBytes?: number;
  disabled?: boolean;
}

/**
 * Entry point of the analysis workflow. Selects a video, validates it, and
 * prepares a MediaAsset locally. Nothing is uploaded and no analysis runs.
 */
export function UploadDropzone({ ingestion = defaultMediaIngestion, maxBytes = config.maxUploadBytes, disabled = false }: UploadDropzoneProps) {
  const { state, select } = useMediaIngestion(ingestion);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const hintId = useId();
  const busy = isBusy(state);
  const interactive = !disabled && !busy;
  const showDragState = dragging && interactive;

  function openPicker() {
    if (inputRef.current) inputRef.current.value = '';
    inputRef.current?.click();
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (interactive && file) void select(file);
  }

  const asset = state.status === 'accepted' || state.status === 'processing' || state.status === 'ready' ? state.asset : null;
  const dataState = showDragState ? 'dragging' : state.status;

  return (
    <div
      className={cn(
        'sw-upload',
        showDragState && 'is-dragging',
        state.status === 'failed' && 'is-error',
        state.status === 'ready' && 'is-success',
        disabled && 'is-disabled',
      )}
      role="group"
      aria-labelledby={headingId}
      aria-describedby={hintId}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      data-state={dataState}
      onDragOver={(e) => { e.preventDefault(); if (interactive) setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        className="sw-sr-only"
        accept={ACCEPTED_VIDEO_EXTENSIONS.map((e) => `.${e}`).join(',')}
        tabIndex={-1}
        aria-label="Video file"
        disabled={disabled}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void select(f); }}
      />

      <Badge tone="neutral">Early preview</Badge>

      {(state.status === 'idle' || state.status === 'failed') && (
        <>
          <span className="sw-upload__icon"><UploadIcon size={28} /></span>
          <h3 id={headingId} className="sw-h3">{showDragState ? 'Release to select this video' : 'Drop a video to analyze'}</h3>
          <p id={hintId} className="sw-body-sm sw-muted">
            {state.status === 'idle' && <>or choose one from your device. </>}
            MP4, MOV, MKV and other supported formats, up to {formatBytes(maxBytes)}.
          </p>
          {state.status === 'failed' && (
            <div className="sw-upload__alert">
              <Alert tone="danger" title={errorCopy(state.failure.code, maxBytes).title}>{errorCopy(state.failure.code, maxBytes).body}</Alert>
            </div>
          )}
          <Button onClick={openPicker} disabled={disabled}>{state.status === 'failed' ? 'Choose another video' : 'Choose video'}</Button>
        </>
      )}

      {state.status === 'validating' && (
        <>
          <h3 id={headingId} className="sw-h3">Checking your file</h3>
          <p id={hintId} className="sw-body-sm sw-muted sw-upload__filename">{state.fileName}</p>
          <div className="sw-upload__progress"><Progress label="Checking your file" /></div>
        </>
      )}

      {asset && (
        <AssetSummary
          asset={asset}
          headingId={headingId}
          hintId={hintId}
          status={state.status as 'accepted' | 'processing' | 'ready'}
          phase={state.status === 'processing' ? state.phase : null}
          uploadFraction={state.status === 'processing' ? state.uploadFraction : null}
          analysis={state.status === 'ready' ? state.analysis : null}
          extraction={state.status === 'ready' ? state.extraction : null}
          textAnalysis={state.status === 'ready' ? state.textAnalysis : null}
          mode={ingestion.mode}
          onReplace={openPicker}
        />
      )}

      <p className="sw-sr-only" role="status" aria-live="polite">
        {state.status === 'validating' && 'Checking your file'}
        {state.status === 'processing' && (state.phase === 'uploading' ? 'Uploading your video' : 'Preparing your media')}
        {state.status === 'ready' && `Media ready: ${state.asset.filename}. Analysis has not started.`}
        {state.status === 'failed' && errorCopy(state.failure.code, maxBytes).title}
      </p>
    </div>
  );
}

const ANALYSIS_LABEL: Record<AnalysisStatus, string> = {
  not_started: 'Not started',
  queued: 'Queued',
  processing: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};

interface AssetSummaryProps {
  asset: MediaAsset;
  headingId: string;
  hintId: string;
  status: 'accepted' | 'processing' | 'ready';
  phase: ProcessingPhase | null;
  uploadFraction: number | null;
  analysis: AnalysisStatus | null;
  extraction: MediaExtraction | null;
  textAnalysis: TextAnalysis | null;
  mode: 'local' | 'server';
  onReplace: () => void;
}

function AssetSummary({ asset, headingId, hintId, status, phase, uploadFraction, analysis, extraction, textAnalysis, mode, onReplace }: AssetSummaryProps) {
  const m = asset.metadata;
  const ready = status === 'ready';
  const uploading = status === 'processing' && phase === 'uploading';
  const percent = Math.round((uploadFraction ?? 0) * 100);
  return (
    <>
      {ready && <span className="sw-upload__icon sw-upload__icon--success"><CheckIcon size={28} /></span>}
      <h3 id={headingId} className="sw-h3">
        {status === 'accepted' && 'Video accepted'}
        {uploading && 'Uploading your video'}
        {status === 'processing' && !uploading && 'Preparing your media...'}
        {ready && 'Media ready'}
      </h3>
      <p id={hintId} className="sw-body-sm sw-upload__filename">{asset.filename}</p>

      {status === 'processing' && (
        <div className="sw-upload__progress">
          {uploading ? <Progress label="Uploading video" value={percent} /> : <Progress label="Preparing your media" />}
          {uploading && <p className="sw-caption sw-muted sw-upload__percent">{percent}%</p>}
        </div>
      )}

      <dl className="sw-upload__facts">
        <Fact label="Type" value={asset.typeLabel} />
        <Fact label="Size" value={formatBytes(asset.sizeBytes)} />
        {m.durationSeconds !== null && <Fact label="Duration" value={formatDuration(m.durationSeconds)} />}
        {m.width !== null && m.height !== null && <Fact label="Resolution" value={`${m.width}×${m.height}`} />}
        {m.frameRate !== null && <Fact label="Frame rate" value={`${Number(m.frameRate.toFixed(2))} fps`} />}
        {m.videoCodec !== null && <Fact label="Video" value={m.videoCodec.toUpperCase()} />}
        {m.hasAudio !== null && <Fact label="Audio" value={m.hasAudio ? (m.audioCodec ?? 'Yes').toUpperCase() : 'None'} />}
        {m.hasSubtitles !== null && <Fact label="Subtitles" value={m.hasSubtitles ? 'Embedded' : 'None'} />}
      </dl>

      {ready && (
        <div className="sw-upload__status" aria-label="Status">
          <Badge tone="success">Media: ready</Badge>
          {mode === 'server' && <ExtractionBadge extraction={extraction} />}
          {mode === 'server' && extraction?.status === 'completed' && <TextBadge analysis={textAnalysis} />}
          <Badge tone="neutral">Analysis: {ANALYSIS_LABEL[analysis ?? 'not_started'].toLowerCase()}</Badge>
        </div>
      )}
      {ready && m.availability === 'unavailable' && (
        <div className="sw-upload__alert">
          <Alert tone="info" title="Video details are not available in this browser">
            The file is valid. Duration and resolution could not be read locally and will be read during analysis.
          </Alert>
        </div>
      )}
      {ready && mode === 'server' && <ExtractionPanel extraction={extraction} />}
      {ready && mode === 'server' && extraction?.status === 'completed' && <TranscriptPanel analysis={textAnalysis} />}
      {ready && (
        <div className="sw-upload__alert">
          <Alert tone="info" title={mode === 'server' ? 'Stored temporarily' : 'Analysis has not started'}>
            {mode === 'server'
              ? 'Your video was uploaded to the SafeWatch server and is deleted automatically. Safety analysis arrives in a later release.'
              : 'This file stays on your device. Safety analysis arrives in a later release.'}
          </Alert>
        </div>
      )}
      {ready && <Button variant="secondary" onClick={onReplace}>Choose a different video</Button>}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="sw-caption">{label}</dt><dd className="sw-body-sm">{value}</dd></div>;
}
