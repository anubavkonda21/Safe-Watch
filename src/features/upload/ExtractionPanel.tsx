import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Progress } from '@/components/ui/Progress';
import { CheckIcon } from '@/components/ui/icons';
import type { ExtractionPhase, MediaExtraction } from '@/domain/extraction/extraction';
import { formatBytes, formatDuration, formatElapsed } from '@/domain/media/format';
import { cn } from '@/lib/cn';
import { PHASE_LABEL, extractionFailureCopy, languageLabel, warningCopy } from './extractionCopy';

type StepState = 'pending' | 'active' | 'done';

const STEPS: ReadonlyArray<{ key: 'audio' | 'subtitles' | 'frames'; label: string; phase: ExtractionPhase }> = [
  { key: 'audio', label: 'Audio', phase: 'extracting-audio' },
  { key: 'subtitles', label: 'Subtitles', phase: 'extracting-subtitles' },
  { key: 'frames', label: 'Frames', phase: 'sampling-frames' },
];
const ORDER: ExtractionPhase[] = ['preparing', 'extracting-audio', 'extracting-subtitles', 'sampling-frames', 'finalizing'];

function stepState(extraction: MediaExtraction | null, step: (typeof STEPS)[number]): StepState {
  if (extraction?.status === 'completed') return 'done';
  const phase = extraction?.status === 'processing' ? extraction.phase : null;
  if (!phase) return 'pending';
  const current = ORDER.indexOf(phase);
  const mine = ORDER.indexOf(step.phase);
  return current > mine ? 'done' : current === mine ? 'active' : 'pending';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Extraction status for a ready media item. Phase-based: it never shows a percentage it cannot measure. */
export function ExtractionPanel({ extraction }: { extraction: MediaExtraction | null }) {
  const status = extraction?.status ?? 'queued';

  if (status === 'failed' && extraction) {
    const fatal = extraction.errors.find((e) => e.fatal) ?? extraction.errors[0];
    const copy = extractionFailureCopy(fatal?.code ?? 'extraction-failed');
    return (
      <section className="sw-extraction" aria-label="Analysis assets">
        <Alert tone="danger" title={copy.title}>{copy.body}</Alert>
      </section>
    );
  }

  if (status === 'completed' && extraction) return <CompletedPanel extraction={extraction} />;

  const label = extraction?.status === 'processing' && extraction.phase ? PHASE_LABEL[extraction.phase] : status === 'processing' ? 'Preparing' : 'Queued';
  return (
    <section className="sw-extraction" aria-label="Analysis assets" aria-busy="true">
      <p className="sw-label sw-muted">Preparing analysis assets</p>
      <ol className="sw-xsteps">
        {STEPS.map((step) => {
          const state = stepState(extraction, step);
          return (
            <li key={step.key} className={cn('sw-xstep', `is-${state}`)}>
              <span className="sw-xstep__mark" aria-hidden="true">{state === 'done' ? <CheckIcon size={14} /> : state === 'active' ? <span className="sw-spinner" /> : null}</span>
              <span className="sw-body-sm">{step.label}</span>
              <span className="sw-sr-only">{state === 'done' ? ' ready' : state === 'active' ? ' in progress' : ' waiting'}</span>
            </li>
          );
        })}
      </ol>
      <p className="sw-caption sw-muted" role="status">{label}…</p>
      <Progress label="Preparing analysis assets" />
    </section>
  );
}

function CompletedPanel({ extraction }: { extraction: MediaExtraction }) {
  const unique = extraction.audio.filter((a) => a.duplicateOf === null).length;
  const textTracks = extraction.subtitles.filter((t) => t.kind === 'text').length;
  const imageTracks = extraction.subtitles.filter((t) => t.kind === 'image').length;
  const frames = extraction.frames;
  const warnings = extraction.errors;

  return (
    <section className="sw-extraction" aria-label="Analysis assets">
      <Alert tone="success" title="Media prepared. Ready for SafeWatch analysis.">
        Audio, subtitles and frames have been extracted. SafeWatch has not analyzed this video yet.
      </Alert>

      <dl className="sw-upload__facts sw-extraction__facts">
        <Fact label="Audio" value={plural(extraction.audio.length, 'track')} />
        <Fact label="Subtitles" value={plural(extraction.subtitles.length, 'track')} />
        <Fact label="Frames" value={`${frames?.frames.length ?? 0} sampled`} />
        {extraction.metrics && <Fact label="Prepared in" value={formatElapsed(extraction.metrics.durationMs)} />}
      </dl>
      {warnings.length > 0 && <p className="sw-caption sw-muted">Some items were skipped. See details.</p>}

      <details className="sw-details">
        <summary className="sw-body-sm">Extraction details</summary>
        <div className="sw-details__body">
          <h4 className="sw-label sw-muted">Audio</h4>
          {extraction.audio.length === 0 ? <p className="sw-body-sm sw-muted">No audio track.</p> : (
            <ul className="sw-details__list">
              {extraction.audio.map((a) => (
                <li key={a.id} className="sw-body-sm">
                  <span>{languageLabel(a.language)}{a.title ? ` · ${a.title}` : ''}</span>
                  <span className="sw-muted">{a.duplicateOf ? ` · same audio as ${extraction.audio.find((x) => x.id === a.duplicateOf)?.title ?? a.duplicateOf}` : ` · ${(a.source.codec ?? 'audio').toUpperCase()} → WAV 16 kHz mono · ${formatDuration(a.durationSeconds)} · ${formatBytes(a.sizeBytes)}`}</span>
                </li>
              ))}
            </ul>
          )}
          <h4 className="sw-label sw-muted">Subtitles</h4>
          {extraction.subtitles.length === 0 ? <p className="sw-body-sm sw-muted">No subtitle track.</p> : (
            <ul className="sw-details__list">
              {extraction.subtitles.map((t) => (
                <li key={t.id} className="sw-body-sm">
                  <span>{languageLabel(t.language)}{t.title ? ` · ${t.title}` : ''}</span>
                  <span className="sw-muted">
                    {t.textExtraction === 'extracted' && ` · ${(t.codec ?? 'text').toUpperCase()} · ${plural(t.cueCount, 'cue')}`}
                    {t.kind === 'image' && ` · image subtitles (${(t.codec ?? 'bitmap').toUpperCase()}), not readable as text`}
                    {t.kind === 'unknown' && ' · unsupported subtitle format'}
                    {t.textExtraction === 'failed' && ' · could not be read'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h4 className="sw-label sw-muted">Frames</h4>
          {frames ? (
            <p className="sw-body-sm sw-muted">
              {plural(frames.frames.length, 'frame')} · about every {Number(frames.effectiveIntervalSeconds.toFixed(1))} s · up to {frames.config.maxWidth}×{frames.config.maxHeight} · JPEG · {formatBytes(frames.totalSizeBytes)}
            </p>
          ) : <p className="sw-body-sm sw-muted">No frames.</p>}
          {warnings.length > 0 && (
            <>
              <h4 className="sw-label sw-muted">Skipped</h4>
              <ul className="sw-details__list">
                {warnings.map((w, i) => <li key={i} className="sw-body-sm sw-muted">{w.stage}{w.streamIndex !== null ? ` stream ${w.streamIndex}` : ''}: {warningCopy(w.code)}</li>)}
              </ul>
            </>
          )}
          <p className="sw-caption sw-muted">{plural(unique, 'unique audio file', 'unique audio files')} · {textTracks} text and {imageTracks} image subtitle {imageTracks === 1 ? 'track' : 'tracks'}</p>
        </div>
      </details>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="sw-caption">{label}</dt><dd className="sw-body-sm">{value}</dd></div>;
}

/** Badge for the status row beside "Media" and "Analysis". */
export function ExtractionBadge({ extraction }: { extraction: MediaExtraction | null }) {
  const status = extraction?.status ?? 'queued';
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'danger' : 'neutral';
  const text = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'processing' ? 'in progress' : 'queued';
  return <Badge tone={tone}>Extraction: {text}</Badge>;
}
