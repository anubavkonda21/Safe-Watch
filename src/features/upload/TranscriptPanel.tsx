import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import { formatTimecode } from '@/domain/media/format';
import type { TextAnalysis } from '@/domain/text/textAnalysis';
import type { Evidence, TextEvent } from '@/domain/text/textEvent';
import { findTextMatches, type TextMatch } from '@/domain/text/textMatch';
import { useCustomFilters } from '@/features/filters/filtersStore';
import { languageLabel } from './extractionCopy';
import { textFailureCopy, trackNote, warningText } from './textCopy';

const PAGE = 50;
const EVIDENCE_LABEL: Record<Evidence, string> = { both: 'speech + subtitle', 'speech-only': 'speech only', 'subtitle-only': 'subtitle only' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (c: number | null) => (c === null ? null : `${Math.round(c * 100)}%`);

/**
 * Speech transcript and subtitle text for a prepared video, plus where the
 * user's custom filters occur. TEXT EVIDENCE ONLY: it states what was said
 * and when, never whether anything is safe, and it changes nothing.
 */
export function TranscriptPanel({ analysis }: { analysis: TextAnalysis | null }) {
  const status = analysis?.status ?? 'queued';

  if (status === 'failed' && analysis) {
    const fatal = analysis.issues.find((i) => i.fatal) ?? analysis.issues[0];
    const copy = textFailureCopy(fatal?.code ?? 'provider-failed');
    return <section className="sw-text" aria-label="Transcript"><Alert tone="danger" title={copy.title}>{copy.body}</Alert></section>;
  }
  if (status === 'ready' && analysis) return <ReadyPanel analysis={analysis} />;

  const label = analysis?.status === 'processing' && analysis.phase === 'building-timeline' ? 'Building the text timeline' : analysis?.status === 'processing' ? 'Transcribing speech' : 'Waiting to transcribe';
  return (
    <section className="sw-text" aria-label="Transcript" aria-busy="true">
      <p className="sw-label sw-muted">Reading speech and subtitles</p>
      <p className="sw-caption sw-muted" role="status">{label}…</p>
      <Progress label="Reading speech and subtitles" />
    </section>
  );
}

function ReadyPanel({ analysis }: { analysis: TextAnalysis }) {
  const filters = useCustomFilters();
  const [shown, setShown] = useState(PAGE);
  const matches = useMemo(() => findTextMatches(filters, analysis.timeline), [filters, analysis.timeline]);
  const matchedEvents = useMemo(() => new Set(matches.map((m) => m.eventId)), [matches]);

  const transcripts = analysis.speech.flatMap((s) => (s.transcript ? [s.transcript] : []));
  const languages = [...new Set(transcripts.map((t) => languageLabel(t.language)))];
  const cues = analysis.timeline.filter((e) => e.source === 'subtitle').length;
  const segments = transcripts.reduce((n, t) => n + t.segments.length, 0);
  const wordTiming = transcripts.find((t) => t.hasWordTimestamps)?.wordTiming ?? null;
  const notes = analysis.speech.filter((s) => s.status !== 'completed');
  const active = filters.filter((f) => f.enabled);

  return (
    <section className="sw-text" aria-label="Transcript">
      <p className="sw-label sw-muted">Text evidence</p>
      <dl className="sw-upload__facts sw-text__facts">
        <Fact label="Speech" value={transcripts.length === 0 ? 'None' : `${plural(segments, 'segment')}${languages.length ? ` · ${languages.join(', ')}` : ''}`} />
        <Fact label="Subtitles" value={plural(cues, 'cue')} />
        <Fact label="Word timing" value={wordTiming === 'alignment' ? 'Yes' : wordTiming === 'decoder' ? 'Approximate' : 'No'} />
      </dl>
      {analysis.timeline.length === 0 && <p className="sw-body-sm sw-muted">No speech or subtitle text was found in this video.</p>}

      <div className="sw-text__matches">
        <h4 className="sw-label sw-muted">Custom filter matches</h4>
        {active.length === 0 ? (
          <p className="sw-body-sm sw-muted">Add words in <a href="#filters">Custom filters</a> to see where they occur.</p>
        ) : matches.length === 0 ? (
          <p className="sw-body-sm sw-muted">No matches for your {plural(active.length, 'enabled filter')}.</p>
        ) : (
          <ul className="sw-text__matchlist">
            {matches.slice(0, 100).map((m) => <MatchRow key={m.id} match={m} />)}
          </ul>
        )}
        {matches.length > 100 && <p className="sw-caption sw-muted">Showing the first 100 of {matches.length} matches.</p>}
      </div>

      <details className="sw-details">
        <summary className="sw-body-sm">Transcript and timeline ({plural(analysis.timeline.length, 'line')})</summary>
        <div className="sw-details__body">
          {analysis.timeline.length > 0 && (
            <ol className="sw-timeline">
              {analysis.timeline.slice(0, shown).map((e) => <EventRow key={e.id} event={e} matched={matchedEvents.has(e.id)} />)}
            </ol>
          )}
          {analysis.timeline.length > shown && (
            <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show more ({analysis.timeline.length - shown} left)</Button>
          )}
          {notes.length > 0 && (
            <ul className="sw-details__list">
              {notes.map((n) => (
                <li key={n.audioTrackId} className="sw-body-sm sw-muted">Audio track {n.streamIndex}{n.containerLanguage ? ` (${languageLabel(n.containerLanguage)})` : ''}: {trackNote(n.error, n.skipReason)}.</li>
              ))}
            </ul>
          )}
          {analysis.issues.filter((i) => i.stage !== 'speech').map((i, k) => <p key={k} className="sw-body-sm sw-muted">{warningText(i.code)}</p>)}
          <p className="sw-caption sw-muted">
            {analysis.provider ? `Speech transcribed by ${analysis.provider.name} (${analysis.provider.model}). ` : ''}
            Timestamps are media time. Word end times are approximate. This is text only: SafeWatch has not judged whether anything is safe.
          </p>
        </div>
      </details>
    </section>
  );
}

function MatchRow({ match }: { match: TextMatch }) {
  const conf = percent(match.confidence);
  return (
    <li className="sw-match">
      <span className="sw-match__time sw-caption">{formatTimecode(match.startSeconds)}–{formatTimecode(match.endSeconds)}</span>
      <span className="sw-match__body">
        <Badge tone={match.source === 'speech' ? 'info' : 'neutral'}>{match.source}</Badge>
        <span className="sw-body-sm sw-match__text">“{match.matchedText}”</span>
        <span className="sw-caption sw-muted">for “{match.phrase}”{match.granularity !== 'word' ? ` · whole ${match.granularity}` : ''}{conf ? ` · ${conf}` : ''}</span>
      </span>
    </li>
  );
}

function EventRow({ event, matched }: { event: TextEvent; matched: boolean }) {
  const conf = percent(event.confidence);
  return (
    <li className="sw-event">
      <span className="sw-event__time sw-caption" title={`${event.startSeconds} – ${event.endSeconds} s`}>{formatTimecode(event.startSeconds)}</span>
      <span className="sw-event__body">
        <span className="sw-event__tags">
          <Badge tone={event.source === 'speech' ? 'info' : 'neutral'}>{event.source}</Badge>
          {event.evidence === 'both' && <Badge tone="success">{EVIDENCE_LABEL.both}</Badge>}
          {matched && <Badge tone="accent">match</Badge>}
          {conf && <span className="sw-caption sw-muted">{conf}</span>}
        </span>
        <span className="sw-body-sm sw-event__text">{event.text}</span>
      </span>
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="sw-caption">{label}</dt><dd className="sw-body-sm">{value}</dd></div>;
}

export function TextBadge({ analysis }: { analysis: TextAnalysis | null }) {
  const status = analysis?.status ?? 'queued';
  const tone = status === 'ready' ? 'success' : status === 'failed' ? 'danger' : 'neutral';
  const text = status === 'ready' ? 'ready' : status === 'failed' ? 'failed' : status === 'processing' ? 'in progress' : 'queued';
  return <Badge tone={tone}>Text: {text}</Badge>;
}
