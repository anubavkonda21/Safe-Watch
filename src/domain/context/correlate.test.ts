import { FIXTURES, ev, shuffled, speech, subtitle, visual } from '@/test/context';
import { DEFAULT_CONTEXT_CONFIG, validateContextConfig } from './contextEvent';
import { correlateEvidence } from './correlate';
import { validateContextAnalysis } from './contextAnalysis';

const run = (evidence: Parameters<typeof correlateEvidence>[0]['evidence'], rest: Omit<Parameters<typeof correlateEvidence>[0], 'evidence'> = {}) => correlateEvidence({ evidence, ...rest });
const ids = (e: { members: { evidenceId: string }[] }) => e.members.map((m) => m.evidenceId);

describe('fixtures from the specification', () => {
  it('A: speech, subtitle and visual evidence of one moment form ONE multi-source context', () => {
    const { events } = run(FIXTURES.fullMultimodal);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({ id: 'ctx-0000', startMs: 10_000, endMs: 11_200, sources: ['speech', 'subtitle', 'visual'], corroboration: 'multi-source', extended: false, closedBy: 'end-of-evidence' });
    expect(ids(e!)).toEqual(['spe-0', 'sub-0', 'vis-0', 'vis-1']);
    expect(e!.facts).toMatchObject({ speechPresent: true, subtitlePresent: true, visualEvidenceAvailable: true, textAvailable: true });
  });
  it('B: evidence 20 s apart is TWO contexts', () => {
    const { events } = run(FIXTURES.separated);
    expect(events.map((e) => [e.startMs, e.endMs, e.sources])).toEqual([[10_000, 10_400, ['speech', 'visual']], [30_000, 30_000, ['visual']]]);
    expect(events[0]!.closedBy).toBe('gap');
  });
  it('C: speech only is one single-source context', () => {
    const { events } = run(FIXTURES.speechOnly);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sources: ['speech'], corroboration: 'single-source', facts: { speechPresent: true, subtitlePresent: false, visualEvidenceAvailable: false } });
  });
  it('D: visual only is one single-source context', () => {
    const { events } = run(FIXTURES.visualOnly);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sources: ['visual'], facts: { textAvailable: false, visualEvidenceAvailable: true } });
  });
  it('E: subtitle plus visual is one context', () => {
    const { events } = run(FIXTURES.subtitleAndVisual);
    expect(events).toHaveLength(1);
    expect(events[0]!.sources).toEqual(['subtitle', 'visual']);
  });
  it('F: a 30 s subtitle is EXTENDED evidence: it keeps its own event and is only referenced from the separate visual events', () => {
    const { events } = run(FIXTURES.longSubtitle);
    expect(events.map((e) => [e.startMs, e.endMs, e.extended, e.sources])).toEqual([
      [10_000, 40_000, true, ['subtitle']], [12_000, 12_000, false, ['visual']], [25_000, 25_000, false, ['visual']], [38_000, 38_000, false, ['visual']],
    ]);
    expect(events[0]!.closedBy).toBe('long-evidence');
    for (const e of events.slice(1)) {
      expect(e.members.map((m) => m.modality)).toEqual(['visual']);
      expect(e.ambient.map((m) => [m.evidenceId, m.joinedBy])).toEqual([['sub-0', 'ambient']]);
    }
  });
  it('F (configured): with a longer maxContextMs the same subtitle connects the three visuals into one event', () => {
    const { events } = run(FIXTURES.longSubtitle, { config: { maxContextMs: 60_000 } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ startMs: 10_000, endMs: 40_000, extended: false, sources: ['subtitle', 'visual'] });
    expect(events[0]!.members.map((m) => m.joinedBy)).toEqual(['anchor', 'overlap', 'overlap', 'overlap']);
  });
  it('G: shuffled input gives exactly the same result as sorted input', () => {
    const all = [...FIXTURES.fullMultimodal, ...FIXTURES.separated.map((e) => ({ ...e, id: `b-${e.id}`, startSeconds: e.startSeconds + 100, endSeconds: e.endSeconds + 100 })), ...FIXTURES.longSubtitle.map((e) => ({ ...e, id: `c-${e.id}`, startSeconds: e.startSeconds + 200, endSeconds: e.endSeconds + 200 }))];
    const reference = run(all);
    for (const seed of [1, 2, 3, 99, 12345]) expect(run(shuffled(all, seed))).toEqual(reference);
    expect(run([...all].reverse())).toEqual(reference);
  });
  it('H: duplicates (same id, or same content under another id) are dropped, counted and deterministic', () => {
    const base = [speech('spe-0', 10, 11), visual('vis-0', 10.5)];
    const dup = [...base, speech('spe-0', 10, 11), { ...visual('vis-0', 10.5), id: 'vis-copy' }, speech('spe-0', 50, 51)];
    const r = run(dup);
    expect(r).toMatchObject({ duplicates: 3, invalid: 0, accepted: 2 });
    expect(r.events).toEqual(run(base).events);
    expect(run(shuffled(dup, 5)).events).toEqual(r.events);
  });
});

describe('grouping rules', () => {
  it('overlapping and adjacent intervals merge; the merge reason is recorded', () => {
    const { events } = run([speech('a', 0, 5), speech('b', 4, 8), subtitle('c', 8, 9), speech('d', 9.8, 10)]);
    expect(events).toHaveLength(1);
    expect(events[0]!.members.map((m) => [m.evidenceId, m.joinedBy])).toEqual([['a', 'anchor'], ['b', 'overlap'], ['c', 'overlap'], ['d', 'proximity']]);
  });
  it('the merge gap is windowBefore + windowAfter (1.5 s by default): just inside merges, just outside splits', () => {
    expect(run([speech('a', 0, 1), speech('b', 2.5, 3)]).events).toHaveLength(1);
    expect(run([speech('a', 0, 1), speech('b', 2.501, 3)]).events).toHaveLength(2);
    expect(run([speech('a', 0, 1), speech('b', 5, 6)], { config: { windowAfterMs: 4000 } }).events).toHaveLength(1);
  });
  it('does not over-merge: speech at 0 to 10 s and a visual at 30 to 40 s stay separate', () => {
    const { events } = run([speech('a', 0, 10), visual('v', 30), visual('w', 40)]);
    expect(events.map((e) => [e.startMs, e.endMs])).toEqual([[0, 10_000], [30_000, 30_000], [40_000, 40_000]]);
  });
  it('a long chain of touching speech never exceeds maxContextMs: it is cut with the reason max-duration', () => {
    const chain = Array.from({ length: 60 }, (_, i) => speech(`s${String(i).padStart(2, '0')}`, i, i + 1));
    const { events } = run(chain);
    expect(events.length).toBeGreaterThan(2);
    for (const e of events) expect(e.endMs - e.startMs).toBeLessThanOrEqual(DEFAULT_CONTEXT_CONFIG.maxContextMs);
    expect(events[0]!.closedBy).toBe('max-duration');
    expect(events.flatMap(ids)).toHaveLength(60); // nothing lost, nothing repeated
  });
  it('point observations: equal timestamps group; unrelated frames do not chain through coverage', () => {
    expect(run([visual('a', 5), visual('b', 5)]).events).toHaveLength(1);
    // Frames 10 s apart with a 10 s step: each frame reaches 5 s, but frames never chain to frames, so no giant event.
    const frames = Array.from({ length: 30 }, (_, i) => visual(`f${String(i).padStart(2, '0')}`, i * 10 + 5));
    expect(run(frames, { visualStepMs: 10_000 }).events).toHaveLength(30);
  });
  it('visual coverage relates a sparse frame to nearby text on BOTH sides, and says so', () => {
    const r = run([visual('before', 5), speech('talk', 10, 11.5), visual('after', 15)], { visualStepMs: 10_000 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.members.map((m) => [m.evidenceId, m.joinedBy])).toEqual([['before', 'anchor'], ['talk', 'visual-coverage'], ['after', 'visual-coverage']]);
    // Without a known sampling step frames have no reach.
    expect(run([visual('before', 5), speech('talk', 10, 11.5), visual('after', 15)]).events).toHaveLength(3);
    // A frame outside its coverage stays out.
    expect(run([speech('talk', 10, 11.5), visual('far', 25)], { visualStepMs: 10_000 }).events).toHaveLength(2);
  });
  it('a frame attached only through its coverage does not bridge two sentences into one event', () => {
    const { events } = run([speech('a', 0, 2.6), visual('frame', 4.3), speech('b', 6.5, 8)], { visualStepMs: 2800 });
    expect(events.map((e) => ids(e))).toEqual([['a', 'frame'], ['b']]);
    expect(events[0]!.members[1]!.joinedBy).toBe('visual-coverage');
  });
  it('coverage is capped by maxVisualCoverageMs', () => {
    const items = [speech('talk', 10, 11), visual('v', 20)];
    expect(run(items, { visualStepMs: 60_000 }).events).toHaveLength(2); // reach is capped at 5 s: 20 - 0.5 - 5 > 12
    expect(run(items, { visualStepMs: 60_000, config: { maxVisualCoverageMs: 12_000 } }).events).toHaveLength(1);
  });
  it('speech and subtitle with the same wording stay two distinct sources: neither replaces the other', () => {
    const { events } = run([speech('s', 10, 12, { label: 'safe watch' }), subtitle('t', 10.1, 12, { label: 'SafeWatch' })]);
    expect(events[0]!.members.map((m) => [m.modality, m.label])).toEqual([['speech', 'safe watch'], ['subtitle', 'SafeWatch']]);
  });
  it('empty input gives no events', () => {
    expect(run([])).toEqual({ events: [], invalid: 0, duplicates: 0, accepted: 0 });
  });
});

describe('provenance and confidence', () => {
  it('keeps each member exactly as received (time, kind, label, source, own confidence)', () => {
    const { events } = run([speech('s', 10.004, 11.2, { confidence: 0.81, sourceId: 'aud-3' }), visual('v', 10.4, { kind: 'object', label: 'person', confidence: 0.94, sourceId: 'frm-00007' })]);
    expect(events[0]!.members).toEqual([
      { evidenceId: 's', modality: 'speech', kind: 'speech', startMs: 10_004, endMs: 11_200, label: 's label', confidence: 0.81, sourceId: 'aud-3', joinedBy: 'anchor' },
      { evidenceId: 'v', modality: 'visual', kind: 'object', startMs: 10_400, endMs: 10_400, label: 'person', confidence: 0.94, sourceId: 'frm-00007', joinedBy: 'overlap' },
    ]);
  });
  it('summarises confidence PER modality and never produces one combined number', () => {
    const { events } = run([speech('s', 10, 11, { confidence: 0.81 }), visual('a', 10.2, { confidence: 0.94 }), visual('b', 10.4, { confidence: 0.4 }), visual('c', 10.5, { confidence: null }), subtitle('t', 10, 11)]);
    expect(events[0]!.confidence).toEqual([
      { modality: 'speech', count: 1, withConfidence: 1, min: 0.81, max: 0.81 },
      { modality: 'subtitle', count: 1, withConfidence: 0, min: null, max: null },
      { modality: 'visual', count: 3, withConfidence: 2, min: 0.4, max: 0.94 },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/combined|average|overall/i);
  });
  it('treats an out-of-range confidence as unknown instead of repairing it', () => {
    const { events } = run([visual('a', 1, { confidence: 3 }), visual('b', 1.1, { confidence: NaN })]);
    expect(events[0]!.members.map((m) => m.confidence)).toEqual([null, null]);
  });
  it('highlights are the strongest distinct visual observations, by the provider confidence, at most five', () => {
    const v = (id: string, label: string, c: number | null, kind = 'classification') => visual(id, 10, { label, confidence: c, kind });
    const { events } = run([v('1', 'indoor', 0.9), v('2', 'indoor', 0.5), v('3', 'person', 0.95, 'object'), v('4', 'a', 0.1), v('5', 'b', 0.2), v('6', 'c', 0.3), v('7', 'd', null)]);
    expect(events[0]!.facts.highlights.map((h) => [h.kind, h.label, h.confidence])).toEqual([['object', 'person', 0.95], ['classification', 'indoor', 0.9], ['classification', 'c', 0.3], ['classification', 'b', 0.2], ['classification', 'a', 0.1]]);
    expect(events[0]!.facts.kinds).toEqual({ classification: 5, object: 1 }); // the second indoor is a content duplicate (same frame, time, kind, label) and is dropped
  });
  it('OCR text counts as text, even without speech or subtitles', () => {
    expect(run([visual('t', 3, { kind: 'text', label: 'STOP' })]).events[0]!.facts).toMatchObject({ textAvailable: true, speechPresent: false, subtitlePresent: false });
  });
});

describe('malformed evidence', () => {
  const bad = [
    { ...speech('x', 1, 2), id: '' }, { ...speech('x', 5, 2) }, { ...speech('x', -1, 2) }, { ...speech('x', NaN, 2) }, { ...speech('x', 1, Infinity) },
    { ...speech('x', 1, 2), modality: 'audio' }, { ...speech('x', 1, 2), startSeconds: '1' }, null, 'junk', { ...speech('x', 1, 2), kind: 5 }, { ...speech('x', 1, 2), sourceId: undefined },
  ] as never[];
  it.each(bad.map((b, i) => [i, b]))('drops malformed item #%i without crashing and counts it', (_i, item) => {
    const r = run([speech('ok', 1, 2), item]);
    expect(r).toMatchObject({ invalid: 1, accepted: 1 });
    expect(r.events).toHaveLength(1);
  });
});

describe('structure', () => {
  it('every produced analysis is structurally valid and ids follow chronological order', () => {
    const all = [...FIXTURES.fullMultimodal, ...FIXTURES.separated.map((e) => ({ ...e, id: `b-${e.id}`, startSeconds: e.startSeconds + 100, endSeconds: e.endSeconds + 100 })), ...FIXTURES.longSubtitle.map((e) => ({ ...e, id: `c-${e.id}`, startSeconds: e.startSeconds + 200, endSeconds: e.endSeconds + 200 }))];
    const { events } = run(all);
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => `ctx-${String(i).padStart(4, '0')}`));
    const analysis = { mediaId: 'm', status: 'ready' as const, inputs: { speech: 'used', subtitles: 'used', visual: 'used' } as const, events, counts: { eventCount: events.length, evidenceCount: 0, invalidEvidence: 0, duplicateEvidence: 0 }, config: DEFAULT_CONTEXT_CONFIG, warnings: [], durationMs: null };
    expect(validateContextAnalysis(analysis)).toEqual([]);
  });
  it('each non-extended evidence item appears in exactly one event', () => {
    const items = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? speech : i % 3 === 1 ? subtitle : (id: string, s: number) => visual(id, s))(`e${String(i).padStart(3, '0')}`, i * 0.9, i * 0.9 + 0.5));
    const { events } = run(items);
    const all = events.flatMap(ids);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(200);
  });
  it('contains no safety vocabulary in its own fields', () => {
    const { events } = run(FIXTURES.fullMultimodal);
    const own = JSON.stringify(events.map((e) => ({ ...e, members: [], ambient: [], facts: { ...e.facts, highlights: [] } })));
    expect(own).not.toMatch(/safe|unsafe|danger|violen|sexual|drug|graphic|explicit|policy|score|verdict|risk/i);
  });
});

describe('configuration', () => {
  it('validates settings', () => {
    expect(validateContextConfig(DEFAULT_CONTEXT_CONFIG)).toEqual([]);
    expect(validateContextConfig({ ...DEFAULT_CONTEXT_CONFIG, windowAfterMs: -1 })).toHaveLength(1);
    expect(validateContextConfig({ ...DEFAULT_CONTEXT_CONFIG, maxContextMs: 0 })).toHaveLength(1);
    expect(validateContextConfig({ ...DEFAULT_CONTEXT_CONFIG, windowBeforeMs: 1.5 })).toHaveLength(1);
  });
  it('is explicit: a stricter window splits what the default merges', () => {
    const items = [speech('a', 0, 1), speech('b', 2, 3)];
    expect(run(items).events).toHaveLength(1);
    expect(run(items, { config: { windowBeforeMs: 0, windowAfterMs: 500 } }).events).toHaveLength(2);
  });
  it('is unused by evidence helpers: ev() builds the expected generic item', () => {
    expect(ev('visual', 'x', 1).kind).toBe('object');
  });
});
