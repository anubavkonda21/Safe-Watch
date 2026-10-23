import { useEffect, useState } from 'react';
import type { MediaIngestion } from '@/application/mediaIngestion';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Progress } from '@/components/ui/Progress';
import type { MediaAsset } from '@/domain/media/asset';
import { formatTimecode } from '@/domain/media/format';
import { categoryById } from '@/domain/safety/taxonomy';
import type { SafetyAnalysis, SafetyFinding } from '@/domain/safety/finding';
import { useCustomFilters } from '@/features/filters/filtersStore';
import { cn } from '@/lib/cn';
import { abstainText, analysisWarningText, categoryStatusText, warningText } from './safetyCopy';

type Load = { state: 'loading' } | { state: 'unavailable' } | { state: 'ready'; analysis: SafetyAnalysis };

const tc = (ms: number) => formatTimecode(ms / 1000);
const range = (f: { startMs: number; endMs: number }) => `${tc(f.startMs)} to ${tc(f.endMs)}`;
const percent = (c: number | null) => (c === null ? null : `${Math.round(c * 100)}%`);
const SOURCE: Record<string, string> = { speech: 'Speech', subtitle: 'Subtitles', visual: 'Visual' };

interface SafetyPanelProps {
  ingestion: MediaIngestion;
  asset: MediaAsset;
  /** True once the evidence steps (text, visual, context) have finished, so the server has something to classify. */
  evidenceReady: boolean;
}

/**
 * Safety classification foundation. Shows which categories are really supported, what was checked, and the findings with their
 * evidence. Today ONLY flagged terms in speech and subtitles are classified; every other category is shown as not supported.
 * There is no overall score and no verdict, and nothing is changed or hidden.
 */
export function SafetyPanel({ ingestion, asset, evidenceReady }: SafetyPanelProps) {
  const filters = useCustomFilters();
  const terms = filters.filter((f) => f.enabled).map((f) => ({ phrase: f.phrase, matchMode: f.matchMode }));
  const key = JSON.stringify(terms);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    if (!evidenceReady) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      ingestion.loadSafetyFindings(asset, JSON.parse(key) as typeof terms, { signal: controller.signal })
        .then((analysis) => { if (!controller.signal.aborted) setLoad(analysis ? { state: 'ready', analysis } : { state: 'unavailable' }); })
        .catch(() => { if (!controller.signal.aborted) setLoad({ state: 'unavailable' }); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ingestion, asset, evidenceReady, key]);

  if (!evidenceReady || load.state === 'loading') {
    return (
      <section className="sw-safety" aria-label="Safety classification" aria-busy="true">
        <p className="sw-label sw-muted">Safety classification</p>
        <p className="sw-caption sw-muted" role="status">Waiting for the evidence steps to finish…</p>
        <Progress label="Safety classification" />
      </section>
    );
  }
  if (load.state === 'unavailable') {
    return (
      <section className="sw-safety" aria-label="Safety classification">
        <Alert tone="info" title="Safety classification is not available">The server could not provide it. Your media is still stored and ready.</Alert>
      </section>
    );
  }
  return <Ready analysis={load.analysis} />;
}

function Ready({ analysis }: { analysis: SafetyAnalysis }) {
  const [selected, setSelected] = useState<string | null>(null);
  const pick = analysis.findings.find((f) => f.id === selected) ?? null;
  const total = Math.max(1, analysis.durationMs ?? 0, ...analysis.findings.map((f) => f.endMs));

  return (
    <section className="sw-safety" aria-label="Safety classification">
      <p className="sw-label sw-muted">Safety classification (foundation)</p>
      <p className="sw-body-sm sw-muted sw-safety__lead">
        Only flagged words in speech and subtitles are checked today. Other categories are not supported yet. SafeWatch gives no overall score and no verdict.
      </p>

      <ul className="sw-cats" aria-label="Categories">
        {analysis.categories.map((c) => (
          <li key={c.category} className={cn('sw-cat', `is-${c.evaluation}`)}>
            <div className="sw-cat__head">
              <span className="sw-body-sm sw-cat__name">{c.label}</span>
              <Badge tone={c.support === 'implemented' ? 'success' : 'neutral'}>{c.support === 'implemented' ? 'Implemented' : c.support === 'experimental' ? 'Experimental' : 'Not supported'}</Badge>
            </div>
            <p className="sw-caption sw-muted">{categoryStatusText(c)}</p>
            <details className="sw-details">
              <summary className="sw-caption">What this category means</summary>
              <div className="sw-details__body">
                <Def label="Counts as" text={categoryById(c.category).positive} />
                <Def label="Does not count" text={categoryById(c.category).notPositive} />
                <Def label="Limits" text={categoryById(c.category).limitations} />
                {categoryById(c.category).blocker && <Def label="Why not supported" text={categoryById(c.category).blocker!} />}
              </div>
            </details>
          </li>
        ))}
      </ul>

      {analysis.warnings.map((w) => <p key={w.code} className="sw-caption sw-muted">{analysisWarningText(w.code, w.count)}</p>)}

      {analysis.findings.length > 0 && (
        <>
          <p className="sw-label sw-muted">Findings on the media timeline</p>
          <div className="sw-ftimeline" role="group" aria-label="Findings timeline">
            {analysis.findings.map((f) => (
              <button
                key={f.id} type="button" aria-pressed={f.id === selected} aria-label={`Finding ${range(f)}, ${f.status}`}
                className={cn('sw-fmark', `sw-fmark--${f.status}`, f.id === selected && 'is-selected')}
                style={{ left: `${Math.min(98.5, (f.startMs / total) * 100)}%`, width: `${Math.max(1.5, ((f.endMs - f.startMs) / total) * 100)}%` }}
                onClick={() => setSelected((cur) => (cur === f.id ? null : f.id))}
              />
            ))}
          </div>
          <p className="sw-caption sw-muted sw-ctimeline__axis"><span>0:00</span><span>{tc(total)}</span></p>
          <ol className="sw-findings" aria-label="Findings">
            {analysis.findings.map((f) => <FindingCard key={f.id} f={f} open={f.id === selected} onToggle={() => setSelected((cur) => (cur === f.id ? null : f.id))} />)}
          </ol>
          {pick === null && <p className="sw-caption sw-muted">Select a finding to see its evidence.</p>}
        </>
      )}

      {analysis.findings.length === 0 && analysis.status !== 'not-evaluated' && (
        <p className="sw-body-sm sw-muted">No findings. This only means none of the listed words occur in the checked text, not that the video has been judged.</p>
      )}
      {analysis.status === 'not-evaluated' && analysis.categories.find((c) => c.category === 'flagged-terms')?.reason && (
        <p className="sw-body-sm sw-muted">{abstainText(analysis.categories.find((c) => c.category === 'flagged-terms')!.reason)}</p>
      )}
      <p className="sw-caption sw-muted">
        A finding means a word you listed occurs in the transcript or subtitles. It does not say what the sentence means or whether anything is acceptable. Speech recognition can mishear or miss words. Timestamps are media time. Taxonomy {analysis.taxonomyVersion}.
      </p>
    </section>
  );
}

function Def({ label, text }: { label: string; text: string }) {
  return <p className="sw-caption"><strong>{label}:</strong> <span className="sw-muted">{text}</span></p>;
}

function FindingCard({ f, open, onToggle }: { f: SafetyFinding; open: boolean; onToggle: () => void }) {
  return (
    <li className={cn('sw-finding', open && 'is-open')}>
      <button type="button" className="sw-finding__head" aria-expanded={open} onClick={onToggle}>
        <span className="sw-caption sw-finding__time">{range(f)}</span>
        <span className="sw-finding__tags">
          <Badge tone="neutral">{categoryById(f.category).label}</Badge>
          <Badge tone={f.status === 'detected' ? 'accent' : 'warning'}>{f.status === 'detected' ? 'Detected' : 'Uncertain'}</Badge>
          {[...new Set(f.evidence.map((e) => e.modality))].map((m) => <Badge key={m} tone={m === 'speech' ? 'info' : 'neutral'}>{SOURCE[m]}</Badge>)}
        </span>
        {f.attributes && <span className="sw-body-sm sw-finding__term">“{f.attributes.term}”</span>}
      </button>
      {open && (
        <div className="sw-finding__body">
          <p className="sw-body-sm">{f.explanation}</p>
          {f.warnings.length > 0 && <ul className="sw-details__list">{f.warnings.map((w) => <li key={w} className="sw-caption sw-muted">{warningText(w)}</li>)}</ul>}
          <ul className="sw-finding__evidence" aria-label="Evidence">
            {f.evidence.map((e) => (
              <li key={e.evidenceId} className="sw-caption">
                <strong>{SOURCE[e.modality]}</strong> {range(e)}
                {e.sourceConfidence !== null && <span className="sw-muted"> · recognizer confidence {percent(e.sourceConfidence)}</span>}
                {e.contextEventId && <span className="sw-muted"> · context {e.contextEventId}</span>}
              </li>
            ))}
          </ul>
          <p className="sw-caption sw-muted">Found by {f.classifier.id} (rule based). No probability is given: none was measured.</p>
        </div>
      )}
    </li>
  );
}
