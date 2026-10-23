import { updateCustomFilter, MAX_FILTERS, MAX_PHRASE_LENGTH, createCustomFilter, parseStoredFilters, type CustomFilter } from './customFilter';

const env = (n = 1) => ({ id: `f${n}`, now: '2026-01-01T00:00:00.000Z' });

describe('createCustomFilter', () => {
  it('creates an enabled filter with a cleaned phrase and a normalised matching form', () => {
    const r = createCustomFilter('  Safe​Watch   Test ‮', 'word-boundary', [], env());
    expect(r).toEqual({ ok: true, filter: { id: 'f1', phrase: 'SafeWatch Test', normalizedPhrase: 'safewatch test', matchMode: 'word-boundary', enabled: true, createdAt: '2026-01-01T00:00:00.000Z' } });
  });
  it('rejects empty, whitespace-only, punctuation-only and over-long phrases', () => {
    expect(createCustomFilter('', 'phrase', [], env())).toEqual({ ok: false, reason: 'empty' });
    expect(createCustomFilter(' \t​ ', 'phrase', [], env())).toEqual({ ok: false, reason: 'empty' });
    expect(createCustomFilter('?!…', 'phrase', [], env())).toEqual({ ok: false, reason: 'no-words' });
    expect(createCustomFilter('x'.repeat(MAX_PHRASE_LENGTH + 1), 'phrase', [], env())).toEqual({ ok: false, reason: 'too-long' });
    expect(createCustomFilter('x'.repeat(MAX_PHRASE_LENGTH), 'phrase', [], env()).ok).toBe(true);
  });
  it('prevents duplicates by normalised form and mode, but allows the same phrase in another mode', () => {
    const first = createCustomFilter('Hello', 'phrase', [], env(1));
    const list = first.ok ? [first.filter] : [];
    expect(createCustomFilter('  hello ', 'phrase', list, env(2))).toEqual({ ok: false, reason: 'duplicate' });
    expect(createCustomFilter('ＨＥＬＬＯ', 'phrase', list, env(2))).toEqual({ ok: false, reason: 'duplicate' });
    expect(createCustomFilter('hello', 'exact', list, env(2)).ok).toBe(true);
  });
  it('enforces a maximum number of filters', () => {
    const many = Array.from({ length: MAX_FILTERS }, (_, i) => ({ id: `${i}`, phrase: `p${i}`, normalizedPhrase: `p${i}`, matchMode: 'phrase' as const, enabled: true, createdAt: 'x' }));
    expect(createCustomFilter('new', 'phrase', many, env())).toEqual({ ok: false, reason: 'limit-reached' });
  });
  it('keeps hostile phrases as inert text', () => {
    const r = createCustomFilter('<script>alert(1)</script> $(rm -rf /) .*+?^${}()|[]\\', 'case-insensitive', [], env());
    expect(r.ok && r.filter.phrase).toBe('<script>alert(1)</script> $(rm -rf /) .*+?^${}()|[]\\');
  });
});

describe('parseStoredFilters (data read back from storage is untrusted)', () => {
  it('keeps valid filters and their enabled flag, discards malformed entries', () => {
    const good: CustomFilter = { id: 'a', phrase: 'Word', normalizedPhrase: 'word', matchMode: 'exact', enabled: false, createdAt: '2026' };
    const parsed = parseStoredFilters([good, null, 5, { id: 1 }, { id: 'b', phrase: 'x', matchMode: 'nope', createdAt: 'z' }, { id: 'c', phrase: '   ', matchMode: 'exact', createdAt: 'z' }, good]);
    expect(parsed).toEqual([good]);
  });
  it('rejects non-arrays and re-derives the normalised form instead of trusting it', () => {
    expect(parseStoredFilters('x')).toEqual([]);
    expect(parseStoredFilters({})).toEqual([]);
    const parsed = parseStoredFilters([{ id: 'a', phrase: 'Hello', normalizedPhrase: 'EVIL', matchMode: 'phrase', enabled: true, createdAt: 'z' }]);
    expect(parsed[0]!.normalizedPhrase).toBe('hello');
  });
});

describe('updateCustomFilter', () => {
  const make = (phrase: string, mode: 'word-boundary' | 'phrase' | 'exact', n: number, enabled = true): CustomFilter => {
    const r = createCustomFilter(phrase, mode, [], env(n));
    if (!r.ok) throw new Error(r.reason);
    return { ...r.filter, enabled };
  };
  it('changes phrase and mode with the creation rules, keeping id, enabled flag and creation time', () => {
    const list = [make('colour', 'word-boundary', 1, false), make('other', 'phrase', 2)];
    const r = updateCustomFilter(list, 'f1', '  Color ', 'exact');
    expect(r).toEqual({ ok: true, filter: { id: 'f1', phrase: 'Color', normalizedPhrase: 'color', matchMode: 'exact', enabled: false, createdAt: '2026-01-01T00:00:00.000Z' } });
  });
  it('rejects what creation rejects: empty, no words, too long', () => {
    const list = [make('alpha', 'phrase', 1)];
    expect(updateCustomFilter(list, 'f1', '   ', 'phrase')).toEqual({ ok: false, reason: 'empty' });
    expect(updateCustomFilter(list, 'f1', '!!!', 'phrase')).toEqual({ ok: false, reason: 'no-words' });
    expect(updateCustomFilter(list, 'f1', 'a'.repeat(MAX_PHRASE_LENGTH + 1), 'phrase')).toEqual({ ok: false, reason: 'too-long' });
  });
  it('detects a duplicate of ANOTHER filter, but not of itself', () => {
    const list = [make('alpha', 'phrase', 1), make('beta', 'phrase', 2)];
    expect(updateCustomFilter(list, 'f2', 'ALPHA', 'phrase')).toEqual({ ok: false, reason: 'duplicate' });
    expect(updateCustomFilter(list, 'f2', 'beta', 'phrase').ok).toBe(true);
    expect(updateCustomFilter(list, 'f2', 'alpha', 'exact').ok).toBe(true); // another mode is allowed
  });
  it('reports an unknown id and never mutates the list', () => {
    const list = [make('alpha', 'phrase', 1)];
    const before = JSON.stringify(list);
    expect(updateCustomFilter(list, 'nope', 'x', 'phrase')).toEqual({ ok: false, reason: 'not-found' });
    updateCustomFilter(list, 'f1', 'changed', 'phrase');
    expect(JSON.stringify(list)).toBe(before);
  });
});
