import type { Modality } from '@/domain/evidence/evidence';
import type { ClosedBy, ContextConfig, JoinReason } from '@/domain/context/contextEvent';
import type { ContextWarningCode, InputStatus } from '@/domain/context/contextAnalysis';

/** Fixed, plain-language copy for the context layer. It describes grouping by time only: it never assesses content. */
export const MODALITY_LABEL: Record<Modality, string> = { speech: 'Speech', subtitle: 'Subtitles', visual: 'Visual' };

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))} s`;

export function joinText(reason: JoinReason, config: ContextConfig): string {
  switch (reason) {
    case 'anchor': return 'Started this context';
    case 'overlap': return 'Overlaps in time';
    case 'proximity': return `Starts within ${seconds(config.windowBeforeMs + config.windowAfterMs)} of the evidence before it`;
    case 'visual-coverage': return 'The frame stands for this moment (it was sampled nearby)';
    case 'ambient': return 'Lasts longer than a context, so it is listed here without being merged';
  }
}

export function closedByText(reason: ClosedBy, config: ContextConfig): string {
  switch (reason) {
    case 'gap': return `The next evidence is more than ${seconds(config.windowBeforeMs + config.windowAfterMs)} away.`;
    case 'max-duration': return `A context is cut at ${seconds(config.maxContextMs)}; the next evidence starts a new one.`;
    case 'long-evidence': return `This single piece of evidence lasts longer than ${seconds(config.maxContextMs)}, so it is kept on its own.`;
    case 'end-of-evidence': return 'There is no later evidence.';
  }
}

export function inputNote(name: 'speech' | 'subtitles' | 'visual', status: InputStatus): string | null {
  const label = name === 'speech' ? 'Speech' : name === 'subtitles' ? 'Subtitles' : 'Visual evidence';
  switch (status) {
    case 'failed': return `${label} could not be read, so it is missing from the contexts below.`;
    case 'not-enabled': return `${label} is not enabled on this server, so it is missing from the contexts below.`;
    default: return null;
  }
}

export function warningText(code: ContextWarningCode, count: number): string | null {
  switch (code) {
    case 'invalid-evidence': return `${count} unusable ${count === 1 ? 'item was' : 'items were'} left out.`;
    case 'duplicate-evidence': return `${count} repeated ${count === 1 ? 'item was' : 'items were'} left out.`;
    case 'no-evidence': return 'The earlier steps found no speech, subtitles or visual evidence to correlate.';
    default: return null; // missing inputs are explained by inputNote
  }
}
