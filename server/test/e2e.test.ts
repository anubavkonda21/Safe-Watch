import type { MediaResponse } from '@/domain/api/contract';
import { FfmpegMediaProcessor } from '../src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { fixture, hasFfmpeg, startTestApp, upload, waitForStatus, type TestApp } from './helpers';

let app: TestApp;
afterEach(async () => { await app?.close(); });

// Genuine end-to-end flow: HTTP upload → temporary disk storage → real FFprobe/FFmpeg → MediaAsset → delete.
describe.skipIf(!hasFfmpeg)('end-to-end: upload → storage → FFprobe → MediaAsset → cleanup', () => {
  const real = () => new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });

  it('processes a real MP4', async () => {
    app = await startTestApp({ processor: real() });
    const res = await upload(app, new Uint8Array(fixture('sample.mp4')), 'holiday ../clip.mp4');
    expect(res.status).toBe(202);
    const { media } = (await res.json()) as MediaResponse;
    expect(await app.files()).toEqual([`${media.asset.id}.media`]);

    const ready = await waitForStatus(app, media.asset.id, ['ready']);
    expect(ready.asset).toMatchObject({
      filename: 'clip.mp4', container: 'mp4', mimeType: 'video/mp4', status: 'ready',
      metadata: { availability: 'available', source: 'ffprobe', width: 160, height: 120, frameRate: 25, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, hasSubtitles: false },
    });
    expect(ready.analysis).toEqual({ status: 'not_started' });

    expect((await fetch(`${app.url}/api/media/${media.asset.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await app.files()).toEqual([]);
  });

  it('processes an MKV with embedded subtitles', async () => {
    app = await startTestApp({ processor: real() });
    const { media } = (await (await upload(app, new Uint8Array(fixture('sample-subs.mkv')), 'film.mkv', '')).json()) as MediaResponse;
    const ready = await waitForStatus(app, media.asset.id, ['ready']);
    expect(ready.asset).toMatchObject({ container: 'matroska', metadata: { hasSubtitles: true, hasAudio: true } });
  });

  it('fails truncated media cleanly and removes it from disk', async () => {
    app = await startTestApp({ processor: real() });
    const { media } = (await (await upload(app, new Uint8Array(fixture('truncated.mp4')), 'cut.mp4')).json()) as MediaResponse;
    const failed = await waitForStatus(app, media.asset.id, ['failed']);
    expect(failed.asset.failure?.code).toBe('invalid-media');
    expect(await app.files()).toEqual([]);
  });
});
