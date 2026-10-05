import { createExtraction, type MediaExtraction, type SubtitleTrack, type AudioAsset } from '@/domain/extraction/extraction';

const disposition = { default: false, forced: false, original: false, hearingImpaired: false, commentary: false };

export const audioAsset = (over: Partial<AudioAsset> = {}): AudioAsset => ({
  id: 'aud-0', ordinal: 0, streamIndex: 1, language: 'eng', title: null, disposition,
  source: { codec: 'aac', sampleRate: 44100, channels: 2, bitRate: 128000 }, format: { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 },
  durationSeconds: 65, sizeBytes: 2_080_000, artifact: 'audio/aud-0.wav', duplicateOf: null, ...over,
});

export const subtitleTrack = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  id: 'sub-0', ordinal: 0, streamIndex: 3, language: 'spa', title: null, codec: 'subrip', kind: 'text', textExtraction: 'extracted', disposition,
  cueCount: 2, cues: [{ index: 0, startSeconds: 1, endSeconds: 2, text: 'hola' }, { index: 1, startSeconds: 3, endSeconds: 4, text: 'adios' }], ...over,
});

export const completedExtraction = (mediaId: string, over: Partial<MediaExtraction> = {}): MediaExtraction => ({
  ...createExtraction(mediaId, '2026-01-01T00:00:00.000Z'),
  status: 'completed', completedAt: '2026-01-01T00:00:01.000Z', startedAt: '2026-01-01T00:00:00.000Z',
  audio: [audioAsset()], subtitles: [subtitleTrack()],
  frames: { config: { intervalSeconds: 10, maxFrames: 300, maxWidth: 768, maxHeight: 768 }, effectiveIntervalSeconds: 10, totalSizeBytes: 12_000, frames: [
    { id: 'frm-00000', index: 0, timestampSeconds: 5, width: 768, height: 432, format: 'jpeg', sizeBytes: 6000, artifact: 'frames/frm-00000.jpg' },
    { id: 'frm-00001', index: 1, timestampSeconds: 15, width: 768, height: 432, format: 'jpeg', sizeBytes: 6000, artifact: 'frames/frm-00001.jpg' },
  ] },
  metrics: { durationMs: 1234, stageMs: { audio: 400, subtitles: 100, frames: 700 }, toolProcesses: 5, outputBytes: 2_092_000 }, ...over,
});

export const processingExtraction = (mediaId: string, phase: MediaExtraction['phase']): MediaExtraction =>
  ({ ...createExtraction(mediaId, '2026-01-01T00:00:00.000Z'), status: 'processing', phase });
