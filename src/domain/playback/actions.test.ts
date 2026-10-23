import { safetyFor } from '@/test/safetyAnalysis';
import { INITIAL_SETTINGS, actionsOf, buildSpans, choiceFor, nextEdgeMs, resolveViews, spanAt, type ActionSettings } from './actions';
import { planCandidates } from './planning';
import { act } from '@/test/playback';

const candidates = async () => planCandidates({ mediaId: 'm', analysis: await safetyFor('m', [['safe watch', 'phrase'], ['written', 'case-insensitive']]), durationMs: 24_000 });

describe('resolveViews', () => {
  it('configures nothing by default: no finding gets an action until the user chooses', async () => {
    const views = resolveViews(await candidates(), INITIAL_SETTINGS);
    expect(views.every((v) => v.state === 'none' && v.action === null && v.isDefault)).toBe(true);
    expect(actionsOf(views)).toEqual([]);
  });
  it('the default choice applies to findings the user has not decided about; a personal choice wins', async () => {
    const cs = await candidates();
    const settings: ActionSettings = { autoEnabled: true, defaultChoice: 'mute', choices: { [cs[0]!.overrideKey]: 'skip' } };
    const views = resolveViews(cs, settings);
    expect(views[0]).toMatchObject({ choice: 'skip', isDefault: false, state: 'enabled', action: { type: 'skip', status: 'enabled' } });
    expect(views[1]).toMatchObject({ choice: 'mute', isDefault: true, state: 'enabled', action: { type: 'mute' } });
  });
  it('ignore and none make no action; an ignore can be undone by choosing again', async () => {
    const cs = await candidates();
    const ignored = resolveViews(cs, { ...INITIAL_SETTINGS, defaultChoice: 'mute', choices: { [cs[0]!.overrideKey]: 'ignore' } });
    expect(ignored[0]).toMatchObject({ state: 'ignored', action: null });
    const undone = resolveViews(cs, { ...INITIAL_SETTINGS, defaultChoice: 'mute', choices: { [cs[0]!.overrideKey]: 'mute' } });
    expect(undone[0]).toMatchObject({ state: 'enabled', action: { type: 'mute' } });
  });
  it('the master switch turns every action into a disabled one (kept, so it can be turned back on)', async () => {
    const views = resolveViews(await candidates(), { ...INITIAL_SETTINGS, autoEnabled: false, defaultChoice: 'skip' });
    expect(views.every((v) => v.state === 'off' && v.action?.status === 'disabled')).toBe(true);
  });
  it('an unavailable candidate never gets an action, whatever the settings say', async () => {
    const cs = (await candidates()).map((c) => ({ ...c, availability: 'unavailable' as const, unavailableReason: 'zero-length' as const }));
    const views = resolveViews(cs, { ...INITIAL_SETTINGS, defaultChoice: 'skip', choices: { [cs[0]!.overrideKey]: 'mute' } });
    expect(views.every((v) => v.state === 'unavailable' && v.action === null)).toBe(true);
  });
  it('an uncertain finding is not acted on unless the user chose it', async () => {
    const cs = (await candidates()).map((c) => ({ ...c, findingStatus: 'uncertain' as const }));
    expect(actionsOf(resolveViews(cs, INITIAL_SETTINGS))).toEqual([]);
    const chosen = resolveViews(cs, { ...INITIAL_SETTINGS, choices: { [cs[0]!.overrideKey]: 'mute' } });
    expect(chosen[0]!.action).toMatchObject({ type: 'mute', findingStatus: 'uncertain' });
  });
  it('explains the action: which finding, what was chosen, how the interval was determined', async () => {
    const cs = await candidates();
    const [v] = resolveViews(cs, { ...INITIAL_SETTINGS, choices: { [cs[0]!.overrideKey]: 'mute' } });
    expect(v!.action!.reason).toContain('Mutes');
    expect(v!.action!.reason).toContain(cs[0]!.findingId);
    expect(v!.action!.reason).toContain('flagged term');
    expect(v!.action!.reason).toContain('Chosen by you');
    expect(v!.action!.reason).toMatch(/margin of \d+ ms before and \d+ ms after|the finding’s own interval/);
  });
  it('does not mutate its inputs and never alters the findings', async () => {
    const analysis = await safetyFor('m', [['safe watch', 'phrase']]);
    const before = JSON.stringify(analysis);
    const cs = planCandidates({ mediaId: 'm', analysis, durationMs: 24_000 });
    resolveViews(cs, { ...INITIAL_SETTINGS, defaultChoice: 'skip' });
    expect(JSON.stringify(analysis)).toBe(before);
  });
  it('choiceFor ignores inherited object keys (a hostile key cannot become a choice)', async () => {
    const [c] = await candidates();
    expect(choiceFor({ ...c!, overrideKey: 'constructor' }, INITIAL_SETTINGS)).toEqual({ choice: 'none', isDefault: true });
    expect(choiceFor({ ...c!, overrideKey: '__proto__' }, INITIAL_SETTINGS)).toEqual({ choice: 'none', isDefault: true });
  });
});

describe('buildSpans', () => {
  it('merges overlapping and directly adjacent actions of one type, keeps every source, sorts', () => {
    const spans = buildSpans([act('c', 'mute', 9000, 10_000), act('a', 'mute', 1000, 3000), act('b', 'mute', 2000, 4000), act('d', 'mute', 4000, 5000)], 'mute');
    expect(spans.map((s) => [s.startMs, s.endMs, s.findingIds.sort()])).toEqual([[1000, 5000, ['a', 'b', 'd']], [9000, 10_000, ['c']]]);
    expect(spans[0]!.key).toBe('1000-5000');
  });
  it('keeps a one-millisecond gap as two spans', () => {
    expect(buildSpans([act('a', 'mute', 1000, 2000), act('b', 'mute', 2001, 3000)], 'mute')).toHaveLength(2);
  });
  it('separates types and drops disabled and empty actions', () => {
    const all = [act('a', 'mute', 1000, 2000), act('b', 'skip', 1000, 2000), act('c', 'mute', 3000, 4000, { status: 'disabled' }), act('d', 'skip', 5000, 5000)];
    expect(buildSpans(all, 'mute').map((s) => s.findingIds)).toEqual([['a']]);
    expect(buildSpans(all, 'skip').map((s) => s.findingIds)).toEqual([['b']]);
  });
  it('is deterministic whatever the input order', () => {
    const items = [act('a', 'skip', 1000, 3000), act('b', 'skip', 2000, 4000), act('c', 'skip', 8000, 9000)];
    expect(buildSpans([...items].reverse(), 'skip')).toEqual(buildSpans(items, 'skip'));
  });
  it('spanAt is half-open and finds the right span among many', () => {
    const spans = buildSpans(Array.from({ length: 2000 }, (_, i) => act(`s${i}`, 'mute', i * 10_000, i * 10_000 + 1000)), 'mute');
    expect(spanAt(spans, 9_999_999 - 9_999_999)).toMatchObject({ startMs: 0 });
    expect(spanAt(spans, 500)).toMatchObject({ startMs: 0 });
    expect(spanAt(spans, 1000)).toBeNull();
    expect(spanAt(spans, 1_234_567 - 1_234_567 + 12_345_000 - 12_345_000 + 5_000_500)?.startMs).toBe(5_000_000);
    expect(spanAt(spans, 19_990_999)).toMatchObject({ startMs: 19_990_000 });
    expect(spanAt(spans, 19_991_000)).toBeNull();
  });
});

describe('nextEdgeMs', () => {
  const spans = buildSpans([act('a', 'mute', 1000, 2000), act('b', 'mute', 5000, 6000)], 'mute');
  it('gives the distance to the next start, or to the end of the span the position is inside', () => {
    expect(nextEdgeMs(spans, 0)).toBe(1000);
    expect(nextEdgeMs(spans, 1000)).toBe(1000); // inside: its end
    expect(nextEdgeMs(spans, 1500)).toBe(500);
    expect(nextEdgeMs(spans, 2000)).toBe(3000); // the end is outside: next start
    expect(nextEdgeMs(spans, 5999)).toBe(1);
  });
  it('is null after the last span or with no spans', () => {
    expect(nextEdgeMs(spans, 6000)).toBeNull();
    expect(nextEdgeMs([], 0)).toBeNull();
  });
});
