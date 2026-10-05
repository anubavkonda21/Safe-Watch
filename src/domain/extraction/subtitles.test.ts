import { classifySubtitleCodec, normalizeCueText, normalizeCues, normalizeLanguage, parseSrt, parseTimestamp, sanitizeMetadataText } from './subtitles';

describe('classifySubtitleCodec', () => {
  it.each(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'srt'])('%s is text', (c) => expect(classifySubtitleCodec(c)).toBe('text'));
  it.each(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])('%s is image', (c) => expect(classifySubtitleCodec(c)).toBe('image'));
  it('never assumes unknown codecs are text', () => {
    expect(classifySubtitleCodec('eia_608')).toBe('unknown');
    expect(classifySubtitleCodec('some_future_codec')).toBe('unknown');
    expect(classifySubtitleCodec(null)).toBe('unknown');
  });
});

describe('normalizeCueText', () => {
  it('strips formatting markup but keeps the words', () => {
    expect(normalizeCueText('hello <i>world</i> <b>now</b> <font color="#fff">x</font>')).toBe('hello world now x');
  });
  it('strips ASS override tags and converts literal \\N to a line break', () => {
    expect(normalizeCueText('{\\an8}{\\i1}Hola{\\i0}\\Nmundo')).toBe('Hola\nmundo');
  });
  it('keeps non-formatting angle-bracket text', () => {
    expect(normalizeCueText('<laughs> and 1 < 2 and <3')).toBe('<laughs> and 1 < 2 and <3');
  });
  it('decodes the basic entities only', () => {
    expect(normalizeCueText('Tom &amp; Jerry &lt;3 &quot;hi&quot;&nbsp;there')).toBe('Tom & Jerry <3 "hi" there');
    expect(normalizeCueText('&unknown; &#65;')).toBe('&unknown; &#65;');
  });
  it('handles line breaks, blank lines and spacing', () => {
    expect(normalizeCueText('  line   one \r\n\r\n  line two\t\n   ')).toBe('line one\nline two');
  });
  it('removes control, zero-width and bidi-override characters', () => {
    expect(normalizeCueText('a\u0000b‮c​d⁦e\u0007')).toBe('abcde');
  });
  it('does not execute or interpret HTML: script text stays inert plain text', () => {
    const out = normalizeCueText('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(out).toBe('<script>alert(1)</script><img src=x onerror=alert(1)>'); // not a formatting tag: preserved verbatim as text
  });
  it('caps very long text', () => {
    expect(normalizeCueText('x'.repeat(10_000))).toHaveLength(4000);
  });
  it('is idempotent', () => {
    const once = normalizeCueText('<i>Hello</i>\\Nthere &amp; you');
    expect(normalizeCueText(once)).toBe(once);
  });
});

describe('normalizeCues', () => {
  it('drops empty cues, invalid timing and exact duplicates, preserving timing exactly', () => {
    const cues = normalizeCues([
      { startSeconds: 2, endSeconds: 3, text: 'two' },
      { startSeconds: 0.2, endSeconds: 1.1, text: '<i>one</i>' },
      { startSeconds: 0.2, endSeconds: 1.1, text: 'one' }, // duplicate after normalisation
      { startSeconds: 4, endSeconds: 5, text: '   ' },
      { startSeconds: 6, endSeconds: 5, text: 'backwards' },
      { startSeconds: -1, endSeconds: 1, text: 'negative' },
      { startSeconds: NaN, endSeconds: 1, text: 'nan' },
    ]);
    expect(cues).toEqual([
      { index: 0, startSeconds: 0.2, endSeconds: 1.1, text: 'one' },
      { index: 1, startSeconds: 2, endSeconds: 3, text: 'two' },
    ]);
  });
  it('keeps distinct cues that share a start time, in input order', () => {
    const cues = normalizeCues([{ startSeconds: 1, endSeconds: 2, text: 'a' }, { startSeconds: 1, endSeconds: 2, text: 'b' }]);
    expect(cues.map((c) => c.text)).toEqual(['a', 'b']);
  });
});

describe('parseSrt', () => {
  it('parses cues with multi-line text and millisecond timing', () => {
    const srt = '1\n00:00:00,200 --> 00:00:01,100\nHola\nmundo\n\n2\n00:01:02,003 --> 01:00:00,000\nUltimo\n';
    expect(parseSrt(srt)).toEqual([
      { startSeconds: 0.2, endSeconds: 1.1, text: 'Hola\nmundo' },
      { startSeconds: 62.003, endSeconds: 3600, text: 'Ultimo' },
    ]);
  });
  it('is tolerant: skips junk blocks, handles CRLF, BOM and a missing index', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nok\r\n\r\ngarbage block\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nno index\r\n';
    expect(parseSrt(srt).map((c) => c.text)).toEqual(['ok', 'no index']);
  });
  it('rejects impossible timestamps', () => {
    expect(parseTimestamp('00:61:00,000')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('00:00:01.5')).toBe(1.5);
  });
});

describe('metadata text', () => {
  it('normalises languages', () => {
    expect(normalizeLanguage('ENG')).toBe('eng');
    expect(normalizeLanguage('und')).toBeNull();
    expect(normalizeLanguage('pt-BR')).toBe('pt-br');
    expect(normalizeLanguage('<script>')).toBeNull();
    expect(normalizeLanguage(5)).toBeNull();
  });
  it('sanitises titles as plain text', () => {
    expect(sanitizeMetadataText('  Commentary‮  track ')).toBe('Commentary track');
    expect(sanitizeMetadataText('')).toBeNull();
    expect(sanitizeMetadataText(undefined)).toBeNull();
    expect(sanitizeMetadataText('x'.repeat(500))).toHaveLength(200);
  });
});
