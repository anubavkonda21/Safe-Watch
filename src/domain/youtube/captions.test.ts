import { MAX_CAPTION_CHARS, MAX_CAPTION_CUES, parseCaptionFile, parseWebVtt } from './captions';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello <i>there</i>, this is a test.

2
00:00:05,000 --> 00:00:06,250
Second &amp; last line
`;

const VTT = `WEBVTT - a title

NOTE this is a comment
and it continues

STYLE
::cue { color: red }

intro
00:01.000 --> 00:03.500 align:start position:0%
Hello <c.yellow>there</c>, this is a test.

00:00:05.000 --> 00:00:06.250
Second &amp; last line
`;

describe('parseCaptionFile', () => {
  it('reads SubRip, cleaning markup and entities', () => {
    const r = parseCaptionFile(SRT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe('srt');
    expect(r.cues.map((c) => [c.startSeconds, c.endSeconds, c.text])).toEqual([[1, 3.5, 'Hello there, this is a test.'], [5, 6.25, 'Second & last line']]);
    expect(r.firstStartSeconds).toBe(1);
    expect(r.lastEndSeconds).toBe(6.25);
  });

  it('reads WebVTT: optional hours, identifiers, settings, comments, style blocks and tags', () => {
    const r = parseCaptionFile(VTT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.format).toBe('vtt');
    expect(r.cues.map((c) => [c.startSeconds, c.endSeconds, c.text])).toEqual([[1, 3.5, 'Hello there, this is a test.'], [5, 6.25, 'Second & last line']]);
  });

  it('keeps the exact times it was given (no shifting or rounding beyond milliseconds)', () => {
    const r = parseCaptionFile('1\n00:10:00,123 --> 00:10:01,007\nx y\n');
    expect(r.ok && r.cues[0]).toMatchObject({ startSeconds: 600.123, endSeconds: 601.007 });
  });

  it('handles CRLF and a byte-order mark', () => {
    const r = parseCaptionFile(`\uFEFF${SRT.replace(/\n/g, '\r\n')}`);
    expect(r.ok && r.cues.length).toBe(2);
  });

  it('drops invalid cues and says how many (end before start, bad timestamps, empty text)', () => {
    const r = parseCaptionFile('1\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n2\n00:00:01,000 --> 00:00:02,000\n\n\n3\n00:00:07,000 --> 00:00:08,000\nkept\n\n4\n99:99:99,999 --> 00:00:09,000\nbad time\n');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.cues.map((c) => c.text)).toEqual(['kept']); expect(r.dropped).toBe(2); }
  });

  it.each([
    ['empty', '', 'empty'], ['spaces', '  \n ', 'empty'], ['not a caption file', 'just some text', 'unrecognized'],
    ['html', '<html><body>--x</body></html>', 'unrecognized'], ['a timing line but no usable cue', '1\n00:00:01,000 --> 00:00:02,000\n\n', 'no-cues'],
    ['webvtt header only', 'WEBVTT\n', 'no-cues'],
  ] as const)('refuses %s', (_n, text, reason) => {
    expect(parseCaptionFile(text)).toEqual({ ok: false, reason });
  });

  it('refuses oversized files and files with too many cues, without reading them in full', () => {
    expect(parseCaptionFile('x'.repeat(MAX_CAPTION_CHARS + 1))).toEqual({ ok: false, reason: 'too-large' });
    const many = Array.from({ length: MAX_CAPTION_CUES + 1 }, (_, i) => `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:${String(i % 60).padStart(2, '0')}.500\nw${i}`).join('\n\n');
    expect(parseCaptionFile(`WEBVTT\n\n${many}`)).toEqual({ ok: false, reason: 'too-many-cues' });
  });

  it('keeps hostile cue text as inert plain text and removes control and bidi-override characters', () => {
    const r = parseCaptionFile('1\n00:00:01,000 --> 00:00:02,000\n<img src=x onerror=alert(1)>hi\u202e\u0000\n');
    expect(r.ok).toBe(true);
    // The text is only ever rendered as text (React escapes it); it is matched against phrases, never parsed as HTML.
    if (r.ok) { expect(r.cues[0]!.text).toContain('hi'); expect(r.cues[0]!.text).not.toContain('\u202e'); expect(r.cues[0]!.text).not.toContain('\u0000'); }
  });

  it('parseWebVtt skips header, NOTE, STYLE and REGION blocks', () => {
    expect(parseWebVtt('WEBVTT\n\nREGION\nid:a\n\nNOTE x\n\n00:01.000 --> 00:02.000\nok\n')).toHaveLength(1);
  });
});
