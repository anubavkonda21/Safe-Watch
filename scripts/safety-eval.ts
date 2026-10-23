/**
 * Evaluation of the flagged-term classifier on the labelled engineering fixtures (not part of the test suite's pass/fail
 * criteria by itself, but the tests pin the same numbers). Prints per-example outcomes and the metrics.
 *
 *   npm run eval:safety
 *
 * These fixtures are synthetic. The numbers show the classifier behaves as documented; they are NOT real-world accuracy.
 */
import { FLAGGED_TERMS_EXAMPLES, DATASET_ID, DATASET_VERSION } from '@/domain/safety/evaluation/flaggedTerms.v1';
import { runExample, scoreExample, summarize } from '@/domain/safety/evaluation/harness';

const results = [];
for (const example of FLAGGED_TERMS_EXAMPLES) results.push(scoreExample(example, await runExample(example)));

console.log(`dataset ${DATASET_ID} v${DATASET_VERSION}: ${results.length} synthetic engineering examples`);
console.table(results.map((r) => ({ id: r.id, kind: r.kind, outcome: r.outcome, tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, abstained: r.abstained, uncertain: r.uncertainFindings, failures: r.failures.join('; ') })));
const byKind = new Map<string, typeof results>();
for (const r of results) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
console.table([...byKind].map(([kind, rs]) => ({ kind, ...summarize(rs) })));
const overall = summarize(results);
console.log('overall', JSON.stringify(overall));
if (overall.failed > 0) { console.error(`${overall.failed} example(s) did not behave as labelled (or a known limitation no longer reproduces)`); process.exit(1); }
