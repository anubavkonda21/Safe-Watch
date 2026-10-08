import type { TextEvent } from '../text/textEvent';
import type { VisualObservation } from '../vision/observation';
import { buildEvidenceTimeline, evidenceBetween, evidenceFromObservation, evidenceFromTextEvent } from './evidence';

const speech: TextEvent = { id: 'spe-aud-0-0', source: 'speech', startSeconds: 4, endSeconds: 7, text: 'hello there', language: 'en', trackId: 'aud-0', streamIndex: 1, confidence: 0.9, words: null, evidence: 'speech-only' };
const sub: TextEvent = { ...speech, id: 'sub-sub-0-0', source: 'subtitle', startSeconds: 5, endSeconds: 6, trackId: 'sub-0', confidence: null, evidence: 'subtitle-only' };
const visual: VisualObservation = { id: 'vis-frm-00001-0', frameId: 'frm-00001', frameIndex: 1, timestampSeconds: 5.5, type: 'object', label: 'person', confidence: 0.8, region: null, attributes: null, provider: 'p', model: 'm' };
const ocr: VisualObservation = { ...visual, id: 'vis-frm-00001-1', type: 'text', label: 'text', attributes: { text: 'STOP' } };

describe('evidence timeline', () => {
  it('projects each modality without changing what it says', () => {
    expect(evidenceFromTextEvent(speech)).toEqual({ id: 'spe-aud-0-0', modality: 'speech', kind: 'speech', startSeconds: 4, endSeconds: 7, label: 'hello there', confidence: 0.9, sourceId: 'aud-0' });
    expect(evidenceFromObservation(visual)).toMatchObject({ modality: 'visual', kind: 'object', startSeconds: 5.5, endSeconds: 5.5, label: 'person', sourceId: 'frm-00001' });
    expect(evidenceFromObservation(ocr).label).toBe('STOP');
  });
  it('merges speech, subtitles and visual evidence chronologically and deterministically', () => {
    const a = buildEvidenceTimeline([sub, speech], [ocr, visual]);
    expect(a.map((i) => i.id)).toEqual(['spe-aud-0-0', 'sub-sub-0-0', 'vis-frm-00001-0', 'vis-frm-00001-1']);
    expect(buildEvidenceTimeline([speech, sub], [visual, ocr])).toEqual(a);
  });
  it('finds evidence of any modality overlapping a moment', () => {
    const items = buildEvidenceTimeline([speech], [visual]);
    expect(evidenceBetween(items, 5.5, 5.5).map((i) => i.modality)).toEqual(['speech', 'visual']);
    expect(evidenceBetween(items, 8, 9)).toEqual([]);
  });
  it('carries no judgement fields', () => {
    expect(Object.keys(evidenceFromObservation(visual)).sort()).toEqual(['confidence', 'endSeconds', 'id', 'kind', 'label', 'modality', 'sourceId', 'startSeconds']);
  });
});
