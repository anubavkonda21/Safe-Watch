import type { MediaAsset } from './asset';
import { PENDING_METADATA } from './asset';
import { MediaIngestionError } from './errors';
import { initialIngestionState, ingestionReducer, isBusy, type IngestionEvent, type IngestionState } from './ingestion';

const asset: MediaAsset = {
  id: 'a1', filename: 'clip.mp4', mimeType: 'video/mp4', container: 'mp4', typeLabel: 'MP4 video',
  sizeBytes: 10, status: 'accepted', metadata: PENDING_METADATA, createdAt: '2026-01-01T00:00:00.000Z', failure: null,
};

const run = (events: IngestionEvent[], from: IngestionState = initialIngestionState) => events.reduce(ingestionReducer, from);

describe('ingestionReducer', () => {
  it('idle → validating', () => {
    expect(run([{ type: 'select', fileName: 'x.mp4' }])).toEqual({ status: 'validating', fileName: 'x.mp4' });
  });
  it('validating → accepted (asset status accepted)', () => {
    const s = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset: { ...asset, status: 'failed' } }]);
    expect(s).toMatchObject({ status: 'accepted', asset: { status: 'accepted' } });
  });
  it('validating → failed with a typed code', () => {
    const s = run([{ type: 'select', fileName: 'x' }, { type: 'fail', error: new MediaIngestionError('file-too-large') }]);
    expect(s).toEqual({ status: 'failed', failure: { code: 'file-too-large' } });
  });
  it('accepted → processing', () => {
    const s = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process' }]);
    expect(s).toMatchObject({ status: 'processing', asset: { status: 'processing' } });
  });
  it('processing → ready with the prepared asset', () => {
    const prepared = { ...asset, metadata: { ...PENDING_METADATA, availability: 'available' as const } };
    const s = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process' }, { type: 'ready', asset: prepared }]);
    expect(s).toMatchObject({ status: 'ready', asset: { status: 'ready', metadata: { availability: 'available' } } });
  });
  it('tracks real upload progress, never moves backwards, and switches to inspecting at 100%', () => {
    const base = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process', phase: 'uploading' }]);
    expect(base).toMatchObject({ phase: 'uploading', uploadFraction: 0 });
    const half = run([{ type: 'progress', fraction: 0.5 }], base);
    expect(half).toMatchObject({ phase: 'uploading', uploadFraction: 0.5 });
    expect(run([{ type: 'progress', fraction: 0.2 }], half)).toMatchObject({ uploadFraction: 0.5 });
    expect(run([{ type: 'progress', fraction: 7 }], half)).toMatchObject({ phase: 'inspecting', uploadFraction: 1 });
    expect(run([{ type: 'progress', fraction: -3 }], base)).toMatchObject({ uploadFraction: 0 });
  });
  it('ignores progress outside the uploading phase', () => {
    const inspecting = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process' }]);
    expect(inspecting).toMatchObject({ phase: 'inspecting', uploadFraction: null });
    expect(run([{ type: 'progress', fraction: 0.5 }], inspecting)).toBe(inspecting);
    expect(run([{ type: 'progress', fraction: 0.5 }])).toBe(initialIngestionState);
  });
  it('ready carries analysis status separately: NOT started by default', () => {
    const s = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process' }, { type: 'ready', asset }]);
    expect(s).toMatchObject({ status: 'ready', analysis: 'not_started', asset: { status: 'ready' } });
  });
  it('processing → failed; unknown errors become processing-failed', () => {
    const s = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process' }, { type: 'fail', error: new Error('boom: /internal/path') }]);
    expect(s).toEqual({ status: 'failed', failure: { code: 'processing-failed' } });
  });
  it('allows a new selection after ready or failed, but not while busy', () => {
    const ready = run([{ type: 'select', fileName: 'x' }, { type: 'accepted', asset }, { type: 'process' }, { type: 'ready', asset }]);
    expect(run([{ type: 'select', fileName: 'y' }], ready).status).toBe('validating');
    const validating = run([{ type: 'select', fileName: 'x' }]);
    expect(run([{ type: 'select', fileName: 'y' }], validating)).toBe(validating);
  });
  it('ignores illegal transitions', () => {
    expect(run([{ type: 'process' }])).toBe(initialIngestionState);
    expect(run([{ type: 'accepted', asset }])).toBe(initialIngestionState);
    expect(run([{ type: 'ready', asset }])).toBe(initialIngestionState);
    expect(run([{ type: 'fail', error: new Error('x') }])).toBe(initialIngestionState);
  });
  it('reset returns to idle unless busy', () => {
    const failed = run([{ type: 'select', fileName: 'x' }, { type: 'fail', error: new Error() }]);
    expect(run([{ type: 'reset' }], failed)).toBe(initialIngestionState);
    const busy = run([{ type: 'select', fileName: 'x' }]);
    expect(run([{ type: 'reset' }], busy)).toBe(busy);
    expect(isBusy(busy)).toBe(true);
  });
});
