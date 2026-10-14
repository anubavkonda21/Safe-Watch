import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Progress } from '@/components/ui/Progress';
import type { ContextAnalysis } from '@/domain/context/contextAnalysis';
import type { ContextEvent, ContextMember } from '@/domain/context/contextEvent';
import { MODALITY_ORDER } from '@/domain/context/contextEvent';
import type { Modality } from '@/domain/evidence/evidence';
import { formatTimecode } from '@/domain/media/format';
import { humanizeLabel } from '@/domain/vision/observation';
import { cn } from '@/lib/cn';
import { closedByText, inputNote, joinText, MODALITY_LABEL, warningText } from './contextCopy';
import { layoutTimeline } from './contextLayout';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tc = (ms: number) => formatTimecode(ms / 1000);
const range = (e: { startMs: number; endMs: number }) => (e.endMs === e.startMs ? tc(e.startMs) : `${tc(e.startMs)} to ${tc(e.endMs)}`);
const percent = (c: number | null) => (c === null ? null : `${Math.round(c * 100)}%`);

/**
 * Contextual evidence: which speech, subtitle and visual evidence belongs
 * together on the media timeline, and WHY it was grouped. This groups by time
 * only. It does not assess the content and changes nothing.
 */
export function ContextPanel({ context }: { context: ContextAnalysis | null }) {
  if (!context || context.status === 'pending') {
    return (
      <section className="sw-context" aria-label="Contextual evidence" aria-busy="true">
        <p className="sw-label sw-muted">Correlating evidence</p>
        <p className="sw-caption sw-muted" role="status">Grouping speech, subtitles and visual evidence by time…</p>
        <Progress label="Correlating evidence" />
      </section>
    );
  }
  if (context.status === 'unavailable') {
    return (
      <section className="sw-context" aria-label="Contextual evidence">
        <Alert tone="info" title="Evidence could not be grouped by time">
          None of the evidence steps produced a result, so there is nothing to correlate. Your media is still stored and ready.
        </Alert>
      </section>
    );
  }
  return <ReadyPanel context={context} />;
}

function ReadyPanel({ context }: { context: ContextAnalysis }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { placed, lanes } = layoutTimeline(context.events, context.durationMs);
  const selected = context.events.find((e) => e.id === selectedId) ?? null;
  const notes = [inputNote('speech', context.inputs.speech), inputNote('subtitles', context.inputs.subtitles), inputNote('visual', context.inputs.visual), ...context.warnings.map((w) => warningText(w.code, w.count))].filter((n): n is string => n !== null);
  const multi = context.events.filter((e) => e.corroboration === 'multi-source').length;
  const toggle = (id: string) => setSelectedId((cur) => (cur === id ? null : id));

  return (
    <section className="sw-context" aria-label="Contextual evidence">
      <p className="sw-label sw-muted">Contextual evidence</p>
      <dl className="sw-upload__facts sw-context__facts">
        <Fact label="Contexts" value={String(context.events.length)} />
        <Fact label="Evidence items" value={String(context.counts.evidenceCount)} />
        <Fact label="With 2+ sources" value={String(multi)} />
      </dl>
      {notes.length > 0 && <div className="sw-context__notes">{notes.map((n) => <p key={n} className="sw-body-sm sw-muted">{n}</p>)}</div>}

      {context.events.length > 0 && (
        <>
          <div className="sw-ctimeline" role="group" aria-label="Context timeline" style={{ height: `${lanes * 26 + 8}px` }}>
            {placed.map(({ event, lane, left, width }) => (
              <button
                key={event.id} type="button" aria-pressed={event.id === selectedId} aria-label={`Context ${range(event)}, ${event.sources.map((s) => MODALITY_LABEL[s]).join(', ')}`}
                className={cn('sw-cseg', `sw-cseg--${event.corroboration}`, event.extended && 'is-extended', event.id === selectedId && 'is-selected')}
                style={{ left: `${left}%`, width: `${width}%`, top: `${lane * 26 + 4}px` }} onClick={() => toggle(event.id)}
              />
            ))}
          </div>
          <p className="sw-caption sw-muted sw-ctimeline__axis"><span>0:00</span><span>{tc(context.durationMs ?? context.events.at(-1)!.endMs)}</span></p>

          <ol className="sw-ccards" aria-label="Contexts">
            {context.events.map((e) => (
              <li key={e.id}>
                <button type="button" className={cn('sw-ccard', e.id === selectedId && 'is-selected')} aria-pressed={e.id === selectedId} onClick={() => toggle(e.id)}>
                  <span className="sw-ccard__time sw-caption">{range(e)}</span>
                  <span className="sw-ccard__sources">{e.sources.map((s) => <Badge key={s} tone={s === 'speech' ? 'info' : s === 'visual' ? 'success' : 'neutral'}>{MODALITY_LABEL[s]}</Badge>)}</span>
                  <span className="sw-ccard__facts sw-body-sm">{summary(e)}</span>
                </button>
              </li>
            ))}
          </ol>
          {selected ? <Drilldown event={selected} context={context} /> : <p className="sw-caption sw-muted">Select a context to see the evidence behind it.</p>}
        </>
      )}

      <p className="sw-caption sw-muted">
        SafeWatch has grouped the evidence above by time. It has not assessed the content, and a group is not a finding. Each source keeps its own confidence; they are never combined. Timestamps are media time.
      </p>
    </section>
  );
}

function summary(e: ContextEvent): string {
  const f = e.facts;
  const parts: string[] = [];
  if (f.speechPresent) parts.push('Speech available');
  if (f.subtitlePresent) parts.push('Subtitles available');
  const text = e.members.filter((m) => m.kind === 'text').length;
  if (text > 0) parts.push('Text on screen');
  const objects = f.highlights.filter((h) => h.kind === 'object').map((h) => `${humanizeLabel(h.label)} detected`);
  parts.push(...objects.slice(0, 2));
  const labels = f.highlights.filter((h) => h.kind === 'classification').slice(0, 2).map((h) => humanizeLabel(h.label));
  if (labels.length) parts.push(labels.join(', '));
  if (e.extended) parts.push('Long-lasting evidence');
  return parts.join(' · ');
}

function Drilldown({ event, context }: { event: ContextEvent; context: ContextAnalysis }) {
  return (
    <div className="sw-cdrill" role="region" aria-label={`Evidence for context ${range(event)}`}>
      <h4 className="sw-label">{range(event)}</h4>
      <p className="sw-caption sw-muted">{plural(event.members.length, 'evidence item')} from {event.sources.map((s) => MODALITY_LABEL[s].toLowerCase()).join(', ')}. {closedByText(event.closedBy, context.config)}</p>
      {MODALITY_ORDER.map((m) => <Group key={m} modality={m} members={event.members.filter((x) => x.modality === m)} config={context.config} />)}
      {event.ambient.length > 0 && (
        <div className="sw-cgroup">
          <h5 className="sw-body-sm sw-cgroup__title">Also during this time</h5>
          <ul>{event.ambient.map((m) => <MemberRow key={m.evidenceId} m={m} config={context.config} />)}</ul>
        </div>
      )}
      {event.confidence.length > 0 && (
        <p className="sw-caption sw-muted">
          Confidence by source: {event.confidence.map((c) => `${MODALITY_LABEL[c.modality].toLowerCase()} ${c.withConfidence === 0 ? 'not reported' : c.min === c.max ? percent(c.max) : `${percent(c.min)} to ${percent(c.max)}`}`).join(' · ')}.
        </p>
      )}
    </div>
  );
}

function Group({ modality, members, config }: { modality: Modality; members: ContextMember[]; config: ContextAnalysis['config'] }) {
  if (members.length === 0) return null;
  return (
    <div className="sw-cgroup">
      <h5 className="sw-body-sm sw-cgroup__title">{MODALITY_LABEL[modality]} ({members.length})</h5>
      <ul>{members.map((m) => <MemberRow key={m.evidenceId} m={m} config={config} />)}</ul>
    </div>
  );
}

function MemberRow({ m, config }: { m: ContextMember; config: ContextAnalysis['config'] }) {
  const conf = percent(m.confidence);
  const label = m.modality === 'visual' && m.kind !== 'text' ? humanizeLabel(m.label) : m.modality === 'visual' ? `“${m.label}”` : m.label;
  return (
    <li className="sw-cmember">
      <span className="sw-cmember__time sw-caption">{range(m)}</span>
      <span className="sw-cmember__body">
        <span className="sw-cmember__line">
          {m.modality === 'visual' && <Badge tone={m.kind === 'object' ? 'info' : m.kind === 'text' ? 'accent' : 'neutral'}>{m.kind === 'classification' ? 'label' : m.kind}</Badge>}
          <span className="sw-body-sm sw-cmember__text">{label}</span>
          {conf && <span className="sw-caption sw-muted">{conf}</span>}
        </span>
        <span className="sw-caption sw-muted">{joinText(m.joinedBy, config)}</span>
      </span>
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt className="sw-caption">{label}</dt><dd className="sw-body-sm">{value}</dd></div>;
}

export function ContextBadge({ context }: { context: ContextAnalysis | null }) {
  const status = context?.status ?? 'pending';
  const tone = status === 'ready' ? 'success' : 'neutral';
  const text = status === 'ready' ? 'ready' : status === 'partial' ? 'partial' : status === 'unavailable' ? 'unavailable' : 'in progress';
  return <Badge tone={tone}>Context: {text}</Badge>;
}
