import { PENDING_METADATA, type MediaAsset } from '@/domain/media/asset';
import { InvalidTransitionError, createUploadedRecord, markFailed, markProcessing, markReady, toResource } from '../src/domain/mediaRecord';

const asset: MediaAsset = {
  id: 'a', filename: 'x.mp4', mimeType: 'video/mp4', container: 'mp4', typeLabel: 'MP4 video', sizeBytes: 1,
  status: 'accepted', metadata: PENDING_METADATA, createdAt: '2026-01-01T00:00:00.000Z', failure: null,
};
const meta = { ...PENDING_METADATA, availability: 'available' as const, source: 'ffprobe' as const, durationSeconds: 3 };

describe('server media record', () => {
  it('starts uploaded with analysis NOT started and an expiry', () => {
    const r = createUploadedRecord(asset, 1000, 500);
    expect(r.asset.status).toBe('uploaded');
    expect(r.analysis).toEqual({ status: 'not_started' });
    expect(r.expiresAt).toBe(1500);
  });
  it('uploaded → processing → ready keeps media and analysis status separate', () => {
    const r = markReady(markProcessing(createUploadedRecord(asset, 0, 1)), meta);
    expect(r.asset).toMatchObject({ status: 'ready', metadata: { durationSeconds: 3 } });
    expect(toResource(r)).toEqual({ asset: r.asset, analysis: { status: 'not_started' } });
  });
  it('processing → failed records the typed failure', () => {
    const r = markFailed(markProcessing(createUploadedRecord(asset, 0, 1)), 'timeout');
    expect(r.asset).toMatchObject({ status: 'failed', failure: { code: 'timeout' } });
  });
  it('uploaded → failed is allowed', () => {
    expect(markFailed(createUploadedRecord(asset, 0, 1), 'storage-failure').asset.status).toBe('failed');
  });
  it.each([
    ['uploaded → ready', (r: ReturnType<typeof createUploadedRecord>) => markReady(r, meta)],
    ['ready → processing', (r: ReturnType<typeof createUploadedRecord>) => markProcessing(markReady(markProcessing(r), meta))],
    ['failed → ready', (r: ReturnType<typeof createUploadedRecord>) => markReady(markFailed(r, 'timeout'), meta)],
    ['ready → failed', (r: ReturnType<typeof createUploadedRecord>) => markFailed(markReady(markProcessing(r), meta), 'timeout')],
  ])('rejects illegal transition %s', (_n, fn) => {
    expect(() => fn(createUploadedRecord(asset, 0, 1))).toThrow(InvalidTransitionError);
  });
});
