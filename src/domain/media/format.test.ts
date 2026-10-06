import { formatBytes, formatDuration, formatElapsed, formatTimecode } from './format';

describe('formatTimecode (media time for transcripts)', () => {
  it('formats m:ss.cc and h:mm:ss.cc', () => {
    expect(formatTimecode(0)).toBe('0:00.00');
    expect(formatTimecode(1.5)).toBe('0:01.50');
    expect(formatTimecode(62.034)).toBe('1:02.03');
    expect(formatTimecode(3600)).toBe('1:00:00.00');
    expect(formatTimecode(3725.999)).toBe('1:02:06.00');
  });
  it('clamps negatives to zero', () => expect(formatTimecode(-3)).toBe('0:00.00'));
});

describe('other formatters', () => {
  it('format bytes, durations and elapsed time', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatElapsed(85)).toBe('85 ms');
    expect(formatElapsed(1234)).toBe('1.2 s');
    expect(formatElapsed(125_000)).toBe('2 min 5 s');
  });
});
