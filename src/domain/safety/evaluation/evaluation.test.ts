import { DATASET_ID, DATASET_VERSION, FLAGGED_TERMS_EXAMPLES } from './flaggedTerms.v1';
import { runExample, scoreExample, summarize, type ExampleResult } from './harness';

const run = async (): Promise<ExampleResult[]> => Promise.all(FLAGGED_TERMS_EXAMPLES.map(async (e) => scoreExample(e, await runExample(e))));

describe(`${DATASET_ID} v${DATASET_VERSION} (synthetic engineering fixtures, not a benchmark)`, () => {
  it('has unique ids and covers every required scenario kind', () => {
    const ids = FLAGGED_TERMS_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(FLAGGED_TERMS_EXAMPLES.map((e) => e.kind));
    for (const k of ['positive', 'negative', 'lookalike', 'normalization', 'boundary', 'ambiguous', 'contradictory', 'missing-input', 'known-limitation']) expect(kinds.has(k as never)).toBe(true);
    expect(FLAGGED_TERMS_EXAMPLES.length).toBe(43);
  });
  it('every example behaves as labelled; every known limitation still reproduces', async () => {
    const results = await run();
    expect(results.filter((r) => r.outcome === 'failed').map((r) => `${r.id}: ${r.failures.join('; ')}`)).toEqual([]);
    expect(results.filter((r) => r.outcome === 'known-limitation').map((r) => r.id)).toEqual([
      'L01-spaced-out-letters', 'L02-character-substitution', 'L03-inflected-form', 'L04-word-split-across-cues', 'L05-same-spelling-different-meaning', 'L06-misheard-by-recognizer',
    ]);
  });
  it('reports the pinned metrics (a change here is a behaviour change and must be explained)', async () => {
    expect(summarize(await run())).toEqual({
      examples: 43, passed: 37, knownLimitations: 6, failed: 0, tp: 28, fp: 1, fn: 5, tn: 9, precision: 0.9655, recall: 0.8485, abstainedExamples: 3, abstentionRate: 0.0698,
      findings: 29, uncertainFindings: 2, uncertainRate: 0.069, meanIou: 1, maxBoundaryErrorMs: 0,
    });
  });
  it('word-level timing is exact (boundary error 0 ms) wherever the transcript has word times', async () => {
    const timed = (await run()).filter((r) => ['P01-word-in-speech', 'P04-two-occurrences', 'B01-at-media-start', 'B03-one-millisecond-apart'].includes(r.id));
    expect(timed.every((r) => r.maxBoundaryErrorMs === 0 && r.iou.every((v) => v === 1))).toBe(true);
  });
  it('the unsure cases are reported as uncertain, not detected, and abstention is explicit', async () => {
    const byId = new Map((await run()).map((r) => [r.id, r]));
    expect(byId.get('A01-low-recognizer-confidence')!.uncertainFindings).toBe(1);
    expect(byId.get('A02-speech-contradicted-by-subtitle')!.uncertainFindings).toBe(1);
    expect(byId.get('A04-low-confidence-but-subtitle-agrees')!.uncertainFindings).toBe(0);
    for (const id of ['M03-all-text-unavailable', 'M04-no-terms', 'M05-only-disabled-terms']) expect(byId.get(id)!.abstained).toBe(true);
  });
  it('the harness detects a wrong classifier (a mislabelled example fails)', async () => {
    const example = { ...FLAGGED_TERMS_EXAMPLES[0]!, expect: { evaluation: 'evaluated' as const, findings: [] } };
    const r = scoreExample(example, await runExample(example));
    expect(r.outcome).toBe('failed');
    expect(r.fp).toBe(1);
  });
});
