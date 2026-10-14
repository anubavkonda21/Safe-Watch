/**
 * Manual measurement of context construction (not part of the test suite).
 * Builds synthetic evidence of increasing size (speech and subtitle segments plus visual observations,
 * as a long video would produce) and times `correlateEvidence`, the only work the context endpoint does.
 *
 *   npm run check:context
 */
import { correlateEvidence } from '@/domain/context/correlate';
import type { EvidenceItem } from '@/domain/evidence/evidence';

function synthetic(minutes: number): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const seconds = minutes * 60;
  // One spoken sentence and its subtitle cue about every 6 s, 8 observations per frame, one frame every 3 s.
  for (let t = 0, n = 0; t < seconds; t += 6, n++) {
    out.push({ id: `spe-${n}`, modality: 'speech', kind: 'speech', startSeconds: t + 0.2, endSeconds: t + 3.4, label: `sentence ${n}`, confidence: 0.85, sourceId: 'aud-0' });
    out.push({ id: `sub-${n}`, modality: 'subtitle', kind: 'subtitle', startSeconds: t + 0.3, endSeconds: t + 3.3, label: `cue ${n}`, confidence: null, sourceId: 'sub-0' });
  }
  for (let t = 1.5, f = 0; t < seconds; t += 3, f++) {
    for (let k = 0; k < 8; k++) out.push({ id: `vis-${f}-${k}`, modality: 'visual', kind: k === 0 ? 'object' : 'classification', startSeconds: t, endSeconds: t, label: `label ${k}`, confidence: 0.5 + k / 20, sourceId: `frm-${f}` });
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const rows: Array<Record<string, unknown>> = [];
for (const [name, minutes] of [['small (1 min)', 1], ['medium (30 min)', 30], ['large (6 h)', 360], ['very large (24 h)', 1440]] as const) {
  const evidence = synthetic(minutes);
  correlateEvidence({ evidence, visualStepMs: 3000 }); // warm-up
  const times: number[] = [];
  let result = correlateEvidence({ evidence, visualStepMs: 3000 });
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    result = correlateEvidence({ evidence, visualStepMs: 3000 });
    times.push(performance.now() - t0);
  }
  const json = JSON.stringify(result.events);
  rows.push({ size: name, evidenceItems: evidence.length, events: result.events.length, medianMs: Number(median(times).toFixed(2)), usPerItem: Number(((median(times) * 1000) / evidence.length).toFixed(2)), eventsJsonKB: Math.round(json.length / 1024) });
}
console.table(rows);
console.log(JSON.stringify(rows));
