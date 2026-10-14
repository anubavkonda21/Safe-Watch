import { buildEvidenceTimeline } from '../evidence/evidence';
import type { ExtractionStatus } from '../extraction/extraction';
import type { TextAnalysis } from '../text/textAnalysis';
import type { VisualAnalysis } from '../vision/visualAnalysis';
import { correlateEvidence } from './correlate';
import { DEFAULT_CONTEXT_CONFIG, type ContextConfig, type ContextEvent } from './contextEvent';
import { intervalsOverlap, toMs, type Ms } from './time';

/**
 * Contextual analysis of one media item: the result of correlating the
 * evidence the earlier stages already produced. It is a pure function of that
 * evidence (no model, no I/O, no clock), so it is computed on request and
 * never stored. It does NOT classify, score or judge anything.
 */
export type ContextStatus = 'pending' | 'ready' | 'partial' | 'unavailable';

/** How each kind of evidence took part. `empty` = the stage worked and found nothing (not a problem); `failed`/`not-enabled` = evidence is MISSING. */
export type InputStatus = 'used' | 'empty' | 'failed' | 'not-enabled' | 'pending';

export interface ContextInputs {
  speech: InputStatus;
  subtitles: InputStatus;
  visual: InputStatus;
}

export type ContextWarningCode = 'speech-failed' | 'speech-not-enabled' | 'subtitles-failed' | 'visual-failed' | 'visual-not-enabled' | 'invalid-evidence' | 'duplicate-evidence' | 'no-evidence';

export interface ContextWarning {
  code: ContextWarningCode;
  count: number;
}

export interface ContextAnalysis {
  mediaId: string;
  status: ContextStatus;
  inputs: ContextInputs;
  events: ContextEvent[];
  counts: { eventCount: number; evidenceCount: number; invalidEvidence: number; duplicateEvidence: number };
  config: ContextConfig;
  warnings: ContextWarning[];
  /** Media duration for drawing a timeline; null when unknown. */
  durationMs: Ms | null;
}

export interface ContextSource {
  mediaId: string;
  extractionStatus: ExtractionStatus | null;
  mediaDurationSeconds: number | null;
  text: TextAnalysis | null;
  visual: VisualAnalysis | null;
  /** Effective distance between sampled frames, in seconds. */
  frameStepSeconds: number | null;
  config?: Partial<ContextConfig>;
}

const isFinal = (s: string | undefined) => s === 'ready' || s === 'failed';

function speechInput(text: TextAnalysis): InputStatus {
  if (text.status === 'failed') return 'failed';
  const tracks = text.speech;
  if (tracks.some((t) => t.status === 'completed')) return text.timeline.some((e) => e.source === 'speech') ? 'used' : 'empty';
  if (tracks.some((t) => t.status === 'failed')) return 'failed';
  if (tracks.length > 0 && tracks.every((t) => t.status === 'skipped' && t.skipReason === 'speech-disabled')) return 'not-enabled';
  return 'empty';
}

function subtitleInput(text: TextAnalysis): InputStatus {
  if (text.status === 'failed') return 'failed';
  if (text.timeline.some((e) => e.source === 'subtitle')) return 'used';
  return text.issues.some((i) => i.code === 'subtitle-unavailable') ? 'failed' : 'empty';
}

function visualInput(visual: VisualAnalysis | null): InputStatus {
  if (!visual) return 'not-enabled';
  if (visual.status === 'failed') return visual.issues.some((i) => i.code === 'provider-unavailable') ? 'not-enabled' : 'failed';
  return visual.observations.length > 0 ? 'used' : 'empty';
}

export function buildContextAnalysis(src: ContextSource): ContextAnalysis {
  const config: ContextConfig = { ...DEFAULT_CONTEXT_CONFIG, ...src.config };
  const durationMs = src.mediaDurationSeconds !== null && Number.isFinite(src.mediaDurationSeconds) ? toMs(src.mediaDurationSeconds) : null;
  const base = { mediaId: src.mediaId, config, durationMs, counts: { eventCount: 0, evidenceCount: 0, invalidEvidence: 0, duplicateEvidence: 0 } };

  if (src.extractionStatus === 'failed') {
    return { ...base, status: 'unavailable', inputs: { speech: 'failed', subtitles: 'failed', visual: 'failed' }, events: [], warnings: [] };
  }
  const textFinal = isFinal(src.text?.status);
  const visualFinal = src.visual === null || isFinal(src.visual.status);
  if (src.extractionStatus !== 'completed' || !src.text || !textFinal || !visualFinal) {
    return {
      ...base, status: 'pending', events: [], warnings: [],
      inputs: { speech: textFinal ? speechInput(src.text!) : 'pending', subtitles: textFinal ? subtitleInput(src.text!) : 'pending', visual: visualFinal ? visualInput(src.visual) : 'pending' },
    };
  }

  const inputs: ContextInputs = { speech: speechInput(src.text), subtitles: subtitleInput(src.text), visual: visualInput(src.visual) };
  const evidence = buildEvidenceTimeline(src.text.status === 'ready' ? src.text.timeline : [], src.visual?.status === 'ready' ? src.visual.observations : []);
  const result = correlateEvidence({ evidence, visualStepMs: src.frameStepSeconds === null ? null : toMs(src.frameStepSeconds), config });

  const warnings: ContextWarning[] = [];
  const warn = (code: ContextWarningCode, count = 1) => warnings.push({ code, count });
  if (inputs.speech === 'failed') warn('speech-failed');
  if (inputs.speech === 'not-enabled') warn('speech-not-enabled');
  if (inputs.subtitles === 'failed') warn('subtitles-failed');
  if (inputs.visual === 'failed') warn('visual-failed');
  if (inputs.visual === 'not-enabled') warn('visual-not-enabled');
  if (result.invalid > 0) warn('invalid-evidence', result.invalid);
  if (result.duplicates > 0) warn('duplicate-evidence', result.duplicates);
  if (result.events.length === 0 && Object.values(inputs).every((s) => s === 'used' || s === 'empty')) warn('no-evidence');

  const missing = Object.values(inputs).filter((s) => s === 'failed' || s === 'not-enabled').length;
  const status: ContextStatus = missing === 0 ? 'ready' : missing === 3 ? 'unavailable' : 'partial';
  return {
    ...base, status, inputs, events: result.events, warnings,
    counts: { eventCount: result.events.length, evidenceCount: result.accepted, invalidEvidence: result.invalid, duplicateEvidence: result.duplicates },
  };
}

/** Client stand-in when the context could not be loaded (for example the server became unreachable). */
export const unavailableContext = (mediaId: string): ContextAnalysis => ({
  mediaId, status: 'unavailable', inputs: { speech: 'failed', subtitles: 'failed', visual: 'failed' }, events: [], warnings: [],
  counts: { eventCount: 0, evidenceCount: 0, invalidEvidence: 0, duplicateEvidence: 0 }, config: DEFAULT_CONTEXT_CONFIG, durationMs: null,
});

/** Structural checks consumers rely on. Returns problems (empty when valid). */
export function validateContextAnalysis(a: ContextAnalysis): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const memberIds = new Set<string>();
  a.events.forEach((e, i) => {
    if (ids.has(e.id)) problems.push(`duplicate event id ${e.id}`);
    ids.add(e.id);
    if (e.id !== `ctx-${String(i).padStart(4, '0')}`) problems.push(`event id out of order: ${e.id}`);
    if (i > 0 && a.events[i - 1]!.startMs > e.startMs) problems.push(`event order: ${e.id}`);
    if (e.members.length === 0) problems.push(`${e.id}: no members`);
    for (const m of e.members) {
      if (memberIds.has(m.evidenceId)) problems.push(`${e.id}: evidence ${m.evidenceId} is in two events`);
      memberIds.add(m.evidenceId);
      if (!intervalsOverlap(m, e) || m.startMs < e.startMs || m.endMs > e.endMs) problems.push(`${e.id}: member ${m.evidenceId} outside the event`);
      if (!e.sources.includes(m.modality)) problems.push(`${e.id}: source list misses ${m.modality}`);
    }
    if (e.sources.length !== new Set(e.members.map((m) => m.modality)).size) problems.push(`${e.id}: sources do not match members`);
    if ((e.sources.length >= 2) !== (e.corroboration === 'multi-source')) problems.push(`${e.id}: corroboration mismatch`);
    if (e.endMs < e.startMs) problems.push(`${e.id}: ends before it starts`);
  });
  if (a.counts.eventCount !== a.events.length) problems.push('eventCount mismatch');
  return problems;
}
