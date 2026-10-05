import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaIngestionError } from '@/domain/media/errors';
import { FfmpegMediaProcessor } from '../src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { hasFfmpeg } from './helpers';

const fx = (n: string) => join(fileURLToPath(new URL('./fixtures/', import.meta.url)), n);
const processor = new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });

// Integration tests against the real binaries. Skipped (and reported as skipped) when FFmpeg is not installed.
describe.skipIf(!hasFfmpeg)('FfmpegMediaProcessor (real FFprobe/FFmpeg)', () => {
  it('extracts normalised metadata from an MP4 with audio', async () => {
    const m = await processor.extractMetadata({ path: fx('sample.mp4'), container: 'mp4' });
    expect(m).toMatchObject({
      availability: 'available', source: 'ffprobe', width: 160, height: 120, frameRate: 25,
      videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, hasSubtitles: false,
    });
    expect(m.durationSeconds).toBeCloseTo(1, 1);
  });
  it('detects embedded subtitles in MKV', async () => {
    const m = await processor.extractMetadata({ path: fx('sample-subs.mkv'), container: 'matroska' });
    expect(m).toMatchObject({ hasSubtitles: true, hasAudio: true, videoCodec: 'h264' });
  });
  it('reports a silent WebM as hasAudio=false', async () => {
    const m = await processor.extractMetadata({ path: fx('sample-silent.webm'), container: 'webm' });
    expect(m).toMatchObject({ hasAudio: false, audioCodec: null, videoCodec: 'vp8' });
  });
  it('rejects a truncated file as invalid media', async () => {
    await expect(processor.extractMetadata({ path: fx('truncated.mp4'), container: 'mp4' })).rejects.toMatchObject({ name: 'MediaIngestionError', code: 'invalid-media' });
  });
  it('rejects random bytes behind a valid MP4 header', async () => {
    await expect(processor.extractMetadata({ path: fx('garbage-with-mp4-header.mp4'), container: 'mp4' })).rejects.toMatchObject({ code: 'invalid-media' });
  });
  it('rejects media whose real format differs from the verified container (unsupported structure)', async () => {
    await expect(processor.extractMetadata({ path: fx('sample.mp4'), container: 'avi' })).rejects.toMatchObject({ code: 'invalid-media' });
  });
  it('rejects a missing file', async () => {
    await expect(processor.extractMetadata({ path: fx('does-not-exist.mp4'), container: 'mp4' })).rejects.toBeInstanceOf(MediaIngestionError);
  });
  it('verifies decodability of good media and rejects bad media', async () => {
    await expect(processor.verifyDecodable({ path: fx('sample.mp4'), container: 'mp4' })).resolves.toBeUndefined();
    await expect(processor.verifyDecodable({ path: fx('garbage-with-mp4-header.mp4'), container: 'mp4' })).rejects.toMatchObject({ code: 'invalid-media' });
  });
  it('can be aborted', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(processor.extractMetadata({ path: fx('sample.mp4'), container: 'mp4' }, { signal: ac.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });
  it('maps a missing FFprobe binary to processing-failed', async () => {
    const broken = new FfmpegMediaProcessor({ ffmpegPath: '/no/ffmpeg', ffprobePath: '/no/ffprobe' });
    await expect(broken.extractMetadata({ path: fx('sample.mp4'), container: 'mp4' })).rejects.toMatchObject({ code: 'processing-failed' });
  });
  it('does not follow a playlist disguised as media', async () => {
    // A text file claiming to be an HLS/concat playlist must not be demuxed: the demuxer is forced from the verified container.
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'sw-pl-'));
    const p = join(dir, 'evil.media');
    await writeFile(p, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nfile:///etc/hosts\n#EXT-X-ENDLIST\n');
    await expect(processor.extractMetadata({ path: p, container: 'mp4' })).rejects.toMatchObject({ code: 'invalid-media' });
    await rm(dir, { recursive: true, force: true });
  });
  it('reports tool availability', async () => {
    expect(await FfmpegMediaProcessor.checkTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' })).toEqual({ ffmpeg: true, ffprobe: true });
    expect(await FfmpegMediaProcessor.checkTools({ ffmpegPath: '/no/ffmpeg', ffprobePath: 'ffprobe' })).toEqual({ ffmpeg: false, ffprobe: true });
  });
});
