import { buildDecodeCheckArgs, buildFfprobeArgs, parseFrameRate, summarizeProbe, summaryToMetadata } from '../src/infrastructure/ffmpeg/ffprobe';

const typical = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001' },
    { codec_type: 'audio', codec_name: 'aac' },
    { codec_type: 'subtitle', codec_name: 'subrip' },
  ],
  format: { duration: '125.5' },
};

describe('summarizeProbe / summaryToMetadata', () => {
  it('normalises a typical probe into SafeWatch metadata', () => {
    const m = summaryToMetadata(summarizeProbe(typical)!)!;
    expect(m).toMatchObject({
      availability: 'available', source: 'ffprobe', durationSeconds: 125.5, width: 1920, height: 1080,
      frameRate: 29.97, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, hasSubtitles: true,
    });
  });
  it('reports hasAudio false (not null) when there is no audio stream', () => {
    const m = summaryToMetadata(summarizeProbe({ streams: [typical.streams[0]], format: { duration: '1' } })!)!;
    expect(m).toMatchObject({ hasAudio: false, audioCodec: null, hasSubtitles: false });
  });
  it('ignores embedded cover art when picking the video stream', () => {
    const json = { streams: [{ codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }, typical.streams[0]], format: { duration: '3' } };
    expect(summarizeProbe(json)!.video).toMatchObject({ codec: 'h264', width: 1920 });
  });
  it('has no video for audio-only files', () => {
    const s = summarizeProbe({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: { duration: '3' } })!;
    expect(s.video).toBeNull();
    expect(summaryToMetadata(s)).toBeNull();
  });
  it('falls back to stream duration and yields partial metadata without a duration', () => {
    expect(summarizeProbe({ streams: [{ codec_type: 'video', width: 2, height: 2, duration: '4' }], format: {} })!.durationSeconds).toBe(4);
    const m = summaryToMetadata(summarizeProbe({ streams: [{ codec_type: 'video', codec_name: 'vp8', width: 640, height: 360 }], format: {} })!)!;
    expect(m).toMatchObject({ availability: 'partial', durationSeconds: null, width: 640 });
  });
  it('treats zero/garbage dimensions as unavailable', () => {
    const m = summaryToMetadata(summarizeProbe({ streams: [{ codec_type: 'video', width: 0, height: 0 }], format: { duration: 'N/A' } })!)!;
    expect(m.availability).toBe('unavailable');
  });
  it.each([null, undefined, 'x', 42, [], {}, { streams: 'no' }])('returns null for unusable shape %j', (v) => {
    expect(summarizeProbe(v)).toBeNull();
  });
  it('parses frame rates defensively', () => {
    expect(parseFrameRate('25/1')).toBe(25);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate('abc')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });
});

describe('command construction', () => {
  const hostile = '/tmp/$(rm -rf ~);`id`|&.media';
  it('passes the path as a single argv element after -i, never merged into other args', () => {
    const args = buildFfprobeArgs(hostile, 'mp4');
    expect(args[args.indexOf('-i') + 1]).toBe(hostile);
    expect(args.filter((a) => a.includes(hostile))).toHaveLength(1);
  });
  it('restricts protocols and forces the demuxer matching the verified container', () => {
    for (const build of [buildFfprobeArgs, buildDecodeCheckArgs]) {
      const args = build('/x.media', 'webm');
      expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file']);
      expect(args[args.indexOf('-f') + 1]).toBe('matroska');
    }
  });
  it('bounds the decode check', () => {
    const args = buildDecodeCheckArgs('/x.media', 'mp4');
    expect(args).toEqual(expect.arrayContaining(['-nostdin', '-t', '2', '-threads', '1']));
  });
});
