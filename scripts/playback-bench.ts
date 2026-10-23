/**
 * Manual measurement of the playback-action coordinator (not part of the test suite).
 *  1. Setup cost: planning candidates, resolving choices and building merged spans for N findings (done when findings or choices change).
 *  2. Per-event cost: a fake player is driven through one hour of 60 fps playback (every animation frame is an event) with N skip and mute spans.
 * The coordinator never classifies, sorts or touches the file system per event.
 *
 *   npm run check:playback
 */
import { actionsOf, buildSpans, resolveViews, INITIAL_SETTINGS } from '@/domain/playback/actions';
import { PlaybackCoordinator, type PlaybackSurface } from '@/domain/playback/coordinator';
import { planCandidates } from '@/domain/playback/planning';
import { TAXONOMY_VERSION, type SafetyAnalysis, type SafetyFinding } from '@/domain/safety/finding';

const HOUR = 3_600_000;
const finding = (i: number, n: number): SafetyFinding => {
  const startMs = Math.floor((i + 0.5) * (HOUR / n));
  const endMs = startMs + 100 + (i % 3) * 50; // short, so findings stay separate even at 10 000 per hour
  return {
    id: `sf-flagged-terms-${String(i).padStart(4, '0')}`, category: 'flagged-terms', taxonomyVersion: TAXONOMY_VERSION, startMs, endMs, status: 'detected', rawScore: null, calibratedProbability: null,
    evidence: [{ evidenceId: `e${i}`, modality: 'speech', kind: 'speech', startMs, endMs, sourceId: 'aud-0', contextEventId: null, sourceConfidence: 0.9 }],
    explanation: 'x', warnings: [], classifier: { id: 'c', version: '1', kind: 'rule-based' }, attributes: { term: `term${i % 50}`, matchMode: 'word-boundary', matchedText: 'x' },
  };
};
const analysis = (n: number): SafetyAnalysis => ({
  mediaId: 'm', taxonomyVersion: TAXONOMY_VERSION, status: 'ready', categories: [], findings: Array.from({ length: n }, (_, i) => finding(i, n)), inputs: { speech: 'used', subtitles: 'used', visual: 'used' },
  classifiers: [], policy: { uncertainBelowSourceConfidence: 0.5 }, termCount: 1, warnings: [], durationMs: HOUR,
});
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

class Surface implements PlaybackSurface {
  timeMs = 0; paused = false; muted = false; durationMs: number | null = HOUR; seeks = 0;
  get currentTimeMs() { return this.timeMs; }
  seekToMs(ms: number) { this.seeks += 1; this.timeMs = ms; } // lands immediately
}

const rows: Array<Record<string, unknown>> = [];
for (const n of [10, 100, 1000, 10_000]) {
  const a = analysis(n);
  const setup: number[] = [];
  for (let r = 0; r < 7; r++) {
    const t0 = performance.now();
    const cands = planCandidates({ mediaId: 'm', analysis: a, durationMs: HOUR });
    const settings = { ...INITIAL_SETTINGS, choices: Object.fromEntries(cands.map((c, i) => [c.overrideKey, i % 2 ? 'mute' : 'skip'] as const)) };
    const actions = actionsOf(resolveViews(cands, settings));
    buildSpans(actions, 'mute'); buildSpans(actions, 'skip');
    setup.push(performance.now() - t0);
  }
  const cands = planCandidates({ mediaId: 'm', analysis: a, durationMs: HOUR });
  const actions = actionsOf(resolveViews(cands, { ...INITIAL_SETTINGS, choices: Object.fromEntries(cands.map((c, i) => [c.overrideKey, i % 2 ? 'mute' : 'skip'] as const)) }));

  const surface = new Surface();
  const coordinator = new PlaybackCoordinator(surface);
  coordinator.setActions(actions, true);
  coordinator.handle('play');
  let events = 0;
  const frameMs = 1000 / 60;
  const t0 = performance.now();
  // A faithful player: it advances one frame at a time, and a seek the coordinator asks for lands before the next frame.
  for (let t = 0; t < HOUR; ) {
    surface.timeMs = Math.round(t);
    const before = surface.seeks;
    coordinator.handle('frame');
    events += 1;
    if (surface.seeks !== before) { coordinator.handle('seeked'); events += 1; t = surface.timeMs; }
    t += frameMs;
  }
  const elapsed = performance.now() - t0;
  rows.push({ findings: n, setupMedianMs: Number(median(setup).toFixed(2)), frameEvents: events, totalMs: Number(elapsed.toFixed(0)), nsPerEvent: Math.round((elapsed * 1e6) / events), skipsExecuted: surface.seeks });
}
console.table(rows);
console.log(JSON.stringify(rows));
