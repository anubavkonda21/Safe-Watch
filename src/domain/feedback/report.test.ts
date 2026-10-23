import { MAX_REPORTS, MAX_REPORT_NOTE, MAX_REPORT_PHRASE, createReport, formatTimestamp, parseStoredReports, parseTimestamp, type ReportContext, type ReportInput } from './report';

const ctx = (over: Partial<ReportContext> = {}): ReportContext => ({ session: 's1', durationMs: 60_000, existingCount: 0, id: 'r1', now: '2026-01-01T00:00:00.000Z', ...over });
const input = (over: Partial<ReportInput> = {}): ReportInput => ({ timestamp: '0:12.5', phrase: 'quick brown fox', category: 'heard', note: '', ...over });

describe('parseTimestamp', () => {
  it.each([['90', 90_000], ['90.5', 90_500], ['1:30', 90_000], ['1:30.5', 90_500], ['0:00', 0], ['01:02:03', 3_723_000], ['  12.25  ', 12_250], ['0.001', 1]])('%s → %i ms', (text, ms) => { expect(parseTimestamp(text)).toBe(ms); });
  // Strictness over cleverness: the last two are a too-long number and a number that overflows safe integers.
  it.each(['', '  ', 'abc', '-5', '1:60', '1:2:3:4', '1.5:30', '1:30:', ':30', '12,5', '1e3', 'Infinity', 'NaN', '0x10', '9'.repeat(30), '99999999999999999'])('rejects %j', (text) => { expect(parseTimestamp(text)).toBeNull(); });
  it('round-trips what formatTimestamp produces', () => {
    for (const ms of [0, 100, 12_500, 59_900, 60_000, 3_723_400]) expect(parseTimestamp(formatTimestamp(ms))).toBe(ms);
  });
});

describe('createReport', () => {
  it('builds a valid report with integer milliseconds and the session, and no file information', () => {
    const r = createReport(input(), ctx());
    expect(r).toEqual({ ok: true, report: { id: 'r1', session: 's1', timestampMs: 12_500, durationMs: 60_000, phrase: 'quick brown fox', category: 'heard', note: '', createdAt: '2026-01-01T00:00:00.000Z' } });
    expect(Object.keys((r as { report: object }).report).sort()).toEqual(['category', 'createdAt', 'durationMs', 'id', 'note', 'phrase', 'session', 'timestampMs']);
  });
  it.each([
    ['empty phrase', { phrase: '   ' }, 'empty-phrase'],
    ['a phrase of control characters', { phrase: '​\u0000' }, 'empty-phrase'],
    ['punctuation only', { phrase: '!!! ???' }, 'no-words'],
    ['a phrase that is too long', { phrase: 'a'.repeat(MAX_REPORT_PHRASE + 1) }, 'phrase-too-long'],
    ['a note that is too long', { note: 'n'.repeat(MAX_REPORT_NOTE + 1) }, 'note-too-long'],
    ['an empty time', { timestamp: '' }, 'invalid-timestamp'],
    ['a negative time', { timestamp: '-1' }, 'invalid-timestamp'],
    ['a time that is text', { timestamp: 'soon' }, 'invalid-timestamp'],
    ['a time past the end of the video', { timestamp: '1:00.1' }, 'outside-media'],
    ['an unknown category', { category: 'violence' }, 'invalid-category'],
  ])('rejects %s', (_n, over, reason) => { expect(createReport(input(over), ctx())).toEqual({ ok: false, reason }); });
  it('accepts a time exactly at the end, and any non-negative time when the length is not known', () => {
    expect(createReport(input({ timestamp: '1:00' }), ctx()).ok).toBe(true);
    expect(createReport(input({ timestamp: '99:00' }), ctx({ durationMs: null })).ok).toBe(true);
  });
  it('stops at the limit instead of growing without bound', () => {
    expect(createReport(input(), ctx({ existingCount: MAX_REPORTS }))).toEqual({ ok: false, reason: 'limit-reached' });
  });
  it('keeps hostile text as plain text and cleans invisible characters', () => {
    const r = createReport(input({ phrase: '<img src=x onerror=alert(1)>​ hello', note: '<script>x</script>' }), ctx());
    expect(r.ok && r.report.phrase).toBe('<img src=x onerror=alert(1)> hello');
    expect(r.ok && r.report.note).toBe('<script>x</script>');
  });
  it('does not mutate its input', () => {
    const i = input(); const c = ctx();
    const before = JSON.stringify([i, c]);
    createReport(i, c);
    expect(JSON.stringify([i, c])).toBe(before);
  });
});

describe('parseStoredReports (untrusted)', () => {
  const good = { id: 'a', session: 's', timestampMs: 1000, durationMs: 60_000, phrase: 'hello', category: 'heard', note: '', createdAt: 'x' };
  it('keeps valid reports and drops every malformed one', () => {
    const stored = [good, null, 'x', {}, { ...good, id: 7 }, { ...good, id: 'b', timestampMs: -1 }, { ...good, id: 'c', timestampMs: 1.5 }, { ...good, id: 'd', category: 'violence' }, { ...good, id: 'e', phrase: '   ' }, { ...good, id: 'f', durationMs: -5 }, { ...good, id: 'g', note: 'n'.repeat(500) }, { ...good, id: 'a' }, { ...good, id: 'h', durationMs: null }];
    expect(parseStoredReports(stored).map((r) => r.id)).toEqual(['a', 'h']);
  });
  it.each([null, undefined, 5, 'x', {}, true])('returns nothing for %j', (raw) => { expect(parseStoredReports(raw)).toEqual([]); });
  it('caps the number it reads', () => {
    const many = Array.from({ length: MAX_REPORTS + 50 }, (_, i) => ({ ...good, id: `id-${i}` }));
    expect(parseStoredReports(many)).toHaveLength(MAX_REPORTS);
  });
  it('drops unknown fields', () => {
    expect(Object.keys(parseStoredReports([{ ...good, path: '/Users/x/video.mp4', filename: 'secret.mp4' }])[0]!).sort()).toEqual(['category', 'createdAt', 'durationMs', 'id', 'note', 'phrase', 'session', 'timestampMs']);
  });
});
