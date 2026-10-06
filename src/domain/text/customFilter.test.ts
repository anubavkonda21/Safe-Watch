import { MAX_FILTERS, MAX_PHRASE_LENGTH, createCustomFilter, parseStoredFilters, type CustomFilter } from './customFilter';

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
