import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Progress } from '@/components/ui/Progress';
import { formatElapsed, formatTimecode } from '@/domain/media/format';
import { humanizeLabel, type VisualObservation } from '@/domain/vision/observation';
import type { VisualAnalysis, VisualFrame } from '@/domain/vision/visualAnalysis';
import { frameNote, visualFailureCopy, warningText } from './visualCopy';

const PAGE = 12;
const THUMB_LABELS = 3;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const percent = (c: number | null) => (c === null ? null : `${Math.round(c * 100)}%`);

interface VisualPanelProps {
  analysis: VisualAnalysis | null;
  /** Where a sampled frame image can be loaded from. */
  frameUrl: (frameId: string) => string;
}

/**
 * Visual evidence for a prepared video: the sampled frames and what the image
 * model REPORTED for each (labels, located objects, recognised text), with
 * media timestamps. EVIDENCE ONLY: it describes what a model saw, never
 * whether anything is safe, and it changes nothing.
 */
export function VisualPanel({ analysis, frameUrl }: VisualPanelProps) {
  const status = analysis?.status ?? 'queued';

  if (status === 'failed' && analysis) {
    const fatal = analysis.issues.find((i) => i.fatal) ?? analysis.issues[0];
    const copy = visualFailureCopy(fatal?.code ?? 'inference-failed');
    return <section className="sw-visual" aria-label="Visual evidence"><Alert tone={copy.tone} title={copy.title}>{copy.body}</Alert></section>;
  }
  if (status === 'ready' && analysis) return <ReadyPanel analysis={analysis} frameUrl={frameUrl} />;

  const p = analysis?.status === 'processing' ? analysis.progress : null;
  const label = analysis?.status === 'processing' && analysis.phase === 'building-timeline'
    ? 'Building the visual timeline'
    : p ? `Looking at frame ${Math.min(p.framesDone + 1, p.framesTotal)} of ${p.framesTotal}`
    : analysis?.status === 'processing' ? 'Looking at the frames' : 'Waiting to look at the frames';
  return (
    <section className="sw-visual" aria-label="Visual evidence" aria-busy="true">
      <p className="sw-label sw-muted">Looking at the frames</p>
      <p className="sw-caption sw-muted" role="status">{label}…</p>
      {p && p.framesTotal > 0 ? <Progress label="Looking at the frames" value={(p.framesDone / p.framesTotal) * 100} /> : <Progress label="Looking at the frames" />}
    </section>
  );
}

function ReadyPanel({ analysis, frameUrl }: VisualPanelProps & { analysis: VisualAnalysis }) {
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<VisualFrame | null>(null);
  const byFrame = new Map<string, VisualObservation[]>();
  for (const o of analysis.observations) byFrame.set(o.frameId, [...(byFrame.get(o.frameId) ?? []), o]);
  const { counts } = analysis;
  const problems = analysis.frames.filter((f) => f.status !== 'analyzed');

  return (
    <section className="sw-visual" aria-label="Visual evidence">
      <p className="sw-label sw-muted">Visual evidence</p>
      <dl className="sw-upload__facts sw-visual__facts">
        <Fact label="Frames analyzed" value={`${counts.analyzedFrameCount} of ${analysis.frames.length}`} />
        <Fact label="Observations" value={String(counts.observationCount)} />
        {analysis.metrics && <Fact label="Time" value={formatElapsed(analysis.metrics.durationMs)} />}
      </dl>
      {analysis.frames.length === 0 && <p className="sw-body-sm sw-muted">No frames were sampled from this video.</p>}

      {analysis.frames.length > 0 && (
        <ul className="sw-frames" aria-label="Sampled frames">
          {analysis.frames.slice(0, shown).map((f) => (
            <li key={f.frameId}>
              <FrameCard frame={f} observations={byFrame.get(f.frameId) ?? []} src={frameUrl(f.frameId)} onOpen={() => setOpen(f)} />
            </li>
          ))}
        </ul>
      )}
      {analysis.frames.length > shown && (
        <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show more frames ({analysis.frames.length - shown} left)</Button>
      )}

      {(problems.length > 0 || analysis.issues.length > 0) && (
        <details className="sw-details">
          <summary className="sw-body-sm">Notes ({plural(problems.length + analysis.issues.filter((i) => i.code === 'observations-dropped').length, 'note')})</summary>
          <div className="sw-details__body">
            <ul className="sw-details__list">
              {problems.map((f) => <li key={f.frameId} className="sw-body-sm sw-muted">Frame at {formatTimecode(f.timestampSeconds)} {frameNote(f.error, f.status === 'skipped')}.</li>)}
              {analysis.issues.filter((i) => i.code === 'observations-dropped' || i.code === 'no-frames').map((i, k) => <li key={k} className="sw-body-sm sw-muted">{warningText(i.code, i.count)}</li>)}
            </ul>
          </div>
        </details>
      )}

      <p className="sw-caption sw-muted">
        {analysis.provider ? `Frames described on this device by ${analysis.provider.name}. ` : ''}
        Labels are what a model reports, not facts: they can be wrong. Timestamps are media time. This is visual evidence only: SafeWatch has not judged whether anything is safe.
      </p>

      <Modal open={open !== null} title={open ? `Frame at ${formatTimecode(open.timestampSeconds)}` : 'Frame'} onClose={() => setOpen(null)}>
        {open && <FrameDetail frame={open} observations={byFrame.get(open.frameId) ?? []} src={frameUrl(open.frameId)} />}
      </Modal>
    </section>
  );
}

function FrameCard({ frame, observations, src, onOpen }: { frame: VisualFrame; observations: VisualObservation[]; src: string; onOpen: () => void }) {
  const labels = observations.filter((o) => o.type === 'classification').slice(0, THUMB_LABELS);
  const text = observations.find((o) => o.type === 'text')?.attributes?.text;
  const time = formatTimecode(frame.timestampSeconds);
  return (
    <button type="button" className="sw-frame" onClick={onOpen} aria-label={`Open frame at ${time}, ${plural(observations.length, 'observation')}`}>
      {frame.status === 'analyzed' ? (
        <img className="sw-frame__img" src={src} alt="" loading="lazy" width={frame.width} height={frame.height} />
      ) : (
        <span className="sw-frame__img sw-frame__img--none sw-caption">{frame.status === 'skipped' ? 'Not analyzed' : 'Not available'}</span>
      )}
      <span className="sw-frame__time sw-caption">{time}</span>
      {labels.length > 0 && <span className="sw-frame__labels sw-caption">{labels.map((o) => humanizeLabel(o.label)).join(', ')}</span>}
      {text && <span className="sw-frame__text sw-caption">“{text}”</span>}
    </button>
  );
}

function FrameDetail({ frame, observations, src }: { frame: VisualFrame; observations: VisualObservation[]; src: string }) {
  const [boxes, setBoxes] = useState(true);
  const located = observations.filter((o) => o.region !== null);
  return (
    <div className="sw-framedetail">
      <div className="sw-framedetail__stage" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        <img src={src} alt={`Sampled frame at ${formatTimecode(frame.timestampSeconds)}`} width={frame.width} height={frame.height} />
        {boxes && located.map((o) => (
          <span
            key={o.id}
            className={`sw-box sw-box--${o.type}`}
            style={{ left: pct(o.region!.x), top: pct(o.region!.y), width: pct(o.region!.width), height: pct(o.region!.height) }}
            aria-hidden="true"
          />
        ))}
      </div>
      {located.length > 0 && (
        <label className="sw-check sw-body-sm">
          <input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)} /> Show boxes
        </label>
      )}
      {observations.length === 0 ? (
        <p className="sw-body-sm sw-muted">The model reported nothing for this frame.</p>
      ) : (
        <ul className="sw-obs" aria-label="Observations">
          {observations.map((o) => <ObservationRow key={o.id} o={o} />)}
        </ul>
      )}
      <p className="sw-caption sw-muted">
        Time {formatTimecode(frame.timestampSeconds)} · {frame.width}×{frame.height}{frame.processingMs !== null ? ` · ${formatElapsed(frame.processingMs)}` : ''}. Labels can be wrong.
      </p>
    </div>
  );
}

const TYPE_LABEL: Record<VisualObservation['type'], string> = { classification: 'label', object: 'object', text: 'text' };

function ObservationRow({ o }: { o: VisualObservation }) {
  const conf = percent(o.confidence);
  return (
    <li className="sw-obs__row">
      <Badge tone={o.type === 'object' ? 'info' : o.type === 'text' ? 'accent' : 'neutral'}>{TYPE_LABEL[o.type]}</Badge>
      <span className="sw-body-sm sw-obs__text">{o.type === 'text' && o.attributes?.text ? `“${o.attributes.text}”` : humanizeLabel(o.label)}</span>
      {conf && <span className="sw-caption sw-muted">{conf}</span>}
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="sw-caption">{label}</dt><dd className="sw-body-sm">{value}</dd></div>;
}

export function VisualBadge({ analysis }: { analysis: VisualAnalysis | null }) {
  const status = analysis?.status ?? 'queued';
  const off = status === 'failed' && analysis?.issues.some((i) => i.code === 'provider-unavailable');
  const tone = status === 'ready' ? 'success' : status === 'failed' && !off ? 'danger' : 'neutral';
  const text = status === 'ready' ? 'ready' : off ? 'not enabled' : status === 'failed' ? 'failed' : status === 'processing' ? 'in progress' : 'queued';
  return <Badge tone={tone}>Visual: {text}</Badge>;
}
