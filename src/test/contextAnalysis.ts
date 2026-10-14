import { buildContextAnalysis, type ContextAnalysis, type ContextSource } from '@/domain/context/contextAnalysis';
import { readyTextAnalysis } from './textAnalysis';
import { readyVisual } from './visualAnalysis';

/** Context built from the shared text and visual test fixtures: the first event holds speech, subtitle and visual evidence. */
export const readyContext = (mediaId: string, over: Partial<ContextSource> = {}): ContextAnalysis =>
  buildContextAnalysis({ mediaId, extractionStatus: 'completed', mediaDurationSeconds: 24, text: readyTextAnalysis(mediaId), visual: readyVisual(mediaId), frameStepSeconds: 3, ...over });
